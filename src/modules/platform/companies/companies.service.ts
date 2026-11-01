import { createInitialSubscription } from "../subscriptions/initial-subscription.js";
import { OwnerWelcomeService } from "../../identity/welcome/welcome.service.js";
import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
import type {
  CompanyInput,
  CompanyUpdate,
  StatusInput,
  StepInput,
  CompanyDraftInput,
  ManagerInput,
  CompanyQuoteInput,
} from "./companies.dto.js";
const SELECT = `SELECT c.*,coalesce(u.users,0) AS users,ss.plan_key AS subscription_plan,ss.mrr AS subscription_mrr,ss.cycle AS subscription_cycle,
 (SELECT CASE WHEN s.status NOT IN ('canceled','expired') AND s.period_end<=now() THEN CASE WHEN s.cancel_at_period_end THEN 'canceled' ELSE 'expired' END ELSE s.status END FROM platform.subscriptions s WHERE s.company_id=c.id ORDER BY s.created_at DESC,s.id LIMIT 1) AS subscription_status,
 (SELECT (v.limits->>'users')::numeric FROM platform.subscriptions s JOIN platform.plan_versions v ON v.id=s.plan_version_id WHERE s.company_id=c.id ORDER BY s.created_at DESC,s.id LIMIT 1) AS seat_limit,
 (SELECT s.period_end FROM platform.subscriptions s WHERE s.company_id=c.id AND s.status='trialing' ORDER BY s.created_at DESC LIMIT 1) AS trial_ends_at,
 (SELECT a.last_active_at FROM platform.company_activity_summary a WHERE a.company_id=c.id) AS last_active_at,
 (SELECT jsonb_build_object('id',u.id,'name',u.name) FROM platform.users u WHERE u.id=c.success_manager_id) AS success_manager
 FROM platform.companies c LEFT JOIN platform.company_user_counts u ON u.company_id=c.id LEFT JOIN platform.company_subscription_summary ss ON ss.company_id=c.id`;
