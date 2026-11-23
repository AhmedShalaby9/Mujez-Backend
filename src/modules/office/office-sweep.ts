import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import { recordTenantEvent } from "../../infrastructure/outbox/domain-events.js";
/** Runs independently of the Finance module flag. All dates are Cairo dates. */
export async function runOfficeSweep(
  db: DatabaseService,
  stopping = () => false,
) {
  let cursor: string | null = null,
    companies = 0,
    notified = 0,
    released = 0,
    failed = 0;
  while (!stopping()) {
    const batch = await db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT company_id FROM platform.office_rental_companies WHERE ($1::uuid IS NULL OR company_id>$1) ORDER BY company_id LIMIT 50",
            [cursor],
          )
        ).rows,
    );
    if (!batch.length) break;
    for (const co of batch) {
      if (stopping()) break;
      let result: { sent: number; ended: number };
      try {
        result = await db.tenant(co.company_id, async (c) => {
          await c.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,80425113))",
            ["sales:" + co.company_id],
          );
          const rentals = (
            await c.query(
              "SELECT d.*,p.code AS property_code,d.lease_end::text AS end_date,(d.lease_end<=(now() AT TIME ZONE 'Africa/Cairo')::date) AS ended FROM tenant.office_deals d JOIN tenant.office_properties p ON p.company_id=d.company_id AND p.id=d.property_id WHERE d.company_id=$1 AND d.status='rented' AND d.lease_end<=(now() AT TIME ZONE 'Africa/Cairo')::date+15 AND NOT EXISTS(SELECT 1 FROM tenant.office_lease_notifications n WHERE n.company_id=d.company_id AND n.deal_id=d.id AND n.lease_revision=d.lease_revision AND n.kind=CASE WHEN d.lease_end<=(now() AT TIME ZONE 'Africa/Cairo')::date THEN 'available' ELSE 'expiring' END) ORDER BY d.lease_end,d.id LIMIT 500 FOR UPDATE OF d,p",
              [co.company_id],
            )
          ).rows;
          let sent = 0,
            ended = 0;
          for (const r of rentals) {
            const kind = r.ended ? "available" : "expiring";
            const event = (
              await c.query(
                "INSERT INTO tenant.office_lease_notifications(company_id,deal_id,lease_revision,kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id",
                [co.company_id, r.id, r.lease_revision, kind],
              )
            ).rows[0];
            if (!event) continue;
            if (r.ended) {
              await c.query(
                "UPDATE tenant.office_deals SET status='ended',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2",
                [co.company_id, r.id],
              );
              await c.query(
                "UPDATE tenant.office_properties SET status='available',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 AND status='rented'",
                [co.company_id, r.property_id],
              );
              ended++;
            }
            const title = r.ended
              ? `Unit ${r.property_code} is available again · الوحدة متاحة مجددًا`
              : `Lease ending ${r.end_date} · Unit ${r.property_code} · عقد إيجار ينتهي قريبًا`;
            const n = await c.query(
              `INSERT INTO tenant.notifications(company_id,user_id,event_id,kind,required_permission,title,route) SELECT u.company_id,u.id,$2,$3,'units.read',$4,$5 FROM tenant.users u LEFT JOIN platform.team_employee_status a ON a.company_id=u.company_id AND a.user_id=u.id WHERE u.company_id=$1 AND u.status='active' AND u.deleted_at IS NULL AND (u.identity_pool='company_admin' OR a.status='active') AND EXISTS(SELECT 1 FROM tenant.roles ro WHERE ro.company_id=u.company_id AND 'units.read'=ANY(ro.permissions) AND (ro.key IN ('agent','team_lead','company_owner') OR ro.scope='company') AND (ro.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles ar WHERE ar.company_id=u.company_id AND ar.user_id=u.id AND ar.role_id=ro.id))) ON CONFLICT DO NOTHING`,
              [
                co.company_id,
                event.event_id,
                "office.lease." + kind,
                title,
                "/company/office/properties?propertyId=" + r.property_id,
              ],
            );
            sent += n.rowCount ?? 0;
            await recordTenantEvent(c, {
              companyId: co.company_id,
              actorId: null,
              action: "office.lease." + kind,
              resourceType: "office_property",
              resourceId: r.property_id,
              after: { leaseEnd: r.end_date },
              payload: { propertyId: r.property_id },
            });
          }
          return { sent, ended };
        });
      } catch {
        failed++;
        cursor = co.company_id;
        continue;
      }
      companies++;
      notified += result.sent;
      released += result.ended;
      cursor = co.company_id;
    }
  }
  return { companies, notified, released, failed };
}
