import { tenantFeature } from "../../../common/auth/tenant-features.js";
import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { SalesService } from "../../sales/leads/sales.service.js";
import { STAGES } from "../../sales/leads/leads.dto.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import type { ReportQuery, ReportExport } from "./reports.dto.js";
export function reportStart(today: string, period: string) {
  const [year, month] = today.split("-").map(Number);
  return (
    String(year) +
    "-" +
    String(
      period === "ytd"
        ? 1
        : period === "quarter"
          ? Math.floor((month! - 1) / 3) * 3 + 1
          : month,
    ).padStart(2, "0") +
    "-01"
  );
}
export function safeCsv(v: unknown) {
  let s = String(v ?? "");
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export function amountMajor(v: string) {
  const n = BigInt(v);
  return String(n / 100n) + "." + String(n % 100n).padStart(2, "0");
}
const SOURCES = [
  "manual",
  "referral",
  "website",
  "phone",
  "walk_in",
  "social",
  "other",
];
@Injectable()
export class CompanyReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async read(
    c: PoolClient,
    companyId: string,
    period: string,
    segment?: string,
    includeCommissions = true,
  ) {
    const clock = (
        await c.query(
          "SELECT now() AS at,(now() AT TIME ZONE 'Africa/Cairo')::date::text AS today",
        )
      ).rows[0],
      from = reportStart(clock.today, period),
      args = [companyId, from, clock.today, segment ?? null];
    const cohort =
        "l.company_id=$1 AND l.created_at>=($2::date::timestamp AT TIME ZONE 'Africa/Cairo') AND l.created_at<(($3::date+1)::timestamp AT TIME ZONE 'Africa/Cairo') AND ($4::text IS NULL OR l.segment=$4)",
      sales =
        "ct.company_id=$1 AND ct.status='signed' AND ct.type='sale' AND ct.signed_date BETWEEN $2::date AND $3::date AND ($4::text IS NULL OR l.segment=$4)";
    const stages = (
      await c.query(
        "SELECT l.stage,count(*)::int AS n FROM tenant.leads l WHERE " +
          cohort +
          " GROUP BY l.stage",
        args,
      )
    ).rows;
    const sources = (
      await c.query(
        "SELECT l.source,count(*)::int AS leads,count(*) FILTER(WHERE l.stage='won')::int AS won FROM tenant.leads l WHERE " +
          cohort +
          " GROUP BY l.source",
        args,
      )
    ).rows;
    const volume = (
      await c.query(
        "WITH months AS (SELECT generate_series(date_trunc('month',$2::date),date_trunc('month',$3::date),interval '1 month')::date AS d),sales AS (SELECT to_char(ct.signed_date,'YYYY-MM') AS month,count(*)::int AS deals,sum(ct.value_minor)::text AS value FROM tenant.contracts ct JOIN tenant.leads l ON l.company_id=ct.company_id AND l.id=ct.lead_id WHERE " +
          sales +
          " GROUP BY to_char(ct.signed_date,'YYYY-MM')) SELECT to_char(m.d,'YYYY-MM') AS month,coalesce(s.deals,0)::int AS deals,coalesce(s.value,'0') AS value_minor FROM months m LEFT JOIN sales s ON s.month=to_char(m.d,'YYYY-MM') ORDER BY m.d",
        args,
      )
    ).rows;
    const owners = (
      await c.query(
        "WITH cohort AS (SELECT l.owner_user_id,count(*)::int AS leads FROM tenant.leads l WHERE " +
          cohort +
          " GROUP BY l.owner_user_id),sales AS (SELECT ct.owner_id,count(*)::int AS deals,sum(ct.value_minor) AS amount FROM tenant.contracts ct JOIN tenant.leads l ON l.company_id=ct.company_id AND l.id=ct.lead_id WHERE " +
          sales +
          " GROUP BY ct.owner_id) SELECT u.id,u.name,coalesce(co.leads,0)::int AS leads,coalesce(s.deals,0)::int AS deals,coalesce(s.amount,0)::text AS sale_value_minor FROM tenant.users u LEFT JOIN cohort co ON co.owner_user_id=u.id LEFT JOIN sales s ON s.owner_id=u.id WHERE u.company_id=$1 AND (u.status='active' OR co.leads>0 OR s.deals>0) ORDER BY coalesce(s.amount,0) DESC,coalesce(co.leads,0) DESC,u.name,u.id LIMIT 100",
        args,
      )
    ).rows;
    const unassigned = (
      await c.query(
        "SELECT (SELECT count(*)::int FROM tenant.leads l WHERE " +
          cohort +
          " AND l.owner_user_id IS NULL) AS leads,(SELECT count(*)::int FROM tenant.contracts ct JOIN tenant.leads l ON l.company_id=ct.company_id AND l.id=ct.lead_id WHERE " +
          sales +
          " AND ct.owner_id IS NULL) AS deals,(SELECT coalesce(sum(ct.value_minor),0)::text FROM tenant.contracts ct JOIN tenant.leads l ON l.company_id=ct.company_id AND l.id=ct.lead_id WHERE " +
          sales +
          " AND ct.owner_id IS NULL) AS sale_value_minor",
        args,
      )
    ).rows[0];
    if (unassigned.leads || unassigned.deals)
      owners.push({ id: null, name: null, ...unassigned });
    const commissionsAvailable =
      includeCommissions && (await tenantFeature(c, companyId, "commissions"));
    const paid = commissionsAvailable
      ? (
          await c.query(
            "SELECT coalesce(sum(m.gross_minor),0)::text AS amount FROM tenant.commissions m JOIN tenant.contracts ct ON ct.company_id=m.company_id AND ct.id=m.contract_id JOIN tenant.leads l ON l.company_id=ct.company_id AND l.id=ct.lead_id WHERE m.company_id=$1 AND m.status='paid' AND m.paid_date BETWEEN $2::date AND $3::date AND ($4::text IS NULL OR l.segment=$4)",
            args,
          )
        ).rows[0].amount
      : null;
    return {
      asOf: new Date(clock.at).toISOString(),
      today: clock.today,
      from,
      to: clock.today,
      timeZone: "Africa/Cairo",
      period,
      segment: segment ?? "all",
      currency: "EGP",
      volume: volume.map((v) => ({
        month: v.month,
        deals: v.deals,
        valueMinor: v.value_minor,
      })),
      funnel: STAGES.map((key) => ({
        key,
        count: stages.find((s) => s.stage === key)?.n ?? 0,
      })),
      sources: SOURCES.map((key) => {
        const s = sources.find((s) => s.source === key);
        return {
          key,
          leads: s?.leads ?? 0,
          won: s?.won ?? 0,
          conversion: s?.leads
            ? Math.round((s.won / s.leads) * 1000) / 10
            : null,
        };
      }),
      owners: owners.map((o) => ({
        id: o.id,
        name: o.name,
        leads: o.leads,
        deals: o.deals,
        saleValueMinor: o.sale_value_minor,
      })),
      summary: {
        leads: stages.reduce((a, s) => a + s.n, 0),
        signedSales: volume.reduce((a, v) => a + v.deals, 0),
        signedSaleValueMinor: String(
          volume.reduce((a, v) => a + BigInt(v.value_minor), 0n),
        ),
        recordedPaidCommissionMinor: paid,
      },
    };
  }
  async report(p: Principal, q: ReportQuery) {
    await this.sales.access(p, "reports.read");
    return this.db.tenant(
      p.companyId!,
      (c) =>
        this.read(
          c,
          p.companyId!,
          q.period,
          q.segment,
          p.permissions.includes("commissions.read"),
        ),
      true,
    );
  }
  async export(p: Principal, b: ReportExport) {
    await this.sales.access(p, "reports.read");
    return this.sales.write(
      p,
      "reports.export",
      "reports.export",
      b,
      async (c) => {
        const data = await this.read(
          c,
          p.companyId!,
          b.period,
          b.segment,
          p.permissions.includes("commissions.read"),
        );
        const rows: unknown[][] = [
          ["Mujez company report", "Africa/Cairo", data.from, data.to],
          ["Metric", "Count", "EGP"],
          ["Retained leads in cohort", data.summary.leads, ""],
          [
            "Currently signed sale agreements",
            data.summary.signedSales,
            amountMajor(data.summary.signedSaleValueMinor),
          ],
          [
            "Manually recorded paid commissions",
            "",
            data.summary.recordedPaidCommissionMinor === null
              ? ""
              : amountMajor(data.summary.recordedPaidCommissionMinor),
          ],
          [],
          ["Month", "Signed sales", "Signed sale value (EGP)"],
          ...data.volume.map((v) => [
            v.month,
            v.deals,
            amountMajor(v.valueMinor),
          ]),
          [],
          ["Current cohort stage", "Leads"],
          ...data.funnel.map((f) => [f.key, f.count]),
          [],
          ["Lead source", "Retained cohort leads", "Current won %"],
          ...data.sources.map((s) => [s.key, s.leads, s.conversion ?? ""]),
          [],
          [
            "Current assignee / contract owner",
            "Cohort leads",
            "Signed sales",
            "Signed sale value (EGP)",
          ],
          ...data.owners.map((o) => [
            o.name ?? (b.lang === "ar" ? "غير مسند" : "Unassigned"),
            o.leads,
            o.deals,
            amountMajor(o.saleValueMinor),
          ]),
        ];
        const content =
          "\uFEFF" + rows.map((r) => r.map(safeCsv).join(",")).join("\r\n");
        await recordTenantEvent(c, {
          companyId: p.companyId!,
          actorId: p.id,
          action: "report.exported",
          resourceType: "report",
          resourceId: p.companyId!,
          after: {
            period: b.period,
            from: data.from,
            to: data.to,
            segment: b.segment ?? "all",
          },
          payload: { period: b.period, rowCount: rows.length },
        });
        return {
          fileName: "mujez-report-" + data.from + "-" + data.to + ".csv",
          content,
        };
      },
    );
  }
}
