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
} from "./companies.dto.js";
const SELECT = `SELECT c.*,coalesce(u.users,0) AS users,ss.plan_key AS subscription_plan,ss.mrr AS subscription_mrr,ss.cycle AS subscription_cycle FROM platform.companies c LEFT JOIN platform.company_user_counts u ON u.company_id=c.id LEFT JOIN platform.company_subscription_summary ss ON ss.company_id=c.id`;
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
        const id = randomUUID();
        const row = (
          await c.query(
            `INSERT INTO platform.companies(id,public_id,slug,name,company_type,city,admin_email,phone,website,selected_plan,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active') RETURNING *`,
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
            ],
          )
        ).rows[0];
        await this.event(c, actor, "company.created", null, row);
        const subscription = await createInitialSubscription(c, row, actor);
        const emailDelivery = await this.welcome.provision(c, row, actor);
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
        return companyDto(after);
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
            `UPDATE platform.companies SET slug=$2,name=$3,company_type=$4,city=$5,admin_email=$6,phone=$7,website=$8,selected_plan=$9,updated_at=now(),version=version+1 WHERE id=$1 RETURNING *`,
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
            "UPDATE platform.companies SET status=$2,status_reason=$3,updated_at=now(),version=version+1 WHERE id=$1 RETURNING *",
            [b.id, status, input.reason],
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
