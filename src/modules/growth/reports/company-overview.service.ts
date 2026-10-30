import { tenantFeature } from "../../../common/auth/tenant-features.js";
import { Injectable } from "@nestjs/common";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { SalesService } from "../../sales/leads/sales.service.js";
import { CompanyReportsService } from "./reports.service.js";
@Injectable()
export class CompanyOverviewService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
    private readonly reports: CompanyReportsService,
  ) {}
  async overview(p: Principal, segment?: string) {
    await this.sales.access(p, "workspace.view");
    const can = (key: string) => p.permissions.includes(key);
    let worker: any = null;
    if (can("routing.read"))
      worker = await this.db.platform(
        async (c) =>
          (
            await c.query(
              "SELECT seen_at,seen_at>now()-interval '2 minutes' AS healthy FROM platform.worker_heartbeats WHERE key='lead-routing'",
            )
          ).rows[0] ?? null,
      );
    return this.db.tenant(
      p.companyId!,
      async (c) => {
        const clock = (
            await c.query(
              "SELECT now() AS at,(now() AT TIME ZONE 'Africa/Cairo')::date::text AS today",
            )
          ).rows[0],
          params = [p.companyId, segment ?? null],
          dated = [...params, clock.today],
          result: any = {
            asOf: new Date(clock.at).toISOString(),
            today: clock.today,
            timeZone: "Africa/Cairo",
            segment: segment ?? "all",
            metrics: {},
            todayTasks: null,
            scoredLeads: null,
            keyDates: null,
            attentionLeads: null,
            inventory: null,
            chart: null,
            alerts: [],
          };
        const commissionsAvailable =
          can("commissions.read") &&
          (await tenantFeature(c, p.companyId!, "commissions"));
        const advancedAvailable =
          (can("leads.read") || can("routing.read")) &&
          (await tenantFeature(c, p.companyId!, "routing_adv"));
        result.features = {
          commissions: commissionsAvailable,
          routingAdvanced: advancedAvailable,
        };
        const alert = (id: string, count: number, route: string) => {
          if (count) result.alerts.push({ id, count, route });
        };
        if (can("pipeline.read"))
          result.metrics.pipeline = (
            await c.query(
              "SELECT coalesce(sum(o.value_minor) FILTER(WHERE o.deal_type='sale'),0)::text AS \"saleValueMinor\",count(*) FILTER(WHERE o.deal_type='sale')::int AS \"saleCount\",count(*) FILTER(WHERE o.deal_type='lease')::int AS \"leaseCount\" FROM tenant.opportunities o JOIN tenant.leads l ON l.company_id=o.company_id AND l.id=o.lead_id WHERE o.company_id=$1 AND l.archived_at IS NULL AND l.stage NOT IN ('won','lost') AND ($2::text IS NULL OR l.segment=$2)",
              params,
            )
          ).rows[0];
        if (can("leads.read")) {
          result.metrics.newLeads7d = (
            await c.query(
              "SELECT count(*)::int AS n FROM tenant.leads l WHERE l.company_id=$1 AND l.created_at>=(($3::date-6)::timestamp AT TIME ZONE 'Africa/Cairo') AND l.created_at<(($3::date+1)::timestamp AT TIME ZONE 'Africa/Cairo') AND ($2::text IS NULL OR l.segment=$2)",
              dated,
            )
          ).rows[0].n;
          result.scoredLeads = (
            await c.query(
              "SELECT l.id,l.public_id AS reference,l.name,l.want,l.budget_minor::text AS \"budgetMinor\",l.score,u.name AS owner FROM tenant.leads l LEFT JOIN tenant.users u ON u.company_id=l.company_id AND u.id=l.owner_user_id WHERE l.company_id=$1 AND l.archived_at IS NULL AND l.stage NOT IN ('won','lost') AND l.score IS NOT NULL AND ($2::text IS NULL OR l.segment=$2) ORDER BY l.score DESC,l.created_at DESC,l.id LIMIT 5",
              params,
            )
          ).rows;
          if (advancedAvailable) {
            const scope =
              "l.company_id=$1 AND l.archived_at IS NULL AND l.stage NOT IN ('won','lost') AND l.first_contact_at IS NULL AND r.active AND r.archived_at IS NULL AND r.sla_minutes>0 AND l.assigned_at+make_interval(mins=>r.sla_minutes)<=now() AND ($2::text IS NULL OR l.segment=$2)";
            const count = (
              await c.query(
                "SELECT count(*)::int AS n FROM tenant.leads l JOIN tenant.routing_rules r ON r.company_id=l.company_id AND r.id=l.routing_rule_id WHERE " +
                  scope,
                params,
              )
            ).rows[0].n;
            alert("first-contact", count, "/company/leads");
            result.attentionLeads = (
              await c.query(
                "SELECT l.id,l.public_id AS reference,l.name,l.routing_attempts AS attempts FROM tenant.leads l JOIN tenant.routing_rules r ON r.company_id=l.company_id AND r.id=l.routing_rule_id WHERE " +
                  scope +
                  " ORDER BY l.assigned_at,l.id LIMIT 5",
                params,
              )
            ).rows;
          }
        }
        if (can("tasks.read")) {
          const scope =
            "t.company_id=$1 AND t.status='open' AND ($2::text IS NULL OR l.segment=$2)";
          result.todayTasks = (
            await c.query(
              'SELECT t.id,t.title,t.priority,t.lead_id AS "leadId",u.name AS assignee FROM tenant.tasks t LEFT JOIN tenant.leads l ON l.company_id=t.company_id AND l.id=t.lead_id LEFT JOIN tenant.users u ON u.company_id=t.company_id AND u.id=t.assignee_id WHERE ' +
                scope +
                " AND t.due_date=$3::date ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END,t.created_at,t.id LIMIT 8",
              dated,
            )
          ).rows;
          result.metrics.todayTasks = (
            await c.query(
              "SELECT count(*)::int AS n FROM tenant.tasks t LEFT JOIN tenant.leads l ON l.company_id=t.company_id AND l.id=t.lead_id WHERE " +
                scope +
                " AND t.due_date=$3::date",
              dated,
            )
          ).rows[0].n;
          alert(
            "overdue-tasks",
            (
              await c.query(
                "SELECT count(*)::int AS n FROM tenant.tasks t LEFT JOIN tenant.leads l ON l.company_id=t.company_id AND l.id=t.lead_id WHERE " +
                  scope +
                  " AND t.due_date<$3::date",
                dated,
              )
            ).rows[0].n,
            "/company/tasks",
          );
        }
        if (can("contracts.read")) {
          result.keyDates = (
            await c.query(
              "SELECT ct.id,ct.public_id AS reference,ct.title,ct.value_minor::text AS \"valueMinor\",ct.key_date::text AS date,ct.status,u.name AS owner FROM tenant.contracts ct JOIN tenant.leads l ON l.company_id=ct.company_id AND l.id=ct.lead_id LEFT JOIN tenant.users u ON u.company_id=ct.company_id AND u.id=ct.owner_id WHERE ct.company_id=$1 AND ct.status<>'void' AND ct.key_date BETWEEN $3::date AND $3::date+14 AND ($2::text IS NULL OR l.segment=$2) ORDER BY ct.key_date,ct.id LIMIT 8",
              dated,
            )
          ).rows;
          alert(
            "missing-evidence",
            (
              await c.query(
                "SELECT count(*)::int AS n FROM tenant.contracts ct JOIN tenant.leads l ON l.company_id=ct.company_id AND l.id=ct.lead_id WHERE ct.company_id=$1 AND ct.status IN ('draft','sent') AND ($2::text IS NULL OR l.segment=$2) AND EXISTS(SELECT 1 FROM tenant.contract_requirements r LEFT JOIN tenant.documents d ON d.company_id=r.company_id AND d.id=r.document_id WHERE r.company_id=ct.company_id AND r.contract_id=ct.id AND r.required AND (d.id IS NULL OR d.archived_at IS NOT NULL OR d.expires_date<$3::date))",
                dated,
              )
            ).rows[0].n,
            "/company/contracts",
          );
        }
        if (commissionsAvailable) {
          result.metrics.paidCommissionMtd = (
            await c.query(
              "SELECT coalesce(sum(m.gross_minor),0)::text AS amount FROM tenant.commissions m JOIN tenant.contracts ct ON ct.company_id=m.company_id AND ct.id=m.contract_id JOIN tenant.leads l ON l.company_id=ct.company_id AND l.id=ct.lead_id WHERE m.company_id=$1 AND m.status='paid' AND m.paid_date BETWEEN date_trunc('month',$3::date)::date AND $3::date AND ($2::text IS NULL OR l.segment=$2)",
              dated,
            )
          ).rows[0].amount;
          alert(
            "payable-commissions",
            (
              await c.query(
                "SELECT count(*)::int AS n FROM tenant.commissions m JOIN tenant.contracts ct ON ct.company_id=m.company_id AND ct.id=m.contract_id JOIN tenant.leads l ON l.company_id=ct.company_id AND l.id=ct.lead_id WHERE m.company_id=$1 AND m.status='payable' AND ($2::text IS NULL OR l.segment=$2)",
                params,
              )
            ).rows[0].n,
            "/company/commissions",
          );
        }
        if (can("reservations.read"))
          alert(
            "expiring-reservations",
            (
              await c.query(
                "SELECT count(*)::int AS n FROM tenant.reservations r JOIN tenant.leads l ON l.company_id=r.company_id AND l.id=r.lead_id WHERE r.company_id=$1 AND r.status IN ('hold','reserved') AND r.expires_at>now() AND r.expires_at<=now()+interval '24 hours' AND ($2::text IS NULL OR l.segment=$2)",
                params,
              )
            ).rows[0].n,
            "/company/reservations",
          );
        if (can("units.read")) {
          const rows = (
            await c.query(
              "SELECT status,count(*)::int AS n FROM tenant.inventory_units WHERE company_id=$1 AND archived_at IS NULL GROUP BY status",
              [p.companyId],
            )
          ).rows;
          result.inventory = Object.fromEntries(
            ["available", "hold", "reserved", "under_contract", "sold"].map(
              (k) => [k, rows.find((r) => r.status === k)?.n ?? 0],
            ),
          );
        }
        if (can("projects.read"))
          result.metrics.projects = (
            await c.query(
              "SELECT count(*)::int AS n FROM tenant.projects WHERE company_id=$1 AND archived_at IS NULL",
              [p.companyId],
            )
          ).rows[0].n;
        if (can("routing.read")) {
          result.worker = {
            healthy: !!worker?.healthy,
            lastSeenAt: worker?.seen_at
              ? new Date(worker.seen_at).toISOString()
              : null,
          };
          const enabled = (
            await c.query(
              "SELECT count(*)::int AS n FROM tenant.routing_rules WHERE company_id=$1 AND active AND archived_at IS NULL AND sla_minutes>0",
              [p.companyId],
            )
          ).rows[0].n;
          if (advancedAvailable && enabled && !worker?.healthy)
            alert("routing-worker", 1, "/company/lead-routing");
        }
        if (can("reports.read")) {
          const report = await this.reports.read(
            c,
            p.companyId!,
            "quarter",
            segment,
          );
          result.chart = report.volume;
          result.chartFrom = report.from;
        }
        return result;
      },
      true,
    );
  }
}
