import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { SalesService } from "../../sales/leads/sales.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import { taskDate } from "../../sales/tasks/tasks.service.js";
import type {
  DocumentUpload,
  DocumentQuery,
  DocumentArchive,
} from "./documents.dto.js";
export interface UploadFile {
  originalname: string;
  buffer: Buffer;
  size: number;
  mimetype: string;
}
const META = `SELECT d.id,d.company_id,d.kind,d.title,d.file_name,d.mime_type,d.sha256,d.size_bytes,d.lead_id,d.contract_id,d.uploaded_by,d.expires_date::text AS expires_date,d.archived_at,d.version,d.seed_key,d.created_at,l.name AS lead_name,c.public_id AS contract_ref,u.name AS uploader,(now() AT TIME ZONE 'Africa/Cairo')::date::text AS today FROM tenant.documents d LEFT JOIN tenant.leads l ON l.company_id=d.company_id AND l.id=d.lead_id LEFT JOIN tenant.contracts c ON c.company_id=d.company_id AND c.id=d.contract_id LEFT JOIN tenant.users u ON u.company_id=d.company_id AND u.id=d.uploaded_by`;
export function documentDto(d: any) {
  return {
    id: d.id,
    kind: d.kind,
    title: d.title,
    file: d.file_name,
    mimeType: d.mime_type,
    sha256: d.sha256,
    sizeBytes: d.size_bytes,
    leadId: d.lead_id,
    lead: d.lead_name,
    contractId: d.contract_id,
    contractReference: d.contract_ref,
    uploadedBy: d.uploaded_by ? { id: d.uploaded_by, name: d.uploader } : null,
    at: new Date(d.created_at).toISOString(),
    expires: d.expires_date,
    expired: !!d.expires_date && d.expires_date < d.today,
    expiringSoon:
      !!d.expires_date &&
      d.expires_date >= d.today &&
      Date.parse(d.expires_date) - Date.parse(d.today) <= 30 * 86400000,
    archivedAt: d.archived_at ? new Date(d.archived_at).toISOString() : null,
    version: d.version,
    sample: !!d.seed_key,
  };
}
export function inspectFile(file: UploadFile | undefined) {
  if (!file?.buffer?.length || file.buffer.length > 5242880)
    throw new BadRequestException("Choose a non-empty file up to 5 MB");
  const b = file.buffer;
  let mime = "";
  if (b.subarray(0, 5).toString() === "%PDF-") mime = "application/pdf";
  else if (
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    mime = "image/png";
  else if (b[0] === 255 && b[1] === 216 && b[2] === 255) mime = "image/jpeg";
  else if (
    /\.txt$/i.test(file.originalname) &&
    file.mimetype === "text/plain"
  ) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(b);
      if (b.includes(0)) throw Error();
      mime = "text/plain";
    } catch {
      throw new BadRequestException("Choose a valid UTF-8 text file");
    }
  }
  if (!mime)
    throw new BadRequestException(
      "Supported files: PDF, PNG, JPEG or UTF-8 text",
    );
  const extensions: Record<string, RegExp> = {
    "application/pdf": /\.pdf$/i,
    "image/png": /\.png$/i,
    "image/jpeg": /\.jpe?g$/i,
    "text/plain": /\.txt$/i,
  };
  if (!extensions[mime]!.test(file.originalname))
    throw new BadRequestException(
      "The file extension must match its PDF, PNG, JPEG or text content",
    );
  const name = file.originalname
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!name || name.length > 200)
    throw new BadRequestException("Choose a file name up to 200 characters");
  return {
    mime,
    name,
    size: b.length,
    sha256: createHash("sha256").update(b).digest("hex"),
  };
}
@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async list(p: Principal, q: DocumentQuery) {
    await this.sales.access(p, "documents.read");
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const args: any[] = [p.companyId],
          w = ["d.company_id=$1"];
        if (q.archived !== "all")
          w.push(
            q.archived === "archived"
              ? "d.archived_at IS NOT NULL"
              : "d.archived_at IS NULL",
          );
        for (const [key, col] of [
          ["kind", "d.kind"],
          ["leadId", "d.lead_id"],
          ["contractId", "d.contract_id"],
        ] as const)
          if (q[key]) {
            args.push(q[key]);
            w.push(col + "=$" + args.length);
          }
        if (q.q) {
          args.push("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
          w.push(
            `(d.title ILIKE $${args.length} OR d.file_name ILIKE $${args.length})`,
          );
        }
        const where = " WHERE " + w.join(" AND ");
        const total = (
          await c.query(
            "SELECT count(*)::int AS n FROM tenant.documents d" + where,
            args,
          )
        ).rows[0].n;
        const items = (
          await c.query(
            META +
              where +
              " ORDER BY d.created_at DESC,d.id LIMIT $" +
              (args.length + 1) +
              " OFFSET $" +
              (args.length + 2),
            [...args, q.limit, (q.page - 1) * q.limit],
          )
        ).rows;
        const bytes = (
          await c.query(
            "SELECT coalesce(sum(size_bytes),0)::text AS n FROM tenant.documents WHERE company_id=$1",
            [p.companyId],
          )
        ).rows[0].n;
        return {
          items: items.map(documentDto),
          total,
          page: q.page,
          limit: q.limit,
          storageBytes: bytes,
        };
      },
      true,
    );
  }
  async row(c: PoolClient, p: Principal, id: string) {
    const d = (
      await c.query(META + " WHERE d.company_id=$1 AND d.id=$2", [
        p.companyId,
        id,
      ])
    ).rows[0];
    if (!d) throw new NotFoundException("Document not found");
    return d;
  }
  async detail(p: Principal, id: string) {
    await this.sales.access(p, "documents.read");
    return this.db.tenant(p.companyId!, async (c) =>
      documentDto(await this.row(c, p, id)),
    );
  }
  async upload(p: Principal, b: DocumentUpload, file: UploadFile | undefined) {
    await this.sales.access(p, "documents.manage");
    const f = inspectFile(file);
    if (b.expiresDate) taskDate(b.expiresDate);
    const fingerprint = {
      ...b,
      fileName: f.name,
      mime: f.mime,
      sha256: f.sha256,
      size: f.size,
    };
    return this.sales.write(
      p,
      "documents.manage",
      "document.upload",
      fingerprint,
      async (c) => {
        let leadId = b.leadId ?? null;
        if (b.contractId) {
          if (!p.permissions.includes("contracts.read"))
            throw new ForbiddenException();
          const contract = (
            await c.query(
              "SELECT lead_id,status FROM tenant.contracts WHERE company_id=$1 AND id=$2",
              [p.companyId, b.contractId],
            )
          ).rows[0];
          if (!contract || contract.status === "void")
            throw new BadRequestException("Choose an active company contract");
          if (leadId && leadId !== contract.lead_id)
            throw new BadRequestException(
              "Document lead must match its contract",
            );
          leadId = contract.lead_id;
        }
        if (leadId) {
          if (!p.permissions.includes("leads.read"))
            throw new ForbiddenException();
          if (
            !(
              await c.query(
                "SELECT 1 FROM tenant.leads WHERE company_id=$1 AND id=$2" +
                  (b.contractId ? "" : " AND archived_at IS NULL"),
                [p.companyId, leadId],
              )
            ).rowCount
          )
            throw new BadRequestException("Choose an active company lead");
        }
        const policy = (
          await c.query(
            "SELECT * FROM platform.inventory_policy WHERE company_id=$1",
            [p.companyId],
          )
        ).rows[0];
        if (!policy?.subscription_id) throw new ForbiddenException();
        const used = BigInt(
          (
            await c.query(
              "SELECT coalesce(sum(size_bytes),0)::text AS n FROM tenant.documents WHERE company_id=$1",
              [p.companyId],
            )
          ).rows[0].n,
        );
        if (
          policy.storage_limit !== null &&
          used + BigInt(f.size) > BigInt(policy.storage_limit) * 1073741824n
        )
          throw new ConflictException("Company storage limit reached");
        const row = (
          await c.query(
            "INSERT INTO tenant.documents(company_id,kind,title,file_name,mime_type,content,sha256,size_bytes,lead_id,contract_id,uploaded_by,expires_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id",
            [
              p.companyId,
              b.kind,
              b.title,
              f.name,
              f.mime,
              file!.buffer,
              f.sha256,
              f.size,
              leadId,
              b.contractId ?? null,
              p.id,
              b.expiresDate ?? null,
            ],
          )
        ).rows[0];
        const d = documentDto(await this.row(c, p, row.id));
        await recordTenantEvent(c, {
          companyId: p.companyId!,
          actorId: p.id,
          action: "document.uploaded",
          resourceType: "document",
          resourceId: d.id,
          after: {
            kind: d.kind,
            sizeBytes: d.sizeBytes,
            leadId: d.leadId,
            contractId: d.contractId,
          },
          payload: { id: d.id, kind: d.kind, sizeBytes: d.sizeBytes },
        });
        return d;
      },
    );
  }
  async download(p: Principal, id: string) {
    await this.sales.access(p, "documents.read");
    return this.db.tenant(p.companyId!, async (c) => {
      const d = await this.row(c, p, id);
      const file = (
        await c.query(
          "SELECT content FROM tenant.documents WHERE company_id=$1 AND id=$2",
          [p.companyId, id],
        )
      ).rows[0];
      return {
        name: d.file_name,
        mime: d.mime_type,
        content: Buffer.from(file.content),
      };
    });
  }
  async archive(p: Principal, id: string, b: DocumentArchive) {
    return this.sales.write(
      p,
      "documents.manage",
      "document.archive:" + id,
      b,
      async (c) => {
        const old = await this.row(c, p, id);
        if (old.version !== b.version)
          throw new ConflictException("Document changed. Refresh first");
        const archive = b.action === "archive";
        if (archive === !!old.archived_at)
          throw new ConflictException("Document already has this state");
        if (
          archive &&
          (
            await c.query(
              "SELECT 1 FROM tenant.contracts c WHERE c.company_id=$1 AND c.status='signed' AND (c.signed_document_id=$2 OR EXISTS(SELECT 1 FROM tenant.contract_requirements r WHERE r.company_id=c.company_id AND r.contract_id=c.id AND r.document_id=$2 AND r.required)) LIMIT 1",
              [p.companyId, id],
            )
          ).rowCount
        )
          throw new ConflictException(
            "Evidence for a signed contract must be retained",
          );
        await c.query(
          "UPDATE tenant.documents SET archived_at=CASE WHEN $3 THEN now() ELSE NULL END,version=version+1 WHERE company_id=$1 AND id=$2",
          [p.companyId, id, archive],
        );
        const d = documentDto(await this.row(c, p, id));
        await recordTenantEvent(c, {
          companyId: p.companyId!,
          actorId: p.id,
          action: archive ? "document.archived" : "document.restored",
          resourceType: "document",
          resourceId: id,
          after: { archivedAt: d.archivedAt },
          payload: { id },
        });
        return d;
      },
    );
  }
}
