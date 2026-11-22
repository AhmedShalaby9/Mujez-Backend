import { BadRequestException, ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
export type CustomTerms = {
  amountMinor: string;
  durationMonths?: number;
  endsOn?: string;
};
export async function customVersion(c: PoolClient, terms: CustomTerms) {
  if (
    !/^[1-9]\d{0,12}$/.test(terms.amountMinor) ||
    BigInt(terms.amountMinor) > 1000000000000n
  )
    throw new BadRequestException("Enter the total subscription price in EGP");
  if (!!terms.endsOn === !!terms.durationMonths)
    throw new BadRequestException("Choose an end date or a duration, not both");
  if (
    terms.durationMonths &&
    (!Number.isInteger(terms.durationMonths) ||
      terms.durationMonths < 1 ||
      terms.durationMonths > 120)
  )
    throw new BadRequestException("Choose 1 to 120 months");
  if (
    terms.endsOn &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(terms.endsOn) ||
      !Number.isFinite(Date.parse(terms.endsOn)) ||
      new Date(terms.endsOn).toISOString().slice(0, 10) !== terms.endsOn)
  )
    throw new BadRequestException("Invalid end date");
  const dates = (
    await c.query(
      `SELECT now() AS starts, CASE WHEN $1::int IS NOT NULL THEN now()+make_interval(months=>$1::int) ELSE (($2::date+1)::timestamp AT TIME ZONE 'Africa/Cairo') END AS ends`,
      [terms.durationMonths ?? null, terms.endsOn ?? null],
    )
  ).rows[0];
  const days = Math.ceil(
    (new Date(dates.ends).getTime() - new Date(dates.starts).getTime()) /
      86400000,
  );
  if (days < 1 || days > 3660)
    throw new BadRequestException(
      "Subscription end must be in the future and within 10 years",
    );
  await c.query(
    "SELECT key FROM platform.subscription_plans WHERE key='custom' FOR UPDATE",
  );
  const revision = (
    await c.query(
      "SELECT coalesce(max(revision),0)+1 AS n FROM platform.plan_versions WHERE plan_key='custom'",
    )
  ).rows[0].n;
  const v = (
    await c.query(
      `INSERT INTO platform.plan_versions(plan_key,revision,name,description,monthly_minor,annual_minor,limits,features) VALUES('custom',$1,'{"en":"Custom subscription","ar":"اشتراك مخصص"}','{}',$2,$2,'{"users":null,"listings":null,"projects":null,"storageGb":null,"leads":null,"contacts":null,"apiPerDay":null}','{"en":[],"ar":[]}') RETURNING id`,
      [revision, terms.amountMinor],
    )
  ).rows[0];
  return { ...dates, days, versionId: v.id };
}
export async function createCustomSubscription(
  c: PoolClient,
  companyId: string,
  actor: string,
  terms: CustomTerms,
  payment = "bank",
) {
  await c.query("SELECT id FROM platform.companies WHERE id=$1 FOR UPDATE", [
    companyId,
  ]);
  await c.query(
    "UPDATE platform.subscriptions SET status=CASE WHEN cancel_at_period_end THEN 'canceled' ELSE 'expired' END,version=version+1,updated_at=now() WHERE company_id=$1 AND status IN ('active','trialing','past_due') AND period_end<=now()",
    [companyId],
  );
  if (
    (
      await c.query(
        "SELECT 1 FROM platform.subscriptions WHERE company_id=$1 AND status IN ('active','trialing','past_due','suspended')",
        [companyId],
      )
    ).rowCount
  )
    throw new ConflictException(
      "A current subscription already exists; edit its custom terms instead",
    );
  const v = await customVersion(c, terms),
    id = randomUUID();
  const row = (
    await c.query(
      `INSERT INTO platform.subscriptions(id,public_id,company_id,plan_key,plan_version_id,cycle,status,payment_method,period_start,period_end,term_amount_minor,term_months,term_days) VALUES($1,$2,$3,'custom',$4,'custom','active',$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        id,
        "SUB-" + id.toUpperCase(),
        companyId,
        v.versionId,
        payment,
        v.starts,
        v.ends,
        terms.amountMinor,
        terms.durationMonths ?? null,
        v.days,
      ],
    )
  ).rows[0];
  await c.query(
    "UPDATE platform.companies SET selected_plan='custom' WHERE id=$1",
    [companyId],
  );
  await recordPlatformEvent(c, {
    actorId: actor,
    companyId,
    action: "subscription.created",
    resourceType: "subscription",
    resourceId: id,
    after: row,
    payload: { companyId, source: "custom_contract" },
  });
  return {
    id: row.public_id,
    status: row.status,
    plan: "custom",
    amountMinor: terms.amountMinor,
    periodEndsAt: new Date(row.period_end).toISOString(),
  };
}
