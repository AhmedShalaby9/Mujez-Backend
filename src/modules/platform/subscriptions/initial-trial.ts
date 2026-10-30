import { ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DEFAULT_SETTINGS } from "../settings/settings.model.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";

// Called inside the company-creation transaction: no owner or email is committed
// without the selected plan's actual trial subscription.
export async function createInitialTrial(
  c: PoolClient,
  company: { id: string; selected_plan: string },
  actor: string,
) {
  const catalog = (
    await c.query(
      "SELECT archived FROM platform.subscription_plans WHERE key=$1 FOR SHARE",
      [company.selected_plan],
    )
  ).rows[0];
  if (!catalog || catalog.archived)
    throw new ConflictException(
      "Selected plan is unavailable. Choose an available plan.",
    );
  const plan = (
    await c.query(
      "SELECT id FROM platform.plan_versions WHERE plan_key=$1 ORDER BY revision DESC LIMIT 1",
      [company.selected_plan],
    )
  ).rows[0];
  if (!plan)
    throw new ConflictException("Selected plan has no published terms.");
  const settings = (
    await c.query("SELECT value FROM platform.settings WHERE key='platform'")
  ).rows[0]?.value;
  const trialDays = settings?.trialDays ?? DEFAULT_SETTINGS.trialDays;
  const id = randomUUID();
  const row = (
    await c.query(
      "INSERT INTO platform.subscriptions(id,public_id,company_id,plan_key,plan_version_id,cycle,status,payment_method,period_end) VALUES($1,$2,$3,$4,$5,'monthly','trialing','bank',now()+$6*interval '1 day') RETURNING *",
      [
        id,
        "SUB-" + id.toUpperCase(),
        company.id,
        company.selected_plan,
        plan.id,
        trialDays,
      ],
    )
  ).rows[0];
  await recordPlatformEvent(c, {
    actorId: actor,
    companyId: company.id,
    action: "subscription.created",
    resourceType: "subscription",
    resourceId: id,
    after: row,
    payload: { companyId: company.id, source: "company_creation" },
  });
  return {
    id: row.public_id,
    status: row.status,
    plan: row.plan_key,
    trialEndsAt: new Date(row.period_end).toISOString(),
  };
}
