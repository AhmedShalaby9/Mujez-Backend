import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import { isDeepStrictEqual } from "node:util";
import { SalesService } from "../leads/sales.service.js";
import {
  bookDeveloperClaim,
  companyFinanceEnabled,
} from "./brokerage-developer-claim.js";
import type {
  BrokerageProjectInput,
  DealDecision,
  DealDocumentInput,
  DealInput,
  DealListQuery,
  DealUpdate,
  DeveloperInput,
  DeveloperUpdate,
  DeveloperArchive,
} from "./brokerage-deals.dto.js";

const isAdmin = (p: Principal) => p.pool === "company_admin" && !p.workspace;
/** Deal approval: the owner, or a Sales Admin (company_user, no finance/HR,
 * cannot touch roles or targets, but can approve/reject deals). */
const canApprove = (p: Principal) =>
  isAdmin(p) || p.role === "sales_admin" || !!p.roles?.includes("sales_admin");
const name = (v: any) => (typeof v === "string" ? v : (v?.en ?? v?.ar ?? ""));
const validDate = (v: unknown) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v));
const requiredDetails = [
  "developerSalesperson",
  "developerSalespersonMobile",
  "area",
  "finishing",
  "deliveryYears",
  "paymentPlanYears",
  "downPaymentPercent",
  "expectedContractDate",
  "reservationPrice",
  "reservationDate",
];
export const UNIT_TYPES = [
  "Stand alone",
  "Apartment",
  "Duplex",
  "Town House",
  "Twin House",
  "iVilla",
  "office",
  "shop",
  "Administrative",
  "Medical",
  "building",
  "Pent House",
  "Chalet",
  "Land",
  "Villa",
  "Studio",
  "Cabin",
  "Multiple Family",
  "Multi & Single Family",
  "Sky Panorama",
  "Ground Floor",
  "Hotel Apartments",
  "Apartment 4BR",
  "One Story Villa",
  "I-villa Garden - 3 BRs",
  "Skyvilla - 3 BRs",
  "Millennial - 1 BR",
  "Garden Millennial - 1 BR",
  "Millennial - 2 BR",
  "Millennial - 3 BR",
  "Garden Millennial - 2 BR",
  "Garden Millennial - 3 BR",
];
export const FINISHING_TYPES = [
  "Core & Shell",
  "Semi Finished",
  "Finished",
  "Super Lux",
  "Ultra Super Lux",
];
const mimeTypes = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
];
function validateDeal(b: DealInput) {
  if (!b.clientName || b.clientName.trim().length < 2)
    throw new BadRequestException("Client name is required");
  if (b.sellingType === "resale" && b.status === "eoi")
    throw new BadRequestException("EOI is unavailable for resale");
  if (!b.details || typeof b.details !== "object" || Array.isArray(b.details))
    throw new BadRequestException("Deal details are required");
  for (const key of requiredDetails)
    if (
      b.details[key] === null ||
      b.details[key] === undefined ||
      String(b.details[key]).trim() === ""
    )
      throw new BadRequestException(`${key} is required`);
  if (
    b.sellingType === "resale" &&
    !String(b.details["sellerOwner"] ?? "").trim()
  )
    throw new BadRequestException("Seller / owner is required");
  for (const key of ["expectedContractDate", "reservationDate"])
    if (!validDate(b.details[key]))
      throw new BadRequestException(`${key} must be a date`);
  if (b.details["tenPercentDate"] && !validDate(b.details["tenPercentDate"]))
    throw new BadRequestException("10% date must be a date");
  for (const key of [
    "area",
    "deliveryYears",
    "paymentPlanYears",
    "reservationPrice",
  ]) {
    const value = Number(b.details[key]);
    if (!Number.isFinite(value) || value <= 0)
      throw new BadRequestException(`${key} must be positive`);
  }
  const dp = Number(b.details["downPaymentPercent"]);
  if (!Number.isFinite(dp) || dp < 0 || dp > 100)
    throw new BadRequestException("Down payment must be 0–100%");
  if (String(b.details["developerSalespersonMobile"]).length > 30)
    throw new BadRequestException("Salesperson mobile is too long");
  if (!FINISHING_TYPES.includes(String(b.details["finishing"])))
    throw new BadRequestException("finishing is not a recognized option");
  if (
    b.details["unitType"] !== undefined &&
    b.details["unitType"] !== null &&
    String(b.details["unitType"]).trim() !== "" &&
    !UNIT_TYPES.includes(String(b.details["unitType"]))
  )
    throw new BadRequestException("unitType is not a recognized unit type");
  if (JSON.stringify(b.details).length > 16000)
    throw new BadRequestException("Deal details are too large");
}
function fileData(d: DealDocumentInput) {
  if (
    !["eoi", "reservation", "contract", "id_copy", "other"].includes(d.kind) ||
    !mimeTypes.includes(d.mimeType) ||
    !d.fileName ||
    d.fileName.length > 180 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(d.data)
  )
    throw new BadRequestException("Invalid deal document");
  const content = Buffer.from(d.data, "base64");
  if (content.length < 1 || content.length > 5242880)
    throw new BadRequestException("Document must be 1 byte to 5 MB");
  const signatures: Record<string, boolean> = {
    "application/pdf":
      content.subarray(0, 5).toString() === "%PDF-" &&
      /\.pdf$/i.test(d.fileName),
    "image/png":
      content
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      /\.png$/i.test(d.fileName),
    "image/jpeg":
      content[0] === 255 &&
      content[1] === 216 &&
      content[2] === 255 &&
      /\.jpe?g$/i.test(d.fileName),
    "application/msword":
      content
        .subarray(0, 8)
        .equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225])) &&
      /\.doc$/i.test(d.fileName),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      content.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) &&
      /\.docx$/i.test(d.fileName),
  };
  if (!signatures[d.mimeType])
    throw new BadRequestException("File content does not match its type");
  return content;
}
function dto(r: any) {
  return {
    id: r.id,
    leadId: r.lead_id,
    lead: name(r.lead_name),
    agentId: r.agent_id,
    agent: r.agent_name,
    clientName: r.client_name,
    clientPhone: r.client_phone,
    sellingType: r.selling_type,
    status: r.status,
    approvalStatus: r.approval_status,
    rejectionReason: r.rejection_reason,
    developerId: r.developer_id,
    developer: r.developer_name,
    projectId: r.project_id,
    project: name(r.project_name),
    unitValueMinor: String(r.unit_value_minor),
    developerClaimObligationId: r.developer_claim_obligation_id,
    details: r.details,
    version: r.version,
    approvedVersion: r.approved_version,
    createdBy: r.created_by,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
const SELECT = `SELECT d.*,d.unit_value_minor::text AS unit_value_minor,l.name AS lead_name,l.owner_user_id AS lead_owner_id,a.name AS agent_name,a.team_id AS agent_team_id,dev.name AS developer_name,pj.name AS project_name FROM tenant.brokerage_deals d JOIN tenant.leads l ON l.company_id=d.company_id AND l.id=d.lead_id JOIN tenant.users a ON a.company_id=d.company_id AND a.id=d.agent_id JOIN tenant.brokerage_developers dev ON dev.company_id=d.company_id AND dev.id=d.developer_id JOIN tenant.projects pj ON pj.company_id=d.company_id AND pj.id=d.project_id`;

@Injectable()
export class BrokerageDealsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  private async access(p: Principal, write = false) {
    if ((p.company?.type ?? p.workspace?.company.type) !== "brokerage")
      throw new ForbiddenException("Brokerage only");
    await this.sales.access(p, write ? "leads.manage" : "leads.read");
  }
  private owner(p: Principal) {
    if (!isAdmin(p) || p.role !== "company_owner")
      throw new ForbiddenException("Company owner only");
  }
  private async row(c: PoolClient, p: Principal, id: string, lock = false) {
    const rows = (
      await c.query(
        SELECT +
          ` WHERE d.company_id=$1 AND d.id=$2${lock ? " FOR UPDATE OF d" : ""}`,
        [p.companyId, id],
      )
    ).rows;
    const r = rows[0];
    if (
      !r ||
      (p.scope === "own" && r.agent_id !== p.id) ||
      (p.scope === "team" &&
        r.agent_id !== p.id &&
        (!p.teamId || r.agent_team_id !== p.teamId))
    )
      throw new NotFoundException("Deal not found");
    return r;
  }
  private async validateLinks(c: PoolClient, p: Principal, b: DealInput) {
    const lead = (
      await c.query(
        "SELECT owner_user_id,archived_at FROM tenant.leads WHERE company_id=$1 AND id=$2",
        [p.companyId, b.leadId],
      )
    ).rows[0];
    if (!lead || lead.archived_at)
      throw new BadRequestException("Choose an active lead");
    const agentId = p.scope === "own" ? p.id : b.agentId;
    if (p.scope === "own" && b.agentId && b.agentId !== p.id)
      throw new ForbiddenException();
    if (!agentId) throw new BadRequestException("Choose an agent");
    const agent = (
      await c.query(
        "SELECT u.team_id FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.id=$2 AND u.status='active' AND u.deleted_at IS NULL AND 'leads.read'=ANY(r.permissions)",
        [p.companyId, agentId],
      )
    ).rows[0];
    if (!agent) throw new BadRequestException("Choose an active company agent");
    if (p.scope === "own" && lead.owner_user_id !== p.id)
      throw new ForbiddenException("Choose your own lead");
    if (
      p.scope === "team" &&
      agentId !== p.id &&
      (!p.teamId || agent.team_id !== p.teamId)
    )
      throw new ForbiddenException("Choose an agent from your team");
    if (p.scope === "team" && lead.owner_user_id !== agentId)
      throw new ForbiddenException("Agent must own this lead");
    const project = (
      await c.query(
        "SELECT brokerage_developer_id FROM tenant.projects WHERE company_id=$1 AND id=$2 AND archived_at IS NULL",
        [p.companyId, b.projectId],
      )
    ).rows[0];
    if (!project || project.brokerage_developer_id !== b.developerId)
      throw new BadRequestException(
        "Project must belong to the selected developer",
      );
    return agentId;
  }
  private async insertDocs(
    c: PoolClient,
    p: Principal,
    id: string,
    docs: DealDocumentInput[],
  ) {
    if (docs.length > 10)
      throw new BadRequestException("Up to 10 documents per submission");
    const files = docs.map((d) => ({ d, content: fileData(d) }));
    const added = files.reduce((n, f) => n + f.content.length, 0);
    if (added > 10485760)
      throw new BadRequestException(
        "Documents exceed the 10 MB submission limit",
      );
    const policy = (
      await c.query(
        "SELECT storage_limit FROM platform.inventory_policy WHERE company_id=$1",
        [p.companyId],
      )
    ).rows[0];
    if (policy?.storage_limit !== null && policy?.storage_limit !== undefined) {
      const used = (
        await c.query(
          `SELECT (coalesce((SELECT sum(size_bytes) FROM tenant.documents WHERE company_id=$1),0)+coalesce((SELECT sum(size_bytes) FROM tenant.hr_documents WHERE company_id=$1),0)+coalesce((SELECT sum(size_bytes) FROM tenant.leave_attachments WHERE company_id=$1),0)+coalesce((SELECT sum(octet_length(content)) FROM tenant.brokerage_deal_documents WHERE company_id=$1),0))::text AS n`,
          [p.companyId],
        )
      ).rows[0].n;
      if (
        BigInt(used) + BigInt(added) >
        BigInt(policy.storage_limit) * 1073741824n
      )
        throw new ConflictException("Company storage limit reached");
    }
    for (const { d, content } of files)
      await c.query(
        "INSERT INTO tenant.brokerage_deal_documents(company_id,deal_id,kind,file_name,mime_type,content,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [p.companyId, id, d.kind, d.fileName, d.mimeType, content, p.id],
      );
  }
  private async event(c: PoolClient, p: Principal, r: any, action: string) {
    await c.query(
      "INSERT INTO tenant.brokerage_deal_events(company_id,deal_id,actor_id,action,version,snapshot) VALUES($1,$2,$3,$4,$5,$6)",
      [p.companyId, r.id, p.id, action, r.version, JSON.stringify(dto(r))],
    );
    await recordTenantEvent(c, {
      companyId: p.companyId!,
      actorId: p.id,
      action: `brokerage.deal.${action}`,
      resourceType: "brokerage_deal",
      resourceId: r.id,
      after: {
        status: r.status,
        approvalStatus: r.approval_status,
        version: r.version,
      },
      payload: {
        status: r.status,
        approvalStatus: r.approval_status,
        version: r.version,
      },
    });
  }
  private async syncLead(
    c: PoolClient,
    p: Principal,
    r: any,
    financeEnabled: boolean,
  ) {
    if (r.approval_status === "approved" && r.status === "contracted") {
      const changed = await c.query(
        "UPDATE tenant.leads SET brokerage_status='closed_deal',stage='won',stage_changed_at=now(),version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 AND (brokerage_status IS DISTINCT FROM 'closed_deal' OR stage IS DISTINCT FROM 'won')",
        [p.companyId, r.lead_id],
      );
      if (changed.rowCount) {
        await c.query(
          "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,$3,$4,$5)",
          [
            p.companyId,
            r.lead_id,
            p.id,
            "lead.status_changed",
            JSON.stringify({
              to: "closed_deal",
              dealId: r.id,
              reason: "Approved contracted deal",
            }),
          ],
        );
        await recordTenantEvent(c, {
          companyId: p.companyId!,
          actorId: p.id,
          action: "lead.closed_by_deal",
          resourceType: "lead",
          resourceId: r.lead_id,
          after: { brokerageStatus: "closed_deal", stage: "won" },
          payload: { dealId: r.id },
        });
      }
      await bookDeveloperClaim(
        this.db,
        c,
        p,
        {
          id: r.id,
          developerId: r.developer_id,
          unitValueMinor: r.unit_value_minor,
          developerClaimObligationId: r.developer_claim_obligation_id,
        },
        financeEnabled,
      );
    }
  }
  async options(p: Principal) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => ({
      leads: (
        await c.query(
          `SELECT id,name,phone,owner_user_id AS "ownerId" FROM tenant.leads WHERE company_id=$1 AND archived_at IS NULL ${p.scope === "own" ? "AND owner_user_id=$2" : p.scope === "team" ? "AND (owner_user_id=$2 OR owner_user_id IN (SELECT id FROM tenant.users WHERE company_id=$1 AND team_id=$3))" : ""} ORDER BY created_at DESC LIMIT 50`,
          p.scope === "own"
            ? [p.companyId, p.id]
            : p.scope === "team"
              ? [p.companyId, p.id, p.teamId ?? null]
              : [p.companyId],
        )
      ).rows.map((x) => ({ ...x, name: name(x.name) })),
      agents: (
        await c.query(
          `SELECT u.id,u.name FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.status='active' AND u.deleted_at IS NULL AND 'leads.read'=ANY(r.permissions) ${p.scope === "team" ? "AND (u.id=$2 OR u.team_id=$3)" : ""} ORDER BY u.name`,
          p.scope === "team"
            ? [p.companyId, p.id, p.teamId ?? null]
            : [p.companyId],
        )
      ).rows,
      developers: (
        await c.query(
          "SELECT id,name,version FROM tenant.brokerage_developers WHERE company_id=$1 AND archived_at IS NULL ORDER BY name",
          [p.companyId],
        )
      ).rows,
      projects: (
        await c.query(
          "SELECT id,code,name,brokerage_developer_id AS \"developerId\" FROM tenant.projects WHERE company_id=$1 AND archived_at IS NULL AND brokerage_developer_id IS NOT NULL ORDER BY name->>'en'",
          [p.companyId],
        )
      ).rows.map((x) => ({ ...x, name: name(x.name) })),
      unitTypes: UNIT_TYPES,
      finishingTypes: FINISHING_TYPES,
      canApprove: canApprove(p),
      canManageInventory: isAdmin(p) && p.role === "company_owner",
    }));
  }
  async leads(p: Principal, search?: string) {
    await this.access(p);
    if (search && search.length > 100)
      throw new BadRequestException("Search is too long");
    return this.db.tenant(p.companyId!, async (c) => {
      const args: any[] = [p.companyId];
      const where = ["l.company_id=$1", "l.archived_at IS NULL"];
      if (p.scope === "own") {
        args.push(p.id);
        where.push(`l.owner_user_id=$${args.length}`);
      }
      if (p.scope === "team") {
        args.push(p.id, p.teamId ?? null);
        where.push(
          `(l.owner_user_id=$${args.length - 1} OR l.owner_user_id IN (SELECT id FROM tenant.users WHERE company_id=$1 AND team_id=$${args.length}))`,
        );
      }
      if (search?.trim()) {
        args.push(`%${search.trim().replace(/[%_]/g, "\\$&")}%`);
        where.push(
          `(l.name->>'en' ILIKE $${args.length} OR l.name->>'ar' ILIKE $${args.length} OR l.phone ILIKE $${args.length} OR l.public_id ILIKE $${args.length})`,
        );
      }
      return (
        await c.query(
          `SELECT l.id,l.name,l.phone,l.owner_user_id AS "ownerId" FROM tenant.leads l WHERE ${where.join(" AND ")} ORDER BY l.created_at DESC,l.id LIMIT 50`,
          args,
        )
      ).rows.map((x) => ({ ...x, name: name(x.name) }));
    });
  }
  async list(p: Principal, q: DealListQuery) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const args: any[] = [p.companyId];
      const where = ["d.company_id=$1"];
      if (p.scope === "own") {
        args.push(p.id);
        where.push(`d.agent_id=$${args.length}`);
      }
      if (p.scope === "team") {
        args.push(p.id, p.teamId ?? null);
        where.push(
          `(d.agent_id=$${args.length - 1} OR d.agent_id IN (SELECT id FROM tenant.users WHERE company_id=$1 AND team_id=$${args.length}))`,
        );
      }
      const scopeArgs = [...args],
        scopeWhere = where.join(" AND ");
      if (q.status) {
        args.push(q.status);
        where.push(`d.status=$${args.length}`);
      }
      if (q.approval) {
        args.push(q.approval);
        where.push(`d.approval_status=$${args.length}`);
      }
      if (q.search) {
        args.push(`%${q.search.replace(/[%_]/g, "\\$&")}%`);
        where.push(
          `(d.client_name ILIKE $${args.length} OR pj.name->>'en' ILIKE $${args.length})`,
        );
      }
      const condition = where.join(" AND ");
      const count = (
        await c.query(
          `SELECT count(*)::int AS n FROM tenant.brokerage_deals d JOIN tenant.projects pj ON pj.company_id=d.company_id AND pj.id=d.project_id WHERE ${condition}`,
          args,
        )
      ).rows[0].n;
      const rows = (
        await c.query(
          `${SELECT} WHERE ${condition} ORDER BY d.created_at DESC,d.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
          [...args, q.limit, (q.page - 1) * q.limit],
        )
      ).rows;
      const counts = (
        await c.query(
          `SELECT status,count(*)::int AS n FROM tenant.brokerage_deals d WHERE ${scopeWhere} GROUP BY status`,
          scopeArgs,
        )
      ).rows;
      const summary = Object.fromEntries(counts.map((x) => [x.status, x.n]));
      return { items: rows.map(dto), total: count, summary };
    });
  }
  async detail(p: Principal, id: string) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const r = await this.row(c, p, id);
      const docs = (
        await c.query(
          'SELECT id,kind,file_name AS "fileName",mime_type AS "mimeType",created_at AS "createdAt" FROM tenant.brokerage_deal_documents WHERE company_id=$1 AND deal_id=$2 ORDER BY created_at,id',
          [p.companyId, id],
        )
      ).rows;
      const events = (
        await c.query(
          'SELECT action,version,actor_id AS "actorId",created_at AS "createdAt" FROM tenant.brokerage_deal_events WHERE company_id=$1 AND deal_id=$2 ORDER BY created_at DESC,id DESC',
          [p.companyId, id],
        )
      ).rows;
      return { ...dto(r), documents: docs, events };
    });
  }
  async document(p: Principal, id: string, documentId: string) {
    await this.access(p);
    return this.db.tenant(p.companyId!, async (c) => {
      await this.row(c, p, id);
      const d = (
        await c.query(
          "SELECT file_name,mime_type,content FROM tenant.brokerage_deal_documents WHERE company_id=$1 AND deal_id=$2 AND id=$3",
          [p.companyId, id, documentId],
        )
      ).rows[0];
      if (!d) throw new NotFoundException();
      return d;
    });
  }
  async create(p: Principal, b: DealInput) {
    await this.access(p, true);
    validateDeal(b);
    if (b.status === "cancelled")
      throw new BadRequestException("A new deal cannot be cancelled");
    if (!Array.isArray(b.documents) || b.documents.length < 1)
      throw new BadRequestException("At least one document is required");
    const financeEnabled = await companyFinanceEnabled(this.db, p.companyId!);
    return this.db.tenant(p.companyId!, async (c) => {
      const agentId = await this.validateLinks(c, p, b);
      // Admin approval only gates the move into a signed contract; EOI,
      // reservation and cancellation save straight through.
      const approved = b.status === "contracted" ? canApprove(p) : true;
      const id = (
        await c.query(
          "INSERT INTO tenant.brokerage_deals(company_id,lead_id,agent_id,client_name,client_phone,selling_type,status,approval_status,developer_id,project_id,unit_value_minor,details,created_by,approved_by,approved_at,approved_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id",
          [
            p.companyId,
            b.leadId,
            agentId,
            b.clientName.trim(),
            b.clientPhone,
            b.sellingType,
            b.status,
            approved ? "approved" : "pending",
            b.developerId,
            b.projectId,
            b.unitValueMinor,
            JSON.stringify(b.details),
            p.id,
            approved ? p.id : null,
            approved ? new Date() : null,
            approved ? 0 : null,
          ],
        )
      ).rows[0].id;
      await this.insertDocs(c, p, id, b.documents);
      let r = await this.row(c, p, id);
      await this.event(c, p, r, "created");
      if (approved) {
        await this.syncLead(c, p, r, financeEnabled);
        r = await this.row(c, p, id);
      }
      return dto(r);
    });
  }
  async update(p: Principal, id: string, b: DealUpdate) {
    await this.access(p, true);
    validateDeal(b);
    const financeEnabled = await companyFinanceEnabled(this.db, p.companyId!);
    return this.db.tenant(p.companyId!, async (c) => {
      const old = await this.row(c, p, id, true);
      if (old.version !== b.version)
        throw new ConflictException("Deal changed. Refresh before saving");
      const agentId = await this.validateLinks(c, p, b);
      if (
        old.lead_id === b.leadId &&
        old.agent_id === agentId &&
        old.client_name === b.clientName.trim() &&
        old.client_phone === b.clientPhone &&
        old.selling_type === b.sellingType &&
        old.status === b.status &&
        old.developer_id === b.developerId &&
        old.project_id === b.projectId &&
        old.unit_value_minor === b.unitValueMinor &&
        isDeepStrictEqual(old.details, b.details) &&
        !b.documents?.length
      )
        return dto(old);
      // Admin approval only gates the move into a signed contract; EOI,
      // reservation and cancellation save straight through.
      const approved = b.status === "contracted" ? canApprove(p) : true;
      await c.query(
        "UPDATE tenant.brokerage_deals SET lead_id=$3,agent_id=$4,client_name=$5,client_phone=$6,selling_type=$7,status=$8,approval_status=$9,rejection_reason=NULL,developer_id=$10,project_id=$11,unit_value_minor=$12,details=$13,version=version+1,approved_version=$14,approved_by=$15,approved_at=$16,updated_at=now() WHERE company_id=$1 AND id=$2",
        [
          p.companyId,
          id,
          b.leadId,
          agentId,
          b.clientName.trim(),
          b.clientPhone,
          b.sellingType,
          b.status,
          approved ? "approved" : "pending",
          b.developerId,
          b.projectId,
          b.unitValueMinor,
          JSON.stringify(b.details),
          approved ? old.version + 1 : null,
          approved ? p.id : null,
          approved ? new Date() : null,
        ],
      );
      if (b.documents?.length) await this.insertDocs(c, p, id, b.documents);
      let r = await this.row(c, p, id);
      await this.event(c, p, r, "updated");
      if (approved) {
        await this.syncLead(c, p, r, financeEnabled);
        r = await this.row(c, p, id);
      }
      return dto(r);
    });
  }
  async decide(p: Principal, id: string, b: DealDecision) {
    await this.access(p, true);
    if (!canApprove(p)) throw new ForbiddenException("Admin approval required");
    if (b.decision === "rejected" && !b.reason?.trim())
      throw new BadRequestException("Rejection reason is required");
    const financeEnabled = await companyFinanceEnabled(this.db, p.companyId!);
    return this.db.tenant(p.companyId!, async (c) => {
      const old = await this.row(c, p, id, true);
      if (old.version !== b.version)
        throw new ConflictException("Deal changed. Refresh before approval");
      if (old.approval_status !== "pending")
        throw new ConflictException("Deal is not pending");
      await c.query(
        "UPDATE tenant.brokerage_deals SET approval_status=$3,rejection_reason=$4,approved_version=$5,approved_by=$6,approved_at=$7,updated_at=now() WHERE company_id=$1 AND id=$2",
        [
          p.companyId,
          id,
          b.decision,
          b.decision === "rejected" ? b.reason!.trim() : null,
          b.decision === "approved" ? old.version : null,
          b.decision === "approved" ? p.id : null,
          b.decision === "approved" ? new Date() : null,
        ],
      );
      let r = await this.row(c, p, id);
      await this.event(
        c,
        p,
        r,
        b.decision === "approved" ? "approved" : "rejected",
      );
      await this.syncLead(c, p, r, financeEnabled);
      r = await this.row(c, p, id);
      return dto(r);
    });
  }
  async developers(p: Principal) {
    await this.access(p);
    return this.db.tenant(
      p.companyId!,
      async (c) =>
        (
          await c.query(
            "SELECT id,name,version FROM tenant.brokerage_developers WHERE company_id=$1 AND archived_at IS NULL ORDER BY name",
            [p.companyId],
          )
        ).rows,
    );
  }
  async createDeveloper(p: Principal, b: DeveloperInput) {
    await this.access(p);
    this.owner(p);
    if (b.name.trim().length < 2)
      throw new BadRequestException("Developer name is required");
    return this.db.tenant(p.companyId!, async (c) => {
      const result = await c.query(
        "INSERT INTO tenant.brokerage_developers(company_id,name) VALUES($1,$2) RETURNING id,name,version",
        [p.companyId, b.name.trim()],
      );
      await recordTenantEvent(c, {
        companyId: p.companyId!,
        actorId: p.id,
        action: "brokerage.developer.created",
        resourceType: "brokerage_developer",
        resourceId: result.rows[0].id,
        after: { name: result.rows[0].name },
        payload: { id: result.rows[0].id },
      });
      return result.rows[0];
    });
  }
  async updateDeveloper(p: Principal, id: string, b: DeveloperUpdate) {
    await this.access(p);
    this.owner(p);
    if (b.name.trim().length < 2)
      throw new BadRequestException("Developer name is required");
    return this.db.tenant(p.companyId!, async (c) => {
      const old = (
        await c.query(
          "SELECT * FROM tenant.brokerage_developers WHERE company_id=$1 AND id=$2 FOR UPDATE",
          [p.companyId, id],
        )
      ).rows[0];
      if (!old || old.archived_at)
        throw new NotFoundException("Developer not found");
      if (old.version !== b.version)
        throw new ConflictException("Developer changed. Refresh before saving");
      const updated = (
        await c.query(
          "UPDATE tenant.brokerage_developers SET name=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING id,name,version",
          [p.companyId, id, b.name.trim()],
        )
      ).rows[0];
      await c.query(
        "UPDATE tenant.projects SET developer=jsonb_set(jsonb_set(developer,'{en}',to_jsonb($3::text)),'{ar}',to_jsonb($3::text)),version=version+1,updated_at=now() WHERE company_id=$1 AND brokerage_developer_id=$2",
        [p.companyId, id, updated.name],
      );
      await recordTenantEvent(c, {
        companyId: p.companyId!,
        actorId: p.id,
        action: "brokerage.developer.updated",
        resourceType: "brokerage_developer",
        resourceId: id,
        before: { name: old.name },
        after: { name: updated.name },
        payload: { id },
      });
      return updated;
    });
  }
  async archiveDeveloper(p: Principal, id: string, b: DeveloperArchive) {
    await this.access(p);
    this.owner(p);
    return this.db.tenant(p.companyId!, async (c) => {
      const old = (
        await c.query(
          "SELECT * FROM tenant.brokerage_developers WHERE company_id=$1 AND id=$2 FOR UPDATE",
          [p.companyId, id],
        )
      ).rows[0];
      if (!old || old.archived_at)
        throw new NotFoundException("Developer not found");
      if (old.version !== b.version)
        throw new ConflictException(
          "Developer changed. Refresh before archiving",
        );
      if (
        (
          await c.query(
            "SELECT 1 FROM tenant.projects WHERE company_id=$1 AND brokerage_developer_id=$2 AND archived_at IS NULL LIMIT 1",
            [p.companyId, id],
          )
        ).rowCount
      )
        throw new ConflictException("Archive its active projects first");
      await c.query(
        "UPDATE tenant.brokerage_developers SET archived_at=now(),version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
        [p.companyId, id],
      );
      await recordTenantEvent(c, {
        companyId: p.companyId!,
        actorId: p.id,
        action: "brokerage.developer.archived",
        resourceType: "brokerage_developer",
        resourceId: id,
        before: { name: old.name },
        payload: { id },
      });
      return { id };
    });
  }
  async createProject(p: Principal, b: BrokerageProjectInput) {
    await this.access(p);
    this.owner(p);
    if (b.name.trim().length < 2 || b.location.trim().length < 2)
      throw new BadRequestException("Project name and location are required");
    return this.db.tenant(p.companyId!, async (c) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$/.test(b.code))
        throw new BadRequestException("Invalid project code");
      const policy = (
        await c.query(
          "SELECT subscription_id,projects_limit FROM platform.inventory_policy WHERE company_id=$1",
          [p.companyId],
        )
      ).rows[0];
      if (!policy?.subscription_id)
        throw new ForbiddenException("A current subscription is required");
      if (
        policy.projects_limit !== null &&
        (
          await c.query(
            "SELECT count(*)::int AS n FROM tenant.projects WHERE company_id=$1 AND archived_at IS NULL",
            [p.companyId],
          )
        ).rows[0].n >= Number(policy.projects_limit)
      )
        throw new ConflictException("Project limit reached");
      const dev = (
        await c.query(
          "SELECT name FROM tenant.brokerage_developers WHERE company_id=$1 AND id=$2 AND archived_at IS NULL",
          [p.companyId, b.developerId],
        )
      ).rows[0];
      if (!dev) throw new BadRequestException("Choose a company developer");
      const x = (
        await c.query(
          "INSERT INTO tenant.projects(company_id,code,name,developer,location,segment,brokerage_developer_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,code,name",
          [
            p.companyId,
            b.code.trim().toUpperCase(),
            JSON.stringify({ en: b.name.trim(), ar: b.name.trim() }),
            JSON.stringify({ en: dev.name, ar: dev.name }),
            JSON.stringify({ en: b.location.trim(), ar: b.location.trim() }),
            b.segment,
            b.developerId,
          ],
        )
      ).rows[0];
      await recordTenantEvent(c, {
        companyId: p.companyId!,
        actorId: p.id,
        action: "project.created",
        resourceType: "project",
        resourceId: x.id,
        after: { code: x.code },
        payload: { id: x.id, code: x.code },
      });
      return { ...x, name: name(x.name), developerId: b.developerId };
    });
  }
}
