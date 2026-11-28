import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../common/auth/access.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import {
  allowedProjects,
  clientInProjects,
} from "../office/office-projects.js";
export async function isOfficeCompany(db: DatabaseService, p: Principal) {
  if (!p.companyId) return false;
  return db.platform(
    async (c) =>
      !!(
        await c.query(
          "SELECT 1 FROM platform.companies WHERE id=$1 AND company_type='real_estate_office'",
          [p.companyId],
        )
      ).rowCount,
  );
}
/** Resolve current membership within the read/write transaction. Null is company scope. */
export async function officeMembers(
  c: PoolClient,
  p: Principal,
): Promise<string[] | null> {
  if (p.scope === "company") return null;
  if (!(p.roles ?? [p.role]).includes("team_lead")) return [p.id];
  const rows = (
    await c.query(
      "SELECT m.id FROM tenant.teams t JOIN tenant.users lead ON lead.company_id=t.company_id AND lead.id=t.lead_user_id JOIN platform.team_employee_status a ON a.company_id=lead.company_id AND a.user_id=lead.id JOIN tenant.users m ON m.company_id=t.company_id AND m.team_id=t.id WHERE t.company_id=$1 AND t.lead_user_id=$2 AND lead.team_id=t.id AND lead.status='active' AND lead.deleted_at IS NULL AND a.status='active' AND m.deleted_at IS NULL",
      [p.companyId, p.id],
    )
  ).rows;
  return [...new Set([p.id, ...rows.map((r) => r.id)])];
}
export function officeRelatedRow(
  row: any,
  members: string[] | null,
  p: Principal,
  projects: string[] | null,
) {
  const r = { ...row };
  if (
    r.office_client_id &&
    ((members !== null && !members.includes(r.office_client_owner)) ||
      !clientInProjects(projects, r.office_client_needs))
  ) {
    r.office_client_id = null;
    r.office_client_name = null;
    r.office_client_ref = null;
  }
  if (r.contact_id && p.scope !== "company" && r.contact_owner !== p.id) {
    r.contact_id = null;
    r.contact_name = null;
    r.contact_ref = null;
  }
  return r;
}
export async function officeClientLink(
  c: PoolClient,
  p: Principal,
  id: string,
  target: string | null,
) {
  const members = await officeMembers(c, p);
  const client = (
    await c.query(
      "SELECT id,owner_id,needs FROM tenant.office_clients WHERE company_id=$1 AND id=$2",
      [p.companyId, id],
    )
  ).rows[0];
  if (
    !client ||
    (members !== null && !members.includes(client.owner_id)) ||
    !clientInProjects(await allowedProjects(c, p), client.needs)
  )
    throw new BadRequestException("Choose a client in your office scope");
  if (target && target !== p.id && target !== client.owner_id)
    throw new BadRequestException(
      "Assign this work to the client’s responsible salesperson",
    );
  if (target && members !== null && !members.includes(target))
    throw new ForbiddenException("Assignment outside your team");
  return client;
}
