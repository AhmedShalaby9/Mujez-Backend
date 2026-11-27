import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { Principal } from "../../../common/auth/access.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import { SalesService } from "../leads/sales.service.js";
import {
  parseColdFile,
  inspectColdFile,
  type ColdFile,
} from "./cold-calls-file.js";
import type {
  ColdQuery,
  ColdImport,
  ColdPreview,
  ColdConvert,
  ColdCallLog,
  ColdNote,
  ColdFollowUp,
  ColdAssignment,
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
  isTeamLead(p: Principal) {
    return (
      p.pool === "company_user" &&
      (p.roles ?? [p.role]).includes("team_lead") &&
      p.permissions.includes("team.self.read")
    );
  }
  async managedTeam(c: PoolClient, p: Principal) {
    if (!this.isTeamLead(p)) return null;
    return (
      (
        await c.query(
          `SELECT t.id,t.name FROM tenant.teams t JOIN tenant.users u ON u.company_id=t.company_id AND u.id=t.lead_user_id JOIN platform.team_employee_status a ON a.company_id=u.company_id AND a.user_id=u.id WHERE t.company_id=$1 AND t.lead_user_id=$2 AND u.team_id=t.id AND u.status='active' AND u.deleted_at IS NULL AND a.status='active' FOR SHARE OF t,u`,
          [p.companyId, p.id],
        )
      ).rows[0] ?? null
    );
  }
  async scope(c: PoolClient, p: Principal, view?: string) {
    const team = await this.managedTeam(c, p);
    if (p.scope === "company" && view !== "mine")
      return { sql: "TRUE", args: [p.companyId] as any[], team };
    if (team && view !== "mine")
      return {
        sql: "(cc.owner_user_id=$2 OR EXISTS(SELECT 1 FROM tenant.users member WHERE member.company_id=cc.company_id AND member.id=cc.owner_user_id AND member.team_id=$3 AND member.deleted_at IS NULL))",
        args: [p.companyId, p.id, team.id],
        team,
      };
    return { sql: "cc.owner_user_id=$2", args: [p.companyId, p.id], team };
  }
  async row(c: PoolClient, p: Principal, id: string, lock = false) {
    const s = await this.scope(c, p);
    const r = (
      await c.query(
        `SELECT cc.* FROM tenant.cold_calls cc WHERE cc.company_id=$1 AND ${s.sql} AND cc.id=$${s.args.length + 1}${lock ? " FOR UPDATE OF cc" : ""}`,
        [...s.args, id],
      )
    ).rows[0];
    if (!r) throw new NotFoundException("Cold call not found");
    return r;
  }
  async allowedOwners(c: PoolClient, p: Principal) {
    const team = await this.managedTeam(c, p);
    const args: any[] = [p.companyId];
    let where = "";
    if (p.scope !== "company") {
      args.push(p.id);
      where = " AND u.id=$2";
      if (team) {
        args.push(team.id);
        where = ` AND (u.id=$2 OR (u.team_id=$3 AND EXISTS(SELECT 1 FROM tenant.roles r WHERE r.company_id=u.company_id AND r.key='agent' AND (r.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles ar WHERE ar.company_id=u.company_id AND ar.user_id=u.id AND ar.role_id=r.id)))))`;
      }
    }
    return (
      await c.query(
        `SELECT u.id,u.name FROM tenant.users u LEFT JOIN platform.team_employee_status a ON a.company_id=u.company_id AND a.user_id=u.id WHERE u.company_id=$1 AND u.status='active' AND u.deleted_at IS NULL AND (u.identity_pool='company_admin' OR a.status='active') AND EXISTS(SELECT 1 FROM tenant.roles r WHERE r.company_id=u.company_id AND 'leads.read'=ANY(r.permissions) AND (r.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles ar WHERE ar.company_id=u.company_id AND ar.user_id=u.id AND ar.role_id=r.id))) ${where} ORDER BY u.name,u.id LIMIT 1000`,
        args,
      )
    ).rows;
  }
  async owner(c: PoolClient, p: Principal, id: string) {
    await c.query(
      "SELECT id FROM tenant.users WHERE company_id=$1 AND id=$2 FOR SHARE",
      [p.companyId, id],
    );
    const owners = await this.allowedOwners(c, p);
    if (!owners.some((x) => x.id === id))
      throw new ForbiddenException(
        "Choose an active salesperson in your permitted team",
      );
    return id;
  }
  async options(p: Principal) {
    await this.sales.access(p, "leads.read");
    return this.db.tenant(p.companyId!, async (c) => {
      const team = await this.managedTeam(c, p);
      return {
        owners: p.permissions.includes("leads.manage")
          ? await this.allowedOwners(c, p)
          : [],
        canAssign:
          p.permissions.includes("leads.manage") &&
          (p.scope === "company" || !!team),
        scope: p.scope === "company" ? "company" : team ? "team" : "own",
        team: team?.name ?? null,
        timeZone: "Africa/Cairo",
      };
    });
  }
  async activity(
    c: PoolClient,
    p: Principal,
    id: string,
    kind: string,
    notes = "",
    outcome: string | null = null,
    followUpAt: Date | null = null,
    details: any = {},
  ) {
    await c.query(
      "INSERT INTO tenant.cold_call_activities(company_id,cold_call_id,actor_id,kind,notes,outcome,follow_up_at,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [p.companyId, id, p.id, kind, notes, outcome, followUpAt, details],
    );
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: "cold_call." + kind,
      resourceType: "cold_call",
      resourceId: id,
      after: { outcome, followUpAt, ...details },
      payload: { coldCallId: id, kind },
    });
  }
  async detail(p: Principal, id: string, page = 1) {
    await this.sales.access(p, "leads.read");
    return this.db.tenant(p.companyId!, async (c) => {
      const r = await this.row(c, p, id);
      const history = (
        await c.query(
          `SELECT a.id,a.kind,a.outcome,a.notes,a.follow_up_at AS "followUpAt",a.details,a.created_at AS "createdAt",u.name AS actor FROM tenant.cold_call_activities a JOIN tenant.users u ON u.company_id=a.company_id AND u.id=a.actor_id WHERE a.company_id=$1 AND a.cold_call_id=$2 ORDER BY a.created_at DESC,a.id DESC LIMIT 25 OFFSET $3`,
          [p.companyId, id, (page - 1) * 25],
        )
      ).rows;
      const total = (
        await c.query(
          "SELECT count(*)::int n FROM tenant.cold_call_activities WHERE company_id=$1 AND cold_call_id=$2",
          [p.companyId, id],
        )
      ).rows[0].n;
      return {
        item: {
          id: r.id,
          name: r.name,
          phone: r.phone,
          ownerId: r.owner_user_id,
          leadId: r.lead_id,
          version: r.version,
          outcome: r.outcome,
          followUpAt: r.follow_up_at,
          lastCalledAt: r.last_called_at,
        },
        history,
        total,
        page,
      };
    });
  }
  check(r: any, version: number, allowConverted = false) {
    if (r.version !== version)
      throw new ConflictException("Record changed; refresh first");
    if (r.lead_id && !allowConverted)
      throw new ConflictException(
        "This contact was converted. Continue its sales activity in Leads.",
      );
  }
  async followDate(c: PoolClient, value?: string | null) {
    if (!value) return null;
    const date = value.slice(0, 10);
    if (
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      Number(value.slice(11, 13)) > 23 ||
      Number(value.slice(14, 16)) > 59
    )
      throw new BadRequestException("Invalid Cairo callback date");
    const r = (
      await c.query(
        `SELECT ($1::text::timestamp AT TIME ZONE 'Africa/Cairo') AS due,to_char(($1::text::timestamp AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo','YYYY-MM-DD"T"HH24:MI')=$1::text AS exact,($1::text::timestamp AT TIME ZONE 'Africa/Cairo')>now() AS future,($1::text::timestamp AT TIME ZONE 'Africa/Cairo')<=now()+interval '2 years' AS bounded`,
        [value],
      )
    ).rows[0];
    if (!r.exact || !r.future || !r.bounded)
      throw new BadRequestException(
        "Choose a future callback within two years, in Cairo time",
      );
    return r.due;
  }
  async logCall(p: Principal, id: string, b: ColdCallLog) {
    return this.sales.write(
      p,
      "leads.manage",
      "cold_call.call:" + id,
      b,
      async (c) => {
        const r = await this.row(c, p, id, true);
        this.check(r, b.version);
        const terminal = ["not_interested", "wrong_number"].includes(b.outcome);
        if (terminal && b.followUpAt)
          throw new BadRequestException(
            "Closed call outcomes cannot have a callback",
          );
        if (b.outcome === "callback" && !b.followUpAt)
          throw new BadRequestException("A callback date is required");
        const due = await this.followDate(c, b.followUpAt);
        await c.query(
          "UPDATE tenant.cold_calls SET outcome=$3,last_called_at=now(),follow_up_at=$4,updated_at=now(),version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, id, b.outcome, due],
        );
        await this.activity(
          c,
          p,
          id,
          "call",
          b.notes?.trim() ?? "",
          b.outcome,
          due,
        );
        return { id, version: r.version + 1 };
      },
    );
  }
  async note(p: Principal, id: string, b: ColdNote) {
    return this.sales.write(
      p,
      "leads.manage",
      "cold_call.note:" + id,
      b,
      async (c) => {
        const r = await this.row(c, p, id, true);
        this.check(r, b.version, true);
        if (!b.notes.trim()) throw new BadRequestException("Enter a note");
        await c.query(
          "UPDATE tenant.cold_calls SET version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        );
        await this.activity(c, p, id, "note", b.notes.trim());
        return { id, version: r.version + 1 };
      },
    );
  }
  async followUp(p: Principal, id: string, b: ColdFollowUp) {
    return this.sales.write(
      p,
      "leads.manage",
      "cold_call.follow_up:" + id,
      b,
      async (c) => {
        const r = await this.row(c, p, id, true);
        this.check(r, b.version);
        if (
          ["not_interested", "wrong_number"].includes(r.outcome) &&
          b.followUpAt
        )
          throw new BadRequestException(
            "Record a new open call outcome before scheduling a closed contact",
          );
        if (!Object.prototype.hasOwnProperty.call(b, "followUpAt"))
          throw new BadRequestException(
            "Provide a callback date or null to cancel it",
          );
        const due = await this.followDate(c, b.followUpAt);
        await c.query(
          "UPDATE tenant.cold_calls SET follow_up_at=$3,updated_at=now(),version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, id, due],
        );
        await this.activity(
          c,
          p,
          id,
          "follow_up",
          b.notes?.trim() ?? "",
          null,
          due,
          { previousFollowUpAt: r.follow_up_at },
        );
        return { id, version: r.version + 1 };
      },
    );
  }
  async assign(p: Principal, b: ColdAssignment) {
    return this.sales.write(
      p,
      "leads.manage",
      "cold_call.assign",
      b,
      async (c) => {
        if (p.scope !== "company" && !(await this.managedTeam(c, p)))
          throw new ForbiddenException(
            "Only company management or the current team lead can assign cold calls",
          );
        if (new Set(b.items.map((x) => x.id)).size !== b.items.length)
          throw new BadRequestException("Duplicate assignment records");
        await this.owner(c, p, b.ownerId);
        for (const item of [...b.items].sort((a, b) =>
          a.id.localeCompare(b.id),
        )) {
          const r = await this.row(c, p, item.id, true);
          this.check(r, item.version);
          if (r.owner_user_id === b.ownerId) continue;
          await c.query(
            "UPDATE tenant.cold_calls SET owner_user_id=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
            [p.companyId, item.id, b.ownerId],
          );
          const names = (
            await c.query(
              "SELECT id,name FROM tenant.users WHERE company_id=$1 AND id=ANY($2::uuid[])",
              [p.companyId, [r.owner_user_id, b.ownerId]],
            )
          ).rows;
          await this.activity(
            c,
            p,
            item.id,
            "assigned",
            "",
            null,
            r.follow_up_at,
            {
              previousOwnerId: r.owner_user_id,
              ownerId: b.ownerId,
              previousOwnerName: names.find((x) => x.id === r.owner_user_id)
                ?.name,
              ownerName: names.find((x) => x.id === b.ownerId)?.name,
            },
          );
        }
        return { assigned: b.items.length };
      },
    );
  }
  async list(p: Principal, q: ColdQuery) {
    await this.sales.access(p, "leads.read");
    return this.db.tenant(p.companyId!, async (c) => {
      const scope = await this.scope(c, p, q.view),
        args: any[] = [...scope.args],
        base = ["cc.company_id=$1", scope.sql];
      if (q.ownerId) {
        args.push(q.ownerId);
        base.push("cc.owner_user_id=$" + args.length);
      }
      const baseSql = base.join(" AND ");
      const summary = (
        await c.query(
          `SELECT count(*) FILTER(WHERE cc.lead_id IS NULL AND coalesce(cc.outcome,'') NOT IN ('not_interested','wrong_number'))::int AS open,count(*) FILTER(WHERE cc.lead_id IS NULL AND cc.follow_up_at<=now())::int AS due,count(*) FILTER(WHERE cc.lead_id IS NULL AND (cc.follow_up_at AT TIME ZONE 'Africa/Cairo')::date=(now() AT TIME ZONE 'Africa/Cairo')::date)::int AS today,count(*) FILTER(WHERE cc.lead_id IS NULL AND (cc.follow_up_at AT TIME ZONE 'Africa/Cairo')::date>(now() AT TIME ZONE 'Africa/Cairo')::date)::int AS upcoming FROM tenant.cold_calls cc WHERE ${baseSql}`,
          args,
        )
      ).rows[0];
      const where = [...base];
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
            : q.status === "closed"
              ? "cc.lead_id IS NULL AND cc.outcome IN ('not_interested','wrong_number')"
              : q.status === "open"
                ? "cc.lead_id IS NULL AND coalesce(cc.outcome,'') NOT IN ('not_interested','wrong_number')"
                : "cc.lead_id IS NULL",
        );
      if (q.outcome) {
        args.push(q.outcome);
        where.push("cc.outcome=$" + args.length);
      }
      if (q.callback && q.callback !== "all") {
        where.push("cc.lead_id IS NULL AND cc.follow_up_at IS NOT NULL");
        if (q.callback === "due") where.push("cc.follow_up_at<=now()");
        if (q.callback === "today")
          where.push(
            "(cc.follow_up_at AT TIME ZONE 'Africa/Cairo')::date=(now() AT TIME ZONE 'Africa/Cairo')::date",
          );
        if (q.callback === "upcoming")
          where.push(
            "(cc.follow_up_at AT TIME ZONE 'Africa/Cairo')::date>(now() AT TIME ZONE 'Africa/Cairo')::date",
          );
      }
      const sql = where.join(" AND "),
        total = (
          await c.query(
            "SELECT count(*)::int n FROM tenant.cold_calls cc WHERE " + sql,
            args,
          )
        ).rows[0].n;
      const items = (
        await c.query(
          `SELECT cc.id,cc.name,cc.phone,cc.owner_user_id AS "ownerId",u.name AS owner,cc.lead_id AS "leadId",cc.version,cc.created_at AS "createdAt",cc.outcome,cc.last_called_at AS "lastCalledAt",cc.follow_up_at AS "followUpAt",(cc.follow_up_at<=now() AND cc.lead_id IS NULL) AS "callbackDue",l.owner_user_id AS "leadOwnerId" FROM tenant.cold_calls cc JOIN tenant.users u ON u.company_id=cc.company_id AND u.id=cc.owner_user_id LEFT JOIN tenant.leads l ON l.company_id=cc.company_id AND l.id=cc.lead_id WHERE ${sql} ORDER BY (cc.follow_up_at IS NOT NULL AND cc.lead_id IS NULL) DESC,cc.follow_up_at ASC NULLS LAST,cc.created_at DESC,cc.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
          [...args, q.limit, (q.page - 1) * q.limit],
        )
      ).rows.map((r) => ({
        ...r,
        canConvert:
          !r.leadId &&
          !["wrong_number", "not_interested"].includes(r.outcome) &&
          (p.scope === "company" || r.ownerId === p.id),
        canOpenLead:
          !!r.leadId && (p.scope === "company" || r.leadOwnerId === p.id),
      }));
      return {
        items,
        total,
        page: q.page,
        limit: q.limit,
        summary,
        timeZone: "Africa/Cairo",
      };
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
  async columns(p: Principal, file: ColdFile | undefined) {
    await this.sales.access(p, "leads.manage");
    return inspectColdFile(file);
  }
  async preview(p: Principal, file: ColdFile | undefined, b: ColdPreview) {
    await this.sales.access(p, "leads.manage");
    const data = await parseColdFile(file, {
      nameColumn: b.nameColumn,
      phoneColumn: b.phoneColumn,
    });
    return this.db.tenant(p.companyId!, async (c) => {
      await this.owner(c, p, b.ownerId ?? p.id);
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
    const data = await parseColdFile(file, {
      nameColumn: b.nameColumn,
      phoneColumn: b.phoneColumn,
    });
    return this.sales.write(
      p,
      "leads.manage",
      "cold_calls.import",
      { ...b, fileHash: data.hash } as any,
      async (c) => {
        const owner = await this.owner(c, p, b.ownerId ?? p.id);
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
        const row = await this.row(c, p, id, true);
        if (p.scope !== "company" && row.owner_user_id !== p.id)
          throw new ForbiddenException(
            "Only the assigned salesperson can convert this contact",
          );
        if (["not_interested", "wrong_number"].includes(row.outcome))
          throw new ConflictException(
            "Record a new open call outcome before converting this contact",
          );
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
          "UPDATE tenant.cold_calls SET lead_id=$3,converted_at=now(),follow_up_at=NULL,updated_at=now(),version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, id, lead.id],
        );
        await this.activity(c, p, id, "converted", "", null, null, {
          leadId: lead.id,
        });
        return { leadId: lead.id };
      },
    );
  }
}
