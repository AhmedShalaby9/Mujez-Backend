import { seedReservations } from "../scripts/seed-reservations.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
let h, p, other, lead, unit, res;
const req = (b) => ({ requestId: randomUUID(), ...b });
const hold = (more = {}) =>
  req({
    unitId: unit.id,
    leadId: lead.id,
    unitVersion: unit.version,
    hours: 48,
    ...more,
  });
const action = (a, more = {}) =>
  h.post(
    "reservations/" + res.id + "/action",
    req({ version: res.version, action: a, ...more }),
  );
before(async () => {
  h = await tenantHarness();
  [p, other] = h.principals;
  lead = (
    await h.post(
      "leads",
      req({
        name: "Reservation buyer",
        phone: "+12025550190",
        segment: "res",
        want: "Apartment",
        source: "manual",
      }),
    )
  ).body;
  unit = (
    await h.post(
      "units",
      req({
        code: "RES-UNIT",
        listing: "resale",
        location: "Cairo",
        type: "apt",
        area: 140,
        view: "Garden",
        priceMinor: "100000000",
      }),
    )
  ).body;
});
after(async () => h.close());
test("reservations require company permissions and current subscription; caller cannot select company", async () => {
  await h.api().get("/api/v1/reservations").expect(401);
  h.state.principal = { ...p, pool: "platform" };
  await h.get("reservations", 403);
  h.state.principal = { ...p, permissions: ["reservations.read"] };
  await h.get("reservations");
  await h.post("reservations", hold(), 403);
  h.state.principal = p;
  await h.get("reservations?companyId=" + other.companyId, 400);
});
test("new holds lock a real unit, link a real lead, default actual assignee and replay without duplication", async () => {
  const b = hold();
  res = (await h.post("reservations", b)).body;
  assert.equal(res.status, "hold");
  assert.equal(res.unit, "RES-UNIT");
  assert.equal(res.assignee.id, p.id);
  assert.equal((await h.post("reservations", b)).body.id, res.id);
  assert.equal((await h.get("units/" + unit.id)).body.status, "hold");
  await h.post("reservations", hold(), 409);
  const current = (await h.get("units/" + unit.id)).body;
  await h.post("reservations", hold({ unitVersion: current.version }), 409);
  assert.equal((await h.get("projects")).body.total, 0);
});
test("cross-company reservation reads and links are rejected; runtime unique index prevents double bookings", async () => {
  h.state.principal = other;
  await h.get("reservations/" + res.id, 404);
  await h.post("reservations", hold(), 404);
  assert.equal((await h.get("reservations")).body.total, 0);
  h.state.principal = p;
  await assert.rejects(
    () =>
      h.database.tenant(p.companyId, (c) =>
        c.query(
          "INSERT INTO tenant.reservations(company_id,public_id,unit_id,lead_id,expires_at) VALUES($1,'DUPLICATE',$2,$3,now()+interval '2 hours')",
          [p.companyId, unit.id, lead.id],
        ),
      ),
    /one_active_reservation/,
  );
});
test("confirmation records exact manual deposit and changes inventory atomically without external collection", async () => {
  await h.post(
    "reservations/" + res.id + "/action",
    req({ version: res.version, action: "confirm" }),
    400,
  );
  await h.post(
    "reservations/" + res.id + "/action",
    req({ version: res.version, action: "confirm", depositMinor: null }),
    400,
  );
  res = (await action("confirm", { depositMinor: "900719925474099300" })).body;
  assert.equal(res.status, "reserved");
  assert.equal(res.depositMinor, "900719925474099300");
  assert.ok(res.confirmedAt);
  assert.equal((await h.get("units/" + unit.id)).body.status, "reserved");
  await h.post(
    "reservations/" + res.id + "/action",
    req({ version: 0, action: "confirm", depositMinor: "1" }),
    409,
  );
  await h.post(
    "reservations/" + res.id + "/action",
    req({ version: res.version, action: "confirm", depositMinor: "1" }),
    409,
  );
});
test("extension requires reason and bounded duration; cancellation releases unit and preserves deposit history", async () => {
  await h.post(
    "reservations/" + res.id + "/action",
    req({ version: res.version, action: "extend", hours: 48 }),
    400,
  );
  const before = Date.parse(res.expiresAt);
  res = (
    await action("extend", { hours: 24, reason: "Buyer needs another day" })
  ).body;
  assert.equal(Date.parse(res.expiresAt) - before, 86400000);
  res = (await action("cancel", { reason: "Buyer withdrew the request" })).body;
  assert.equal(res.status, "canceled");
  assert.equal(res.depositMinor, "900719925474099300");
  assert.equal((await h.get("units/" + unit.id)).body.status, "available");
  const timeline = (await h.get("leads/" + lead.id + "/activities")).body;
  assert.ok(timeline.items.some((a) => a.kind === "reservation.canceled"));
});
test("expiry is reflected immediately in reads and inventory, and a new hold persists expiry before reusing unit", async () => {
  unit = (await h.get("units/" + unit.id)).body;
  res = (await h.post("reservations", hold())).body;
  await h.db.query(
    "UPDATE tenant.reservations SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [res.id],
  );
  assert.equal((await h.get("reservations/" + res.id)).body.status, "expired");
  assert.equal((await h.get("reservations?status=expired")).body.total, 1);
  unit = (await h.get("units/" + unit.id)).body;
  assert.equal(unit.status, "available");
  const expiredId = res.id;
  res = (await h.post("reservations", hold())).body;
  assert.notEqual(res.id, expiredId);
  assert.equal(
    (
      await h.db.query("SELECT status FROM tenant.reservations WHERE id=$1", [
        expiredId,
      ])
    ).rows[0].status,
    "expired",
  );
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM tenant.audit_logs WHERE action='reservation.expired'",
      )
    ).rows[0].n,
    1,
  );
});
test("inventory edits after expiry succeed with the visible unit version, while active holds block edits", async () => {
  let u = (await h.get("units/" + unit.id)).body;
  const edit = (v) =>
    req({
      code: u.code,
      listing: "resale",
      location: "Cairo",
      type: "apt",
      area: 140,
      view: "Garden",
      priceMinor: "200000000",
      version: v,
    });
  await h.post("units/" + u.id + "/update", edit(u.version), 409);
  await h.db.query(
    "UPDATE tenant.reservations SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [res.id],
  );
  u = (await h.get("units/" + unit.id)).body;
  const updated = (await h.post("units/" + u.id + "/update", edit(u.version)))
    .body;
  assert.equal(updated.priceMinor, "200000000");
  assert.equal(updated.status, "available");
  unit = updated;
});
test("audit failure rolls back both reservation and unit; archived leads cannot be newly reserved", async () => {
  const b = hold();
  h.state.failAudit = true;
  await h.post("reservations", b, 500);
  h.state.failAudit = false;
  assert.equal((await h.get("units/" + unit.id)).body.status, "available");
  res = (await h.post("reservations", b)).body;
  assert.equal(res.status, "hold");
  await action("cancel", { reason: "Finish reservation verification" });
  await h.db.query("UPDATE tenant.leads SET archived_at=now() WHERE id=$1", [
    lead.id,
  ]);
  unit = (await h.get("units/" + unit.id)).body;
  await h.post("reservations", hold(), 400);
});

test("reservation seed creates labeled holds once and preserves cancellation and expiry on rerun", async () => {
  await h.db.exec("BEGIN");
  const first = await seedReservations(h.db, ["test-beta"]);
  await h.db.exec("COMMIT");
  assert.equal(first.reservationsCreated, 2);
  await h.db.query(
    "UPDATE tenant.reservations SET status='canceled',canceled_at=now() WHERE company_id=$1 AND seed_key='reservations-v1-1'",
    [other.companyId],
  );
  await h.db.exec("BEGIN");
  const repeat = await seedReservations(h.db, ["test-beta"]);
  await h.db.exec("COMMIT");
  assert.equal(repeat.reservationsCreated, 0);
  assert.equal(
    (
      await h.db.query(
        "SELECT status FROM tenant.reservations WHERE company_id=$1 AND seed_key='reservations-v1-1'",
        [other.companyId],
      )
    ).rows[0].status,
    "canceled",
  );
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM tenant.users")).rows[0].n,
    2,
  );
});
