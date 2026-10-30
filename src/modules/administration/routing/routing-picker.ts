import { tenantFeature } from "../../../common/auth/tenant-features.js";
import type { PoolClient } from "pg";
export interface RoutingSample {
  source: string;
  segment: string;
  budgetMinor?: string | null;
}
export async function pickRoute(
  c: PoolClient,
  companyId: string,
  s: RoutingSample,
  mutate = false,
  options: { ruleId?: string; excludeUserId?: string | null } = {},
) {
  const args: any[] = [companyId];
  let where = "company_id=$1 AND active AND archived_at IS NULL";
  if (options.ruleId) {
    args.push(options.ruleId);
    where += " AND id=$2";
  } else {
    args.push(s.source, s.segment, s.budgetMinor ?? null);
    where +=
      " AND (source IS NULL OR source=$2) AND (segment IS NULL OR segment=$3) AND (min_budget_minor IS NULL OR ($4::bigint IS NOT NULL AND min_budget_minor<=$4::bigint))";
  }
  const rules = (
    await c.query(
      "SELECT * FROM tenant.routing_rules WHERE " +
        where +
        " ORDER BY position,id",
      args,
    )
  ).rows;
  const advanced = rules.some(
    (r) => ["weighted", "team"].includes(r.strategy) || r.sla_minutes > 0,
  )
    ? await tenantFeature(c, companyId, "routing_adv")
    : false;
  for (const r of rules) {
    if (
      !advanced &&
      (["weighted", "team"].includes(r.strategy) || r.sla_minutes > 0)
    )
      continue;
    const targets = (
      await c.query(
        "SELECT t.*,u.name FROM tenant.routing_targets t JOIN tenant.users u ON u.company_id=t.company_id AND u.id=t.user_id WHERE t.company_id=$1 AND t.rule_id=$2 AND u.status='active' AND u.deleted_at IS NULL AND ($3::uuid IS NULL OR t.user_id<>$3::uuid) ORDER BY t.position,t.user_id",
        [companyId, r.id, options.excludeUserId ?? null],
      )
    ).rows;
    if (!targets.length) continue;
    let picked = targets[0];
    if (r.strategy === "weighted") {
      picked = [...targets].sort(
        (a, b) =>
          b.current_score + b.weight - (a.current_score + a.weight) ||
          a.position - b.position,
      )[0];
      if (mutate) {
        const ids = targets.map((t) => t.user_id);
        await c.query(
          "UPDATE tenant.routing_targets SET current_score=current_score+weight WHERE company_id=$1 AND rule_id=$2 AND user_id=ANY($3::uuid[])",
          [companyId, r.id, ids],
        );
        await c.query(
          "UPDATE tenant.routing_targets SET current_score=current_score-$4 WHERE company_id=$1 AND rule_id=$2 AND user_id=$3",
          [
            companyId,
            r.id,
            picked.user_id,
            targets.reduce((a, t) => a + t.weight, 0),
          ],
        );
      }
    } else if (r.strategy !== "specific_user") {
      picked = targets[Number(BigInt(r.cursor) % BigInt(targets.length))];
      if (mutate)
        await c.query(
          "UPDATE tenant.routing_rules SET cursor=cursor+1 WHERE company_id=$1 AND id=$2",
          [companyId, r.id],
        );
    }
    return {
      userId: picked.user_id,
      userName: picked.name,
      ruleId: r.id,
      ruleName: r.name,
      strategy: r.strategy,
      slaMinutes: r.sla_minutes,
      teamName: r.team_name,
    };
  }
  return null;
}
