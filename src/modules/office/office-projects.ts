import type { PoolClient } from "pg";
import type { Principal } from "../../common/auth/access.js";

/** The projects an office salesperson is limited to, or null when unrestricted
 * (company scope, no saved permissions, or "all projects"). */
export async function projectLimit(
  c: PoolClient,
  companyId: string,
  userId: string,
): Promise<string[] | null> {
  const row = (
    await c.query(
      "SELECT p.all_cities,ARRAY(SELECT a.city_id::text FROM tenant.office_agent_cities a WHERE a.company_id=p.company_id AND a.user_id=p.user_id) AS ids FROM tenant.office_agent_permissions p WHERE p.company_id=$1 AND p.user_id=$2",
      [companyId, userId],
    )
  ).rows[0];
  return !row || row.all_cities ? null : (row.ids as string[]);
}
export async function allowedProjects(c: PoolClient, p: Principal) {
  return p.scope === "company" ? null : projectLimit(c, p.companyId!, p.id);
}
/** A client with no project yet stays with its salesperson; otherwise one of
 * its projects must be allowed. Keep in step with clientProjectSql. */
export function clientInProjects(allowed: string[] | null, needs: any) {
  const ids: string[] = needs?.projectIds ?? [];
  return !allowed || !ids.length || ids.some((id) => allowed.includes(id));
}
/** SQL form of clientInProjects for an office_clients alias. Appends to args. */
export function clientProjectSql(
  alias: string,
  allowed: string[] | null,
  args: unknown[],
) {
  if (!allowed) return "TRUE";
  args.push(allowed);
  return `(jsonb_array_length(coalesce(${alias}.needs->'projectIds','[]'::jsonb))=0 OR jsonb_exists_any(${alias}.needs->'projectIds',$${args.length}::text[]))`;
}
