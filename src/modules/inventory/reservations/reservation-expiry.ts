import type { PoolClient } from "pg";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
// Caller holds the company write lock. Lock the unit before its reservation.
export async function expireUnitReservations(
  c: PoolClient,
  companyId: string,
  unitId: string,
) {
  await c.query(
    "SELECT id FROM tenant.units WHERE company_id=$1 AND id=$2 FOR UPDATE",
    [companyId, unitId],
  );
  const rows = (
    await c.query(
      "SELECT * FROM tenant.reservations WHERE company_id=$1 AND unit_id=$2 AND status IN ('hold','reserved') AND expires_at<=now() FOR UPDATE",
      [companyId, unitId],
    )
  ).rows;
  for (const r of rows) {
    const row = (
      await c.query(
        "UPDATE tenant.reservations SET status='expired',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *",
        [companyId, r.id],
      )
    ).rows[0];
    await c.query(
      "UPDATE tenant.units SET status='available',updated_at=now() WHERE company_id=$1 AND id=$2 AND status IN ('hold','reserved')",
      [companyId, unitId],
    );
    await recordTenantEvent(c, {
      companyId,
      actorId: null,
      action: "reservation.expired",
      resourceType: "reservation",
      resourceId: r.id,
      before: { status: r.status },
      after: { status: "expired", expiresAt: r.expires_at },
      payload: {
        unitId,
        reservationId: r.id,
        expiredAt: r.expires_at,
        recognizedAt: row.updated_at,
      },
    });
    await c.query(
      "INSERT INTO tenant.lead_activities(company_id,lead_id,actor_id,kind,details) VALUES($1,$2,NULL,'reservation.expired',$3)",
      [
        companyId,
        r.lead_id,
        { reservationId: r.id, unitId, expiredAt: r.expires_at },
      ],
    );
  }
}
