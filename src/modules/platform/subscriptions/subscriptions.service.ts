import { Optional } from "@nestjs/common";
import { SettingsService } from "../settings/settings.service.js";
import { DEFAULT_SETTINGS } from "../settings/settings.model.js";
import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
import type {
  PlanCreate,
  PlanEdit,
  PlanInput,
  SubscriptionCreate,
  SubscriptionChange,
} from "./subscriptions.dto.js";
export const SUB_SELECT = `SELECT s.*,c.public_id AS company_ref,c.name AS company_name,v.name AS plan_name,v.revision,v.monthly_minor,v.annual_minor,v.limits,v.features FROM platform.subscriptions s JOIN platform.companies c ON c.id=s.company_id JOIN platform.plan_versions v ON v.id=s.plan_version_id`;
export function subDto(s: any) {
  const ended = new Date(s.period_end).getTime() <= Date.now();
  const status = ["canceled", "expired"].includes(s.status)
    ? s.status
    : ended
      ? s.cancel_at_period_end
        ? "canceled"
        : "expired"
      : s.status;
  const amount = s.cycle === "annual" ? s.annual_minor : s.monthly_minor;
  return {
    subId: s.public_id,
    companyId: s.company_ref,
    companyEn: s.company_name?.en,
    companyAr: s.company_name?.ar,
    plan: s.plan_key,
    planName: s.plan_name,
    planVersionId: s.plan_version_id,
    planRevision: s.revision,
    pendingVersionId: s.pending_version_id,
    cycle: s.cycle,
    status,
    payment: s.payment_method,
    renewsOn: new Date(s.period_end).toISOString(),
    periodStart: new Date(s.period_start).toISOString(),
    cancelAtPeriodEnd: s.cancel_at_period_end,
    amountMinor: String(amount),
    currency: "EGP",
    mrr:
      status === "active"
        ? Number(amount) / (s.cycle === "annual" ? 1200 : 100)
        : 0,
    version: s.version,
  };
}
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly db: DatabaseService,
    @Optional() private readonly settings?: SettingsService,
  ) {}
  async event(
    c: PoolClient,
    actor: string,
    action: string,
    id: string,
    before: any,
    after: any,
    companyId?: string,
  ) {
    await recordPlatformEvent(c, {
      actorId: actor,
      action,
      resourceType: companyId ? "subscription" : "subscription_plan",
      resourceId: id,
      companyId,
      before: before ?? undefined,
      after,
      payload: { resourceId: id },
    });
  }
  async version(c: PoolClient, key: string, input: PlanInput) {
    const revision = (
      await c.query(
        "SELECT coalesce(max(revision),0)+1 AS n FROM platform.plan_versions WHERE plan_key=$1",
        [key],
      )
    ).rows[0].n;
    return (
      await c.query(
        `INSERT INTO platform.plan_versions(plan_key,revision,name,description,monthly_minor,annual_minor,limits,features) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          key,
          revision,
          { en: input.nameEn.trim(), ar: input.nameAr.trim() },
          { en: input.descEn, ar: input.descAr },
          input.monthlyMinor,
          input.annualMinor,
          {
            users: input.users ?? null,
            listings: input.listings ?? null,
            projects: input.projects ?? null,
            storageGb: input.storageGb ?? null,
          },
          { en: input.featsEn, ar: input.featsAr },
        ],
      )
    ).rows[0];
  }
  async plans() {
    return this.db.platform(async (c) => {
      const result = await c.query(
        `SELECT p.key,p.archived,p.version,v.*, (SELECT count(*)::integer FROM platform.subscriptions s WHERE s.plan_key=p.key AND s.status IN ('trialing','active','past_due','suspended') AND s.period_end>now()) AS companies FROM platform.subscription_plans p JOIN LATERAL (SELECT * FROM platform.plan_versions WHERE plan_key=p.key ORDER BY revision DESC LIMIT 1) v ON true ORDER BY CASE p.key WHEN 'starter' THEN 1 WHEN 'pro' THEN 2 WHEN 'business' THEN 3 ELSE 4 END`,
      );
      return result.rows.map((v) => ({
        key: v.key,
        archived: v.archived,
        version: v.version,
        planVersionId: v.id,
        revision: v.revision,
        nameEn: v.name.en,
        nameAr: v.name.ar,
        descEn: v.description.en,
        descAr: v.description.ar,
        monthlyMinor: Number(v.monthly_minor),
        annualMinor: Number(v.annual_minor),
        currency: v.currency,
        ...v.limits,
        featsEn: v.features.en,
        featsAr: v.features.ar,
        companies: v.companies,
      }));
    });
  }
  async createPlan(input: PlanCreate, actor: string) {
    try {
      return await this.db.platform(async (c) => {
        await c.query(
          "INSERT INTO platform.subscription_plans(key) VALUES ($1)",
          [input.key],
        );
        const row = await this.version(c, input.key, input);
        await this.event(c, actor, "plan.created", row.id, null, row);
        return { key: input.key, planVersionId: row.id };
      });
    } catch (error: any) {
      if (error.code === "23505")
        throw new ConflictException("Plan key already exists");
      throw error;
    }
  }
  async editPlan(key: string, input: PlanEdit, actor: string) {
    return this.db.platform(async (c) => {
      const before = (
        await c.query(
          "SELECT * FROM platform.subscription_plans WHERE key=$1 FOR UPDATE",
          [key],
        )
      ).rows[0];
      if (!before) throw new NotFoundException();
      if (before.version !== input.version)
        throw new ConflictException("Plan changed. Refresh first.");
      if (before.archived)
        throw new ConflictException("Restore the plan before editing");
      if (input.scope === "migrate" && !input.selectedIds.length)
        throw new BadRequestException("Select subscriptions to migrate");
      const row = await this.version(c, key, input);
      if (input.scope !== "new") {
        const subs = (
          await c.query(
            `SELECT * FROM platform.subscriptions WHERE plan_key=$1 AND status IN ('trialing','active','past_due','suspended') AND period_end>now() ${input.scope === "migrate" ? "AND public_id=ANY($2::text[])" : ""} ORDER BY id FOR UPDATE`,
            input.scope === "migrate" ? [key, input.selectedIds] : [key],
          )
        ).rows;
        if (
          input.scope === "migrate" &&
          subs.length !== input.selectedIds.length
        )
          throw new ConflictException(
            "Selected subscriptions are no longer eligible",
          );
        for (const sub of subs) {
          const after = (
            await c.query(
              `UPDATE platform.subscriptions SET ${input.scope === "renewal" ? "pending_version_id=$2" : "plan_version_id=$2,pending_version_id=NULL"},version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
              [sub.id, row.id],
            )
          ).rows[0];
          await this.event(
            c,
            actor,
            "subscription.plan_terms_" + input.scope,
            sub.id,
            sub,
            after,
            sub.company_id,
          );
        }
      }
      await c.query(
        "UPDATE platform.subscription_plans SET version=version+1,updated_at=now() WHERE key=$1",
        [key],
      );
      await this.event(c, actor, "plan.revised", row.id, before, row);
      return { key, planVersionId: row.id };
    });
  }
  archivePlan(key: string, version: number, archived: boolean, actor: string) {
    return this.db.platform(async (c) => {
      const before = (
        await c.query(
          "SELECT * FROM platform.subscription_plans WHERE key=$1 FOR UPDATE",
          [key],
        )
      ).rows[0];
      if (!before) throw new NotFoundException();
      if (before.version !== version)
        throw new ConflictException("Plan changed. Refresh first.");
      const after = (
        await c.query(
          "UPDATE platform.subscription_plans SET archived=$2,version=version+1,updated_at=now() WHERE key=$1 RETURNING *",
          [key, archived],
        )
      ).rows[0];
      const v = (
        await c.query(
          "SELECT id FROM platform.plan_versions WHERE plan_key=$1 ORDER BY revision DESC LIMIT 1",
          [key],
        )
      ).rows[0];
      await this.event(
        c,
        actor,
        archived ? "plan.archived" : "plan.restored",
        v.id,
        before,
        after,
      );
      return after;
    });
  }
  async list(page = 1, limit = 100) {
    return this.db.platform(async (c) => ({
      items: (
        await c.query(
          SUB_SELECT + " ORDER BY s.created_at DESC,s.id LIMIT $1 OFFSET $2",
          [limit, (page - 1) * limit],
        )
      ).rows.map(subDto),
      total: (
        await c.query(
          "SELECT count(*)::integer AS n FROM platform.subscriptions",
        )
      ).rows[0].n,
    }));
  }
  async currentPlan(c: PoolClient, key: string, expected: string) {
    const plan = (
      await c.query(
        "SELECT * FROM platform.subscription_plans WHERE key=$1 FOR SHARE",
        [key],
      )
    ).rows[0];
    if (!plan || plan.archived)
      throw new ConflictException("Plan unavailable for new terms");
    const row = (
      await c.query(
        "SELECT * FROM platform.plan_versions WHERE plan_key=$1 ORDER BY revision DESC LIMIT 1",
        [key],
      )
    ).rows[0];
    if (row.id !== expected)
      throw new ConflictException(
        "Plan terms changed. Refresh and confirm again.",
      );
    return row;
  }
  async create(input: SubscriptionCreate, actor: string) {
    try {
      return await this.db.platform(async (c) => {
        const company = (
          await c.query(
            "SELECT * FROM platform.companies WHERE public_id=$1 FOR UPDATE",
            [input.companyId],
          )
        ).rows[0];
        if (!company) throw new NotFoundException("Company not found");
        if (["archived", "suspended"].includes(company.status))
          throw new ConflictException(
            "Company cannot receive a new subscription",
          );
        const plan = await this.currentPlan(c, input.plan, input.planVersionId);
        const expired = await c.query(
          "UPDATE platform.subscriptions SET status=CASE WHEN cancel_at_period_end THEN 'canceled' ELSE 'expired' END,version=version+1 WHERE company_id=$1 AND period_end<=now() AND status IN ('trialing','active','past_due','suspended') RETURNING *",
          [company.id],
        );
        for (const old of expired.rows)
          await this.event(
            c,
            actor,
            "subscription.expired",
            old.id,
            null,
            old,
            company.id,
          );
        const id = randomUUID();
        const period =
          input.status === "trialing"
            ? (this.settings
                ? await this.settings.forClient(c)
                : DEFAULT_SETTINGS
              ).trialDays + " days"
            : input.cycle === "annual"
              ? "1 year"
              : "1 month";
        const row = (
          await c.query(
            `INSERT INTO platform.subscriptions(id,public_id,company_id,plan_key,plan_version_id,cycle,status,payment_method,period_end) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+$9::interval) RETURNING *`,
            [
              id,
              "SUB-" + id.toUpperCase(),
              company.id,
              input.plan,
              plan.id,
              input.cycle,
              input.status,
              input.payment,
              period,
            ],
          )
        ).rows[0];
        await this.event(
          c,
          actor,
          "subscription.created",
          id,
          null,
          row,
          company.id,
        );
        return { subId: row.public_id };
      });
    } catch (error: any) {
      if (error.code === "23505")
        throw new ConflictException(
          "Company already has a current subscription",
        );
      throw error;
    }
  }
  async action(
    id: string,
    version: number,
    action: string,
    actor: string,
    input?: SubscriptionChange,
  ) {
    return this.db.platform(async (c) => {
      // Read/lock plan before subscription to keep lock order consistent with bulk plan edits.
      const target = input
        ? await this.currentPlan(c, input.plan, input.planVersionId)
        : null;
      const before = (
        await c.query(
          "SELECT * FROM platform.subscriptions WHERE public_id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!before) throw new NotFoundException("Subscription not found");
      if (before.version !== version)
        throw new ConflictException("Subscription changed. Refresh first.");
      const company = (
        await c.query("SELECT status FROM platform.companies WHERE id=$1", [
          before.company_id,
        ])
      ).rows[0];
      if (
        ["archived", "suspended"].includes(company.status) &&
        action !== "cancel"
      )
        throw new ConflictException("Company unavailable");
      let after;
      if (action === "cancel") {
        if (
          before.cancel_at_period_end ||
          ["canceled", "expired"].includes(before.status) ||
          new Date(before.period_end).getTime() <= Date.now()
        )
          throw new ConflictException(
            "Subscription is already ending or ended",
          );
        after = (
          await c.query(
            "UPDATE platform.subscriptions SET cancel_at_period_end=true,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
            [before.id],
          )
        ).rows[0];
      } else if (action === "change") {
        if (
          ["canceled", "expired"].includes(before.status) ||
          new Date(before.period_end).getTime() <= Date.now() ||
          before.cancel_at_period_end
        )
          throw new ConflictException(
            "Cannot change an ending or ended subscription",
          );
        after = (
          await c.query(
            "UPDATE platform.subscriptions SET plan_key=$2,plan_version_id=$3,pending_version_id=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
            [before.id, input!.plan, target.id],
          )
        ).rows[0];
      } else {
        if (before.status === "suspended")
          throw new ConflictException(
            "Suspended subscriptions require review before renewal",
          );
        const planVersion = before.pending_version_id ?? before.plan_version_id;
        const interval = before.cycle === "annual" ? "1 year" : "1 month";
        try {
          after = (
            await c.query(
              `UPDATE platform.subscriptions SET plan_version_id=$2,pending_version_id=NULL,status='active',cancel_at_period_end=false,period_start=greatest(now(),period_end),period_end=greatest(now(),period_end)+$3::interval,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
              [before.id, planVersion, interval],
            )
          ).rows[0];
        } catch (error: any) {
          if (error.code === "23505")
            throw new ConflictException("A newer subscription already exists");
          throw error;
        }
      }
      await this.event(
        c,
        actor,
        "subscription." + action,
        before.id,
        before,
        after,
        before.company_id,
      );
      return subDto(
        (await c.query(SUB_SELECT + " WHERE s.id=$1", [before.id])).rows[0],
      );
    });
  }
}
