import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
import type {
  FeatureChange,
  FeatureOverride,
  ReasonVersion,
  LimitOverride,
} from "./features.dto.js";
export const COMPANY_POLICY = `SELECT c.*,coalesce(cp.version,0) AS policy_version,coalesce(u.users,0) AS user_count,s.plan_key,s.plan_version_id,v.limits FROM platform.companies c LEFT JOIN platform.company_policy cp ON cp.company_id=c.id LEFT JOIN platform.company_user_counts u ON u.company_id=c.id LEFT JOIN LATERAL (SELECT * FROM platform.subscriptions WHERE company_id=c.id AND status IN ('active','trialing') AND period_end>now() ORDER BY created_at DESC,id LIMIT 1) s ON true LEFT JOIN platform.plan_versions v ON v.id=s.plan_version_id`;
export function evaluateFeature(
  companyId: string,
  key: string,
  platformOn: boolean,
  rollout: number,
  entitled: boolean,
  override: boolean | null,
  accessible: boolean,
) {
  if (!accessible || !platformOn) return false;
  if (override !== null) return override;
  const bucket =
    createHash("sha256")
      .update(companyId + ":" + key)
      .digest()
      .readUInt32BE(0) % 100;
  return entitled && bucket < rollout;
}
export function resourceState(
  used: number | null,
  limit: number | null,
  measured: boolean,
) {
  return {
    used,
    limit,
    measured,
    atLimit: measured && used !== null && limit !== null && used >= limit,
    available:
      measured && used !== null
        ? limit === null
          ? null
          : Math.max(0, limit - used)
        : null,
  };
}
@Injectable()
export class FeaturesService {
  constructor(private readonly db: DatabaseService) {}
  async audit(
    c: PoolClient,
    actor: string,
    action: string,
    company: any,
    after: any,
  ) {
    await recordPlatformEvent(c, {
      actorId: actor,
      action,
      companyId: company?.id,
      resourceType: "entitlement_policy",
      resourceId: company?.id ?? actor,
      after,
      payload: { action },
    });
  }
  async catalog() {
    return this.db.platform(async (c) => {
      const plans = (
        await c.query(
          `SELECT p.key,v.name,(SELECT count(*)::int FROM platform.subscriptions s WHERE s.plan_key=p.key AND s.status IN ('trialing','active','past_due') AND s.period_end>now()) AS companies FROM platform.subscription_plans p JOIN LATERAL (SELECT name FROM platform.plan_versions WHERE plan_key=p.key ORDER BY revision DESC LIMIT 1) v ON true ORDER BY p.key`,
        )
      ).rows;
      const features = (
        await c.query("SELECT * FROM platform.features ORDER BY key")
      ).rows;
      const entitlements = (
        await c.query("SELECT * FROM platform.feature_plans")
      ).rows;
      return {
        plans: plans.map((p) => ({
          key: p.key,
          nameEn: p.name.en,
          nameAr: p.name.ar,
          companies: p.companies,
        })),
        features: features.map((f) => ({
          key: f.key,
          nameEn: f.name.en,
          nameAr: f.name.ar,
          platformOn: f.platform_on,
          rollout: f.rollout,
          version: f.version,
          plans: Object.fromEntries(
            entitlements
              .filter((e) => e.feature_key === f.key)
              .map((e) => [e.plan_key, e.enabled]),
          ),
        })),
        overrides: (
          await c.query(
            `SELECT o.*,c.public_id,c.name FROM platform.feature_overrides o JOIN platform.companies c ON c.id=o.company_id WHERE o.revoked_at IS NULL AND o.expires_at>now() ORDER BY o.expires_at`,
          )
        ).rows.map((o) => ({
          id: o.id,
          companyId: o.public_id,
          companyEn: o.name.en,
          companyAr: o.name.ar,
          featureKey: o.feature_key,
          value: o.enabled,
          expires: new Date(o.expires_at).toISOString(),
          reasonEn: o.reason,
          reasonAr: o.reason,
          version: o.version,
        })),
      };
    });
  }
  async change(key: string, input: FeatureChange, actor: string) {
    return this.db.platform(async (c) => {
      const f = (
        await c.query(
          "SELECT * FROM platform.features WHERE key=$1 FOR UPDATE",
          [key],
        )
      ).rows[0];
      if (!f) throw new NotFoundException("Feature not found");
      if (f.version !== input.version)
        throw new ConflictException("Feature changed. Refresh first.");
      if (input.action === "plan") {
        if (!input.plan || typeof input.enabled !== "boolean")
          throw new BadRequestException("Plan and enabled are required");
        if (
          !(
            await c.query(
              "SELECT 1 FROM platform.subscription_plans WHERE key=$1",
              [input.plan],
            )
          ).rowCount
        )
          throw new NotFoundException("Plan not found");
        await c.query(
          "INSERT INTO platform.feature_plans(feature_key,plan_key,enabled) VALUES ($1,$2,$3) ON CONFLICT(feature_key,plan_key) DO UPDATE SET enabled=excluded.enabled",
          [key, input.plan, input.enabled],
        );
      } else if (input.action === "flag") {
        if (typeof input.enabled !== "boolean") throw new BadRequestException();
        await c.query(
          "UPDATE platform.features SET platform_on=$2 WHERE key=$1",
          [key, input.enabled],
        );
      } else {
        if (input.rollout === undefined) throw new BadRequestException();
        await c.query("UPDATE platform.features SET rollout=$2 WHERE key=$1", [
          key,
          input.rollout,
        ]);
      }
      await c.query(
        "UPDATE platform.features SET version=version+1 WHERE key=$1",
        [key],
      );
      await this.audit(c, actor, "feature." + input.action, null, {
        key,
        action: input.action,
        reason: input.reason,
        enabled: input.enabled,
        rollout: input.rollout,
        plan: input.plan,
      });
      return { status: "updated" };
    });
  }
  async policyLock(c: PoolClient, publicId: string, version: number) {
    const company = (
      await c.query(
        "SELECT * FROM platform.companies WHERE public_id=$1 FOR UPDATE",
        [publicId],
      )
    ).rows[0];
    if (!company) throw new NotFoundException("Company not found");
    await c.query(
      "INSERT INTO platform.company_policy(company_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [company.id],
    );
    const policy = (
      await c.query(
        "SELECT * FROM platform.company_policy WHERE company_id=$1 FOR UPDATE",
        [company.id],
      )
    ).rows[0];
    if (policy.version !== version)
      throw new ConflictException("Company policy changed. Refresh first.");
    await c.query(
      "UPDATE platform.company_policy SET version=version+1 WHERE company_id=$1",
      [company.id],
    );
    return company;
  }
  async override(input: FeatureOverride, actor: string) {
    return this.db.platform(async (c) => {
      const company = await this.policyLock(c, input.companyId, input.version);
      if (company.status === "archived")
        throw new ConflictException("Company archived");
      if (
        !(
          await c.query("SELECT 1 FROM platform.features WHERE key=$1", [
            input.featureKey,
          ])
        ).rowCount
      )
        throw new NotFoundException("Feature not found");
      if (
        (
          await c.query(
            "SELECT 1 FROM platform.feature_overrides WHERE company_id=$1 AND feature_key=$2 AND revoked_at IS NULL AND expires_at>now()",
            [company.id, input.featureKey],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Remove the active override before replacing it",
        );
      const expires = new Date(input.expiresAt).getTime();
      if (expires <= Date.now() || expires > Date.now() + 366 * 86400000)
        throw new BadRequestException("Expiry must be within the next year");
      await c.query(
        `INSERT INTO platform.feature_overrides(company_id,feature_key,enabled,expires_at,reason) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(company_id,feature_key) DO UPDATE SET enabled=excluded.enabled,expires_at=excluded.expires_at,reason=excluded.reason,revoked_at=NULL,version=platform.feature_overrides.version+1`,
        [
          company.id,
          input.featureKey,
          input.enabled,
          input.expiresAt,
          input.reason,
        ],
      );
      await this.audit(c, actor, "feature.override_saved", company, {
        featureKey: input.featureKey,
        enabled: input.enabled,
        expiresAt: input.expiresAt,
        reason: input.reason,
      });
      return { status: "saved" };
    });
  }
  async remove(id: string, input: ReasonVersion, actor: string) {
    return this.db.platform(async (c) => {
      const ref = (
        await c.query(
          "SELECT company_id FROM platform.feature_overrides WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!ref) throw new NotFoundException();
      await c.query(
        "SELECT id FROM platform.companies WHERE id=$1 FOR UPDATE",
        [ref.company_id],
      );
      await c.query(
        "SELECT company_id FROM platform.company_policy WHERE company_id=$1 FOR UPDATE",
        [ref.company_id],
      );
      const o = (
        await c.query(
          "SELECT * FROM platform.feature_overrides WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (o.version !== input.version || o.revoked_at)
        throw new ConflictException("Override changed. Refresh first.");
      await c.query(
        "UPDATE platform.feature_overrides SET revoked_at=now(),version=version+1 WHERE id=$1",
        [id],
      );
      await c.query(
        "UPDATE platform.company_policy SET version=version+1 WHERE company_id=$1",
        [o.company_id],
      );
      await this.audit(
        c,
        actor,
        "feature.override_removed",
        { id: o.company_id },
        { id, reason: input.reason },
      );
      return { status: "removed" };
    });
  }
  async usageRows(c: PoolClient) {
    const companies = (
      await c.query(COMPANY_POLICY + " ORDER BY c.created_at,c.id")
    ).rows;
    const storage = (
      await c.query("SELECT * FROM platform.company_storage_counts")
    ).rows;
    const listings = (
      await c.query("SELECT * FROM platform.company_listing_counts")
    ).rows;
    const overrides = (
      await c.query(
        "SELECT * FROM platform.limit_overrides WHERE revoked_at IS NULL AND expires_at>now()",
      )
    ).rows;
    return companies.map((company) => {
      const accessible =
        ["trial", "active"].includes(company.status) &&
        !!company.plan_version_id;
      const resources: Record<string, any> = {};
      for (const resource of ["users", "listings", "storage"]) {
        const used =
          resource === "users"
            ? company.user_count
            : resource === "listings"
              ? (listings.find((x) => x.company_id === company.id)?.listings ??
                0)
              : Number(
                  storage.find((x) => x.company_id === company.id)?.bytes ?? 0,
                ) / 1073741824;
        const base =
          company.limits?.[resource === "storage" ? "storageGb" : resource] ??
          null;
        const override = overrides.find(
          (o) => o.company_id === company.id && o.resource === resource,
        );
        const limit = company.plan_version_id
          ? override
            ? Number(override.limit_value)
            : base
          : 0;
        resources[resource] = {
          ...resourceState(used, limit, true),
          baseLimit: company.plan_version_id ? base : 0,
          overrideExpires: override
            ? new Date(override.expires_at).toISOString()
            : null,
          measuredAt: new Date().toISOString(),
        };
      }
      return {
        id: company.public_id,
        uuid: company.id,
        nameEn: company.name.en,
        nameAr: company.name.ar,
        plan: company.plan_key ?? "none",
        version: company.policy_version,
        accessible,
        ...resources,
      };
    });
  }
  async usage() {
    return this.db.platform((c) => this.usageRows(c));
  }
  async limit(publicId: string, input: LimitOverride, actor: string) {
    return this.db.platform(async (c) => {
      const company = await this.policyLock(c, publicId, input.version);
      const row = (await this.usageRows(c)).find((r) => r.id === publicId)!;
      if (row.plan === "none")
        throw new ConflictException("Company requires a current subscription");
      const resource = (row as any)[input.resource];
      if (resource.overrideExpires)
        throw new ConflictException(
          "An active override already exists; remove it before extending",
        );
      if (resource.baseLimit === null || resource.baseLimit === 0)
        throw new ConflictException(
          "Unlimited resources do not need an override",
        );
      const next = Math.max(1, Math.ceil(resource.baseLimit * 1.2));
      await c.query(
        `INSERT INTO platform.limit_overrides(company_id,resource,limit_value,expires_at,reason) VALUES ($1,$2,$3,now()+interval '30 days',$4) ON CONFLICT(company_id,resource) DO UPDATE SET limit_value=excluded.limit_value,expires_at=excluded.expires_at,reason=excluded.reason,revoked_at=NULL`,
        [company.id, input.resource, next, input.reason],
      );
      await this.audit(c, actor, "usage.limit_overridden", company, {
        resource: input.resource,
        limit: next,
        reason: input.reason,
      });
      return { status: "saved" };
    });
  }
  async removeLimit(publicId: string, input: LimitOverride, actor: string) {
    return this.db.platform(async (c) => {
      const company = await this.policyLock(c, publicId, input.version);
      const result = await c.query(
        "UPDATE platform.limit_overrides SET revoked_at=now() WHERE company_id=$1 AND resource=$2 AND revoked_at IS NULL RETURNING *",
        [company.id, input.resource],
      );
      if (!result.rowCount) throw new NotFoundException("Override not found");
      await this.audit(c, actor, "usage.limit_override_removed", company, {
        resource: input.resource,
        reason: input.reason,
      });
      return { status: "removed" };
    });
  }
  async effective(publicId: string) {
    return this.db.platform(async (c) => {
      const company = (
        await c.query(COMPANY_POLICY + " WHERE c.public_id=$1", [publicId])
      ).rows[0];
      if (!company) throw new NotFoundException();
      const f = (await c.query("SELECT * FROM platform.features")).rows;
      const ent = (
        await c.query(
          "SELECT * FROM platform.feature_plans WHERE plan_key=$1",
          [company.plan_key ?? ""],
        )
      ).rows;
      const overrides = (
        await c.query(
          "SELECT * FROM platform.feature_overrides WHERE company_id=$1 AND revoked_at IS NULL AND expires_at>now()",
          [company.id],
        )
      ).rows;
      const accessible =
        ["active", "trial"].includes(company.status) &&
        !!company.plan_version_id;
      return {
        companyId: publicId,
        version: company.policy_version,
        accessible,
        features: Object.fromEntries(
          f.map((feature) => {
            const override = overrides.find(
              (o) => o.feature_key === feature.key,
            );
            return [
              feature.key,
              evaluateFeature(
                company.id,
                feature.key,
                feature.platform_on,
                feature.rollout,
                ent.find((e) => e.feature_key === feature.key)?.enabled ??
                  false,
                override ? override.enabled : null,
                accessible,
              ),
            ];
          }),
        ),
      };
    });
  }
}
