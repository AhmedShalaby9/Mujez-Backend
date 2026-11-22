import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { Principal } from "../../../common/auth/access.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import { SalesService } from "../leads/sales.service.js";
import { parseColdFile, type ColdFile } from "./cold-calls-file.js";
import type {
  ColdQuery,
  ColdImport,
  ColdPreview,
  ColdConvert,
} from "./cold-calls.dto.js";
@Injectable()
export class ColdCallsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async previewAccess(p: Principal) {
    await this.sales.access(p, "leads.manage");
  }
  async list(p: Principal, q: ColdQuery) {
    await this.sales.access(p, "leads.read");
    return this.db.tenant(p.companyId!, async (c) => {
      const args: any[] = [p.companyId],
        where = ["cc.company_id=$1"];
      if (p.scope === "own") {
        args.push(p.id);
        where.push("cc.owner_user_id=$" + args.length);
      }
      if (q.q) {
        args.push("%" + q.q + "%");
        where.push(
          "(cc.name ILIKE $" +
            args.length +
            " OR cc.phone ILIKE $" +
            args.length +
            ")",
        );
      }
      if (q.status !== "all")
        where.push(
          q.status === "converted"
            ? "cc.lead_id IS NOT NULL"
            : "cc.lead_id IS NULL",
        );
      const sql = where.join(" AND ");
      const total = (
        await c.query(
          "SELECT count(*)::int n FROM tenant.cold_calls cc WHERE " + sql,
          args,
        )
      ).rows[0].n;
      const items = (
        await c.query(
          `SELECT cc.id,cc.name,cc.phone,cc.owner_user_id AS "ownerId",u.name AS owner,cc.lead_id AS "leadId",cc.version,cc.created_at AS "createdAt" FROM tenant.cold_calls cc JOIN tenant.users u ON u.company_id=cc.company_id AND u.id=cc.owner_user_id WHERE ${sql} ORDER BY cc.created_at DESC,cc.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
          [...args, q.limit, (q.page - 1) * q.limit],
        )
      ).rows;
      return { items, total, page: q.page, limit: q.limit };
    });
  }
  async existing(c: PoolClient, p: Principal, phones: string[]) {
    return new Set(
      (
        await c.query(
          "SELECT phone FROM tenant.cold_calls WHERE company_id=$1 AND phone=ANY($2::text[]) UNION SELECT phone FROM tenant.leads WHERE company_id=$1 AND phone=ANY($2::text[])",
          [p.companyId, phones],
        )
      ).rows.map((r) => r.phone),
    );
  }
  async preview(p: Principal, file: ColdFile | undefined, b: ColdPreview) {
    await this.sales.access(p, "leads.manage");
    const data = await parseColdFile(file);
    return this.db.tenant(p.companyId!, async (c) => {
      await this.sales.owner(c, p, b.ownerId ?? p.id);
      const existing = await this.existing(
          c,
          p,
          data.rows.map((x) => x.phone),
        ),
        valid = data.rows.filter((x) => !existing.has(x.phone));
      return {
        total: data.total,
        valid: valid.length,
        duplicates: data.duplicate + data.rows.length - valid.length,
        rejected: data.errors.length,
        empty: data.empty,
        errors: data.errors,
        sample: valid.slice(0, 10),
        fileHash: data.hash,
      };
    });
  }
  async import(p: Principal, file: ColdFile | undefined, b: ColdImport) {
    await this.sales.access(p, "leads.manage");
    const data = await parseColdFile(file);
    return this.sales.write(
      p,
      "leads.manage",
      "cold_calls.import",
      { ...b, fileHash: data.hash } as any,
      async (c) => {
        const owner = await this.sales.owner(c, p, b.ownerId ?? p.id);
        const existing = await this.existing(
            c,
            p,
            data.rows.map((x) => x.phone),
          ),
          valid = data.rows.filter((x) => !existing.has(x.phone));
        const count = (
          await c.query(
            "SELECT count(*)::int n FROM tenant.cold_calls WHERE company_id=$1",
            [p.companyId],
          )
        ).rows[0].n;
        if (count + valid.length > 100000)
          throw new BadRequestException(
            "Company cold-call storage limit reached (100,000 records)",
          );
        for (const r of valid)
          await c.query(
            "INSERT INTO tenant.cold_calls(company_id,name,phone,owner_user_id,created_by) VALUES($1,$2,$3,$4,$5)",
            [p.companyId, r.name, r.phone, owner, p.id],
          );
        const result = {
          imported: valid.length,
          total: data.total,
          duplicates: data.duplicate + data.rows.length - valid.length,
          rejected: data.errors.length,
          empty: data.empty,
          errors: data.errors,
        };
        await recordTenantEvent(c, {
          companyId: p.companyId!,
          actorId: p.id,
          action: "cold_calls.imported",
          resourceType: "cold_call_import",
          resourceId: b.requestId,
          after: { ...result, errors: undefined, fileHash: data.hash },
          payload: { imported: valid.length },
        });
        return result;
      },
    );
  }
  async convert(p: Principal, id: string, b: ColdConvert) {
    return this.sales.write(
      p,
      "leads.manage",
      "cold_calls.convert:" + id,
      b,
      async (c) => {
        const row = (
          await c.query(
            "SELECT * FROM tenant.cold_calls WHERE company_id=$1 AND id=$2 FOR UPDATE",
            [p.companyId, id],
          )
        ).rows[0];
        if (!row || (p.scope === "own" && row.owner_user_id !== p.id))
          throw new NotFoundException("Cold call not found");
        if (row.lead_id)
          throw new ConflictException("Already converted to a lead");
        if (row.version !== b.version)
          throw new ConflictException("Record changed; refresh first");
        const lead = await this.sales.createWithin(c, p, {
          requestId: b.requestId,
          name: row.name,
          phone: row.phone,
          segment: b.segment,
          want: b.want,
          source: "phone",
          ownerId: row.owner_user_id,
        } as any);
        await c.query(
          "UPDATE tenant.cold_calls SET lead_id=$3,converted_at=now(),version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, id, lead.id],
        );
        await recordTenantEvent(c, {
          companyId: p.companyId!,
          actorId: p.id,
          action: "cold_call.converted",
          resourceType: "cold_call",
          resourceId: id,
          after: { leadId: lead.id },
          payload: { leadId: lead.id },
        });
        return { leadId: lead.id };
      },
    );
  }
}
