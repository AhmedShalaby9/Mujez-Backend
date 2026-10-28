import { auditContext } from "../../common/http/audit-context.js";
import { sanitizeAudit, severityFor } from "./audit-sanitize.js";
import type { PoolClient } from "pg";
export interface DomainEvent {
  companyId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  payload: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}
/** Call inside DatabaseService.tenant alongside the business mutation. Never after commit. */
export async function recordTenantEvent(
  client: PoolClient,
  event: DomainEvent,
): Promise<void> {
  await client.query(
    `INSERT INTO tenant.audit_logs (company_id, actor_user_id, action, resource_type, resource_id, before, after, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      event.companyId,
      event.actorId,
      event.action,
      event.resourceType,
      event.resourceId,
      sanitizeAudit(event.before ?? null),
      sanitizeAudit(event.after ?? null),
      event.ip ?? auditContext.getStore()?.ip ?? null,
      event.userAgent ?? null,
    ],
  );
  await client.query(
    `INSERT INTO tenant.outbox_events (company_id, kind, aggregate_type, aggregate_id, payload) VALUES ($1,$2,$3,$4,$5)`,
    [
      event.companyId,
      event.action,
      event.resourceType,
      event.resourceId,
      sanitizeAudit(event.payload),
    ],
  );
}
/** Call inside DatabaseService.platform alongside the platform mutation. */
export async function recordPlatformEvent(
  client: PoolClient,
  event: Omit<DomainEvent, "companyId"> & { companyId?: string },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.audit_logs (actor_platform_user_id, action, company_id, resource, resource_id, before, after, result, severity, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,'success',$8,$9)`,
    [
      event.actorId,
      event.action,
      event.companyId ?? null,
      event.resourceType,
      event.resourceId,
      sanitizeAudit(event.before ?? null),
      sanitizeAudit(event.after ?? null),
      severityFor(event.action),
      event.ip ?? auditContext.getStore()?.ip ?? null,
    ],
  );
  await client.query(
    `INSERT INTO platform.outbox_events (company_id, kind, aggregate_type, aggregate_id, payload) VALUES ($1,$2,$3,$4,$5)`,
    [
      event.companyId ?? null,
      event.action,
      event.resourceType,
      event.resourceId,
      sanitizeAudit(event.payload),
    ],
  );
}