export function companyDto(c: any) {
  return {
    id: c.public_id,
    uuid: c.id,
    slug: c.slug,
    nameEn: c.name.en,
    nameAr: c.name.ar,
    type: c.company_type,
    city: c.city,
    adminEmail: c.admin_email,
    phone: c.phone,
    website: c.website,
    plan: c.subscription_plan ?? c.selected_plan,
    status: c.status,
    statusReason: c.status_reason ?? null,
    statusReasonCode: c.status_reason_code ?? null,
    statusAcknowledged: !!c.status_acknowledged,
    subscriptionStatus: c.subscription_status ?? null,
    seatLimit:
      c.seat_limit === null || c.seat_limit === undefined
        ? null
        : Number(c.seat_limit),
    lastActiveAt: c.last_active_at
      ? new Date(c.last_active_at).toISOString()
      : null,
    trialEndsAt: c.trial_ends_at
      ? new Date(c.trial_ends_at).toISOString()
      : null,
    successManager: c.success_manager ?? null,
    workspacePath: "/company/dashboard",
    country: c.country ?? "EG",
    address: c.address ?? "",
    companyEmail: c.company_email ?? null,
    taxNumber: c.tax_number ?? "",
    crNumber: c.cr_number ?? "",
    ownerProfile: c.owner_profile ?? {},
    cycle: c.subscription_cycle ?? null,
    users: c.users ?? 0,
    mrr: Number(c.subscription_mrr ?? 0),
    createdAt: new Date(c.created_at).toISOString(),
    lastActivity: new Date(c.updated_at).toISOString(),
    signedUp: new Date(c.created_at).toISOString(),
    completedSteps: c.onboarding_completed.length,
    completedKeys: c.onboarding_completed,
    stuckDays: Math.max(
      0,
      Math.floor(
        (Date.now() - new Date(c.onboarding_updated_at).getTime()) / 86400000,
      ),
    ),
    version: c.version,
  };
}
@Injectable()
export class CompaniesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly welcome: OwnerWelcomeService,
  ) {}
  async list(page = 1, limit = 100, onboarding = false) {
    return this.db.platform(async (c) => {
      const where = onboarding ? " WHERE c.status IN ('pending','trial')" : "";
      const rows = await c.query(
        SELECT + where + " ORDER BY c.created_at DESC,c.id LIMIT $1 OFFSET $2",
        [limit, (page - 1) * limit],
      );
      const count = await c.query(
        "SELECT count(*)::integer AS total FROM platform.companies c" + where,
      );
      return {
        items: rows.rows.map(companyDto),
        total: count.rows[0].total,
        page,
        limit,
      };
    });
  }
  async detail(id: string) {
    return this.db.platform(async (c) => {
      const row = (await c.query(SELECT + " WHERE c.public_id=$1", [id]))
        .rows[0];
      if (!row) throw new NotFoundException("Company not found");
      return companyDto(row);
    });
  }
  private async event(
    c: PoolClient,
    actor: string,
    action: string,
    before: any,
    after: any,
  ) {
    await recordPlatformEvent(c, {
      actorId: actor,
      companyId: after.id,
      resourceType: "company",
      resourceId: after.id,
      action,
      before: before ?? undefined,
      after,
      payload: { companyId: after.id },
    });
  }
  async create(input: CompanyInput, actor: string) {
    this.welcome.ready();
    try {
      return await this.db.platform(async (c) => {
        if (input.draftId) {
          const draft = (
            await c.query(
              "SELECT * FROM platform.company_drafts WHERE id=$1 FOR UPDATE",
              [input.draftId],
            )
          ).rows[0];
          if (
            !draft ||
            draft.completed_company_id ||
            draft.version !== input.draftVersion
          )
            throw new ConflictException("Draft changed or already completed");
        }
        const id = randomUUID();
        const row = (
          await c.query(
            `INSERT INTO platform.companies(id,public_id,slug,name,company_type,city,admin_email,phone,website,selected_plan,status,country,address,company_email,tax_number,cr_number,owner_profile) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13,$14,$15,$16) RETURNING *`,
            [
              id,
              "MJ-" + id.toUpperCase(),
              input.slug,
              { en: input.nameEn.trim(), ar: input.nameAr.trim() },
              input.type,
              input.city.trim(),
              input.adminEmail.toLowerCase(),
              input.phone,
              input.website,
              input.plan,
              input.country ?? "EG",
              input.address ?? "",
              input.companyEmail ?? null,
              input.taxNumber ?? "",
              input.crNumber ?? "",
              input.owner ?? {},
            ],
          )
        ).rows[0];
        await this.event(c, actor, "company.created", null, row);
        const subscription = await createInitialSubscription(
          c,
          row,
          actor,
          input,
        );
        const emailDelivery = await this.welcome.provision(c, row, actor);
        if (input.draftId)
          await c.query(
            "UPDATE platform.company_drafts SET completed_company_id=$2,version=version+1,updated_at=now() WHERE id=$1",
            [input.draftId, row.id],
          );
        const current = (await c.query(SELECT + " WHERE c.id=$1", [row.id]))
          .rows[0];
        return {
          ...companyDto(current),
          ownerProvisioned: true,
          subscription,
          emailDelivery,
        };
      });
    } catch (error: any) {
      if (error.code === "23505")
        throw new ConflictException(
          "Company slug or owner email already exists",
        );
      throw error;
    }
  }
  async quote(input: CompanyQuoteInput) {
    return this.db.platform(async (c) => {
      const p = (
        await c.query(
          "SELECT v.* FROM platform.subscription_plans p JOIN LATERAL(SELECT * FROM platform.plan_versions WHERE plan_key=p.key ORDER BY revision DESC LIMIT 1)v ON true WHERE p.key=$1 AND NOT p.archived",
          [input.plan],
        )
      ).rows[0];
      if (!p) throw new BadRequestException("Plan unavailable");
      const settings = (
        await c.query(
          "SELECT value FROM platform.settings WHERE key='platform'",
        )
      ).rows[0]?.value;
      const base = BigInt(
          input.cycle === "annual" ? p.annual_minor : p.monthly_minor,
        ),
        taxBps = Math.round(Number(settings?.taxRate ?? 0) * 100);
      const tax = (base * BigInt(taxBps) + 5000n) / 10000n;
      return {
        plan: p.plan_key,
        planVersionId: p.id,
        cycle: input.cycle,
        currency: p.currency,
        baseMinor: base.toString(),
        discountMinor: "0",
        taxBps,
        taxMinor: tax.toString(),
        totalMinor: (base + tax).toString(),
        paymentCollected: false,
      };
    });
  }
  async saveDraft(input: CompanyDraftInput, actor: string, id?: string) {
    const { version, draftId, draftVersion, ...payload } = input;
    if (JSON.stringify(payload).length > 24000)
      throw new BadRequestException("Draft is too large");
    return this.db.platform(async (c) => {
      let row;
      if (id) {
        row = (
          await c.query(
            "UPDATE platform.company_drafts SET payload=$2,version=version+1,updated_at=now() WHERE id=$1 AND version=$3 AND completed_company_id IS NULL RETURNING *",
            [id, payload, version],
          )
        ).rows[0];
        if (!row) throw new ConflictException("Draft changed or completed");
      } else
        row = (
          await c.query(
            "INSERT INTO platform.company_drafts(payload,created_by) VALUES($1,$2) RETURNING *",
            [payload, actor],
          )
        ).rows[0];
      await recordPlatformEvent(c, {
        actorId: actor,
        action: "company.draft_saved",
        resourceType: "company_draft",
        resourceId: row.id,
        after: { version: row.version },
        payload: {},
      });
      return row;
    });
  }
  drafts() {
    return this.db.platform(async (c) => ({
      items: (
        await c.query(
          "SELECT id,payload,version,updated_at FROM platform.company_drafts WHERE completed_company_id IS NULL ORDER BY updated_at DESC LIMIT 100",
        )
      ).rows,
    }));
  }
  async draft(id: string) {
    return this.db.platform(async (c) => {
      const r = (
        await c.query(
          "SELECT id,payload,version FROM platform.company_drafts WHERE id=$1 AND completed_company_id IS NULL",
          [id],
        )
      ).rows[0];
      if (!r) throw new NotFoundException();
      return r;
    });
  }
  managers() {
    return this.db.platform(async (c) => ({
      items: (
        await c.query(
          "SELECT id,name FROM platform.users WHERE status='active' ORDER BY name,id LIMIT 1000",
        )
      ).rows,
    }));
  }
  async manager(id: string, input: ManagerInput, actor: string) {
    return this.change(
      id,
      input.version,
      actor,
      "company.success_manager_assigned",
      async (c, b) => {
        if (
          input.managerId &&
          !(
            await c.query(
              "SELECT 1 FROM platform.users WHERE id=$1 AND status='active'",
              [input.managerId],
            )
          ).rowCount
        )
          throw new BadRequestException("Choose an active platform user");
        return (
          await c.query(
            "UPDATE platform.companies SET success_manager_id=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
            [b.id, input.managerId ?? null],
          )
        ).rows[0];
      },
    );
  }
  onboardingSummary() {
    return this.db.platform(async (c) => {
      const r = (
        await c.query(
          "SELECT count(*)::int AS companies,count(first_deal_at)::int AS completed,percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM (a.first_deal_at-c.created_at))/86400) FILTER(WHERE a.first_deal_at IS NOT NULL) AS median_days FROM platform.companies c JOIN platform.company_onboarding_summary a ON a.company_id=c.id WHERE c.created_at>=now()-interval '90 days' AND c.status<>'archived' ",
        )
      ).rows[0];
      return {
        windowDays: 90,
        companies: r.companies,
        completed: r.completed,
        medianDays: r.median_days === null ? null : Number(r.median_days),
        trialsOffered: false,
      };
    });
  }
  async change(
    id: string,
    version: number,
    actor: string,
    action: string,
    work: (c: PoolClient, before: any) => Promise<any>,
  ) {
    try {
      return await this.db.platform(async (c) => {
        const before = (
          await c.query(
            "SELECT * FROM platform.companies WHERE public_id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!before) throw new NotFoundException("Company not found");
        if (before.version !== version)
          throw new ConflictException(
            "Company changed. Refresh and try again.",
          );
        const after = await work(c, before);
        await this.event(c, actor, action, before, after);
        return companyDto(
          (await c.query(SELECT + " WHERE c.id=$1", [after.id])).rows[0],
        );
      });
    } catch (error: any) {
      if (error.code === "23505")
        throw new ConflictException("Company slug already exists");
      throw error;
    }
  }
  update(id: string, input: CompanyUpdate, actor: string) {
    return this.change(
      id,
      input.version,
      actor,
      "company.updated",
      async (c, b) => {
        if (b.status === "archived")
          throw new ConflictException("Archived company is read-only");
        return (
          await c.query(
            `UPDATE platform.companies SET slug=$2,name=$3,company_type=$4,city=$5,admin_email=$6,phone=$7,website=$8,selected_plan=$9,country=coalesce($10,country),address=coalesce($11,address),company_email=coalesce($12,company_email),tax_number=coalesce($13,tax_number),cr_number=coalesce($14,cr_number),updated_at=now(),version=version+1 WHERE id=$1 RETURNING *`,
            [
              b.id,
              input.slug,
              { en: input.nameEn.trim(), ar: input.nameAr.trim() },
              input.type,
              input.city.trim(),
              input.adminEmail.toLowerCase(),
              input.phone,
              input.website,
              input.plan,
              input.country ?? null,
              input.address ?? null,
              input.companyEmail ?? null,
              input.taxNumber ?? null,
              input.crNumber ?? null,
            ],
          )
        ).rows[0];
      },
    );
  }
  status(id: string, input: StatusInput, actor: string) {
    return this.change(
      id,
      input.version,
      actor,
      "company." + input.action,
      async (c, b) => {
        const transitions: Record<string, Record<string, string>> = {
          pending: {
            activate: "active",
            suspend: "suspended",
            archive: "archived",
          },
          trial: {
            activate: "active",
            suspend: "suspended",
            archive: "archived",
          },
          active: { suspend: "suspended", archive: "archived" },
          suspended: { reactivate: "active", archive: "archived" },
          expired: { activate: "active", archive: "archived" },
        };
        const status = transitions[b.status]?.[input.action];
        if (!status)
          throw new ConflictException("Invalid company status transition");
        return (
          await c.query(
            "UPDATE platform.companies SET status=$2,status_reason=$3,status_reason_code=$4,status_acknowledged=$5,updated_at=now(),version=version+1 WHERE id=$1 RETURNING *",
            [
              b.id,
              status,
              input.reason,
              input.reasonCode ?? "other",
              input.acknowledged ?? false,
            ],
          )
        ).rows[0];
      },
    );
  }
  step(id: string, input: StepInput, actor: string) {
    return this.change(
      id,
      input.version,
      actor,
      "company.onboarding_updated",
      async (c, b) => {
        if (!["pending", "trial"].includes(b.status))
          throw new ConflictException("Company is not in onboarding");
        const keys = new Set<string>(b.onboarding_completed);
        if (input.completed) keys.add(input.step);
        else keys.delete(input.step);
        return (
          await c.query(
            "UPDATE platform.companies SET onboarding_completed=$2,onboarding_updated_at=now(),updated_at=now(),version=version+1 WHERE id=$1 RETURNING *",
            [b.id, [...keys]],
          )
        ).rows[0];
      },
    );
  }
}
