import {
  Injectable,
  Inject,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { ENV, type Environment } from "../../config/env.js";
import { recordPlatformEvent } from "../../infrastructure/outbox/domain-events.js";
import type {
  DemoRequestInput,
  DemoRequestStatus,
  DemoRequestQuery,
} from "./public-site.dto.js";
@Injectable()
export class PublicSiteService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Environment,
  ) {}
  site() {
    return this.db.platform(async (c) => {
      const settings =
        (
          await c.query(
            "SELECT value FROM platform.settings WHERE key='platform'",
          )
        ).rows[0]?.value ?? {};
      const plans = (
        await c.query(
          "SELECT p.key,v.name,v.description,v.monthly_minor::text,v.annual_minor::text,v.currency,v.limits,v.features FROM platform.subscription_plans p JOIN LATERAL(SELECT * FROM platform.plan_versions WHERE plan_key=p.key ORDER BY revision DESC LIMIT 1)v ON true WHERE NOT p.archived ORDER BY CASE p.key WHEN 'starter' THEN 0 WHEN 'pro' THEN 1 WHEN 'business' THEN 2 ELSE 3 END,p.key",
        )
      ).rows;
      return {
        platformName: settings.platformName || "Mujez",
        supportEmail: settings.supportEmail || "info@mujez.net",
        dashboardUrl: this.env.DASHBOARD_URL ?? null,
        currency: "EGP",
        taxRate: Number(settings.taxRate ?? 0),
        freeTrials: false,
        plans: plans.map((p) => ({
          key: p.key,
          name: p.name,
          description: p.description,
          monthlyMinor: p.monthly_minor,
          annualMinor: p.annual_minor,
          currency: p.currency,
          limits: p.limits,
          features: {
            en: typeof p.features.en === "string" ? p.features.en : "",
            ar: typeof p.features.ar === "string" ? p.features.ar : "",
          },
        })),
      };
    });
  }
  async request(b: DemoRequestInput) {
    const phone = b.phone.replace(/[ ()-]/g, "");
    if (!/^\+?\d{8,15}$/.test(phone))
      throw new BadRequestException("Enter a valid phone number");
    const normalized = {
      fullName: b.fullName,
      companyName: b.companyName,
      email: b.email,
      phone,
      plan: b.plan ?? null,
      cycle: b.cycle ?? "monthly",
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex");
    return this.db.platform(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        b.requestId,
      ]);
      const old = (
        await c.query(
          "SELECT fingerprint FROM platform.demo_requests WHERE request_id=$1",
          [b.requestId],
        )
      ).rows[0];
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new ConflictException(
            "This request identifier was used for different details",
          );
        return { status: "received", requestId: b.requestId };
      }
      if (
        b.plan &&
        !(
          await c.query(
            "SELECT 1 FROM platform.subscription_plans WHERE key=$1 AND NOT archived",
            [b.plan],
          )
        ).rowCount
      )
        throw new ConflictException(
          "This plan is no longer available. Refresh pricing and choose again.",
        );
      const row = (
        await c.query(
          "INSERT INTO platform.demo_requests(request_id,fingerprint,full_name,company_name,email,phone,plan_key,cycle) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
          [
            b.requestId,
            fingerprint,
            b.fullName,
            b.companyName,
            b.email,
            phone,
            b.plan ?? null,
            b.cycle ?? "monthly",
          ],
        )
      ).rows[0];
      await recordPlatformEvent(c, {
        actorId: null,
        action: "demo_request.created",
        resourceType: "demo_request",
        resourceId: row.id,
        after: {
          status: "new",
          plan: normalized.plan,
          cycle: normalized.cycle,
        },
        payload: { requestId: b.requestId },
      });
      return { status: "received", requestId: b.requestId };
    });
  }
  list(q: DemoRequestQuery) {
    return this.db.platform(async (c) => {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const args: any[] = [],
        filters: string[] = [];
      if (q.q) {
        args.push("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
        filters.push(
          "(full_name ILIKE $1 OR company_name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR request_id::text ILIKE $1)",
        );
      }
      const where = () =>
        filters.length ? " WHERE " + filters.join(" AND ") : "";
      const summary = (
        await c.query(
          "SELECT count(*)::int AS all,count(*) FILTER(WHERE status='new')::int AS new,count(*) FILTER(WHERE status='contacted')::int AS contacted,count(*) FILTER(WHERE status='closed')::int AS closed FROM platform.demo_requests" +
            where(),
          args,
        )
      ).rows[0];
      if (q.status) {
        args.push(q.status);
        filters.push("status=$" + args.length);
      }
      const total = (
        await c.query(
          "SELECT count(*)::int n FROM platform.demo_requests" + where(),
          args,
        )
      ).rows[0].n;
      const items = (
        await c.query(
          'SELECT id,request_id AS reference,full_name AS "fullName",company_name AS "companyName",email,phone,plan_key AS plan,cycle,status,version,created_at AS "createdAt",updated_at AS "updatedAt" FROM platform.demo_requests' +
            where() +
            " ORDER BY created_at DESC,id LIMIT $" +
            (args.length + 1) +
            " OFFSET $" +
            (args.length + 2),
          [...args, q.limit, (q.page - 1) * q.limit],
        )
      ).rows;
      return { items, total, summary, page: q.page, limit: q.limit };
    });
  }
  update(id: string, b: DemoRequestStatus, actor: string) {
    return this.db.platform(async (c) => {
      const old = (
        await c.query(
          "SELECT id,status,version FROM platform.demo_requests WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!old) throw new NotFoundException();
      if (old.version !== b.version)
        throw new ConflictException("Enquiry changed. Refresh first.");
      await c.query(
        "UPDATE platform.demo_requests SET status=$2,version=version+1,updated_at=now() WHERE id=$1",
        [id, b.status],
      );
      await recordPlatformEvent(c, {
        actorId: actor,
        action: "demo_request.updated",
        resourceType: "demo_request",
        resourceId: id,
        before: { status: old.status },
        after: { status: b.status },
        payload: {},
      });
      return { status: b.status, version: b.version + 1 };
    });
  }
}
