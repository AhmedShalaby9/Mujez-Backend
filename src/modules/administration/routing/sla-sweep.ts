import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { pickRoute } from "./routing-picker.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
export async function runSlaSweep(
  db: Pick<DatabaseService, "platform" | "tenant">,
  shouldStop = () => false,
) {
  const companies = await db.platform(
    async (c) =>
      (
        await c.query(
          "SELECT company_id FROM platform.routing_sla_companies ORDER BY company_id",
        )
      ).rows,
  );
  let reassigned = 0,
    checked = 0;
  for (const company of companies) {
    if (shouldStop()) break;
    const n = await db.tenant(company.company_id, async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,80425113))",
        ["sales:" + company.company_id],
      );
      if (
        !(
          await c.query(
            "SELECT 1 FROM platform.inventory_policy WHERE company_id=$1 AND subscription_id IS NOT NULL",
            [company.company_id],
          )
        ).rowCount
      )
        return 0;
      const leads = (
        await c.query(
          "SELECT l.*,l.budget_minor::text AS budget_minor,u.name AS old_owner FROM tenant.leads l JOIN tenant.routing_rules r ON r.company_id=l.company_id AND r.id=l.routing_rule_id LEFT JOIN tenant.users u ON u.company_id=l.company_id AND u.id=l.owner_user_id WHERE l.company_id=$1 AND l.first_contact_at IS NULL AND l.archived_at IS NULL AND l.stage NOT IN ('won','lost') AND l.routing_attempts<3 AND r.active AND r.archived_at IS NULL AND r.sla_minutes>0 AND l.assigned_at+make_interval(mins=>r.sla_minutes)<=now() AND EXISTS(SELECT 1 FROM tenant.routing_targets t JOIN tenant.users a ON a.company_id=t.company_id AND a.id=t.user_id WHERE t.company_id=l.company_id AND t.rule_id=r.id AND a.status='active' AND a.deleted_at IS NULL AND a.id IS DISTINCT FROM l.owner_user_id) ORDER BY l.assigned_at,l.id LIMIT 100 FOR UPDATE OF l",
          [company.company_id],
        )
      ).rows;
      let count = 0;
      for (const l of leads) {
        if (shouldStop()) break;
        const next = await pickRoute(
          c,
          company.company_id,
          { source: l.source, segment: l.segment, budgetMinor: l.budget_minor },
          true,
          { ruleId: l.routing_rule_id, excludeUserId: l.owner_user_id },
        );
        if (!next) continue;
        const row = (
          await c.query(
            "UPDATE tenant.leads SET owner_user_id=$3,assigned_at=now(),routing_attempts=routing_attempts+1,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING assigned_at,routing_attempts",
            [company.company_id, l.id, next.userId],
          )
        ).rows[0];
        const details = {
          ruleId: next.ruleId,
          fromUserId: l.owner_user_id,
          fromUserName: l.old_owner,
          toUserId: next.userId,
          toUserName: next.userName,
          attempt: row.routing_attempts,
          assignedAt: row.assigned_at,
          reason: "First-contact SLA elapsed",
        };
        await recordTenantEvent(c, {
          companyId: company.company_id,
          actorId: null,
          action: "lead.sla_reassigned",
          resourceType: "lead",
          resourceId: l.id,
          before: { ownerId: l.owner_user_id },
          after: { ownerId: next.userId, assignedAt: row.assigned_at },
          payload: details,
        });
        await c.query(
          "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,NULL,'lead.sla_reassigned',$3)",
          [company.company_id, l.id, details],
        );
        count++;
      }
      return count;
    });
    checked++;
    reassigned += n;
  }
  return { checkedCompanies: checked, reassigned };
}
