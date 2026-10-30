import { seedCommissions } from "../scripts/seed-commissions.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { commissionAmounts } from "../dist/modules/finance/commissions/commissions.service.js";
let h, p, other, lead, ct, m, receipt;
const req = (b) => ({ requestId: randomUUID(), ...b });
function input(more = {}) {
  return req({
    contractId: ct.id,
    contractVersion: ct.version,
    rateBps: 250,
    splits: [
      { payeeId: p.id, shareBps: 4000 },
      { payeeId: null, shareBps: 6000 },
    ],
    ...more,
  });
}
function upload(kind, contractId) {
  return h
    .api()
    .post("/api/v1/documents")
    .set("Origin", h.origin)
    .set("Cookie", "__Host-mujez_session=" + "a".repeat(64))
    .field("requestId", randomUUID())
    .field("kind", kind)
    .field("title", "Verification evidence only")
    .field("contractId", contractId)
    .attach("file", Buffer.from("%PDF-1.4\nVerification only\n"), {
      filename: "verification.pdf",
      contentType: "application/pdf",
    })
    .expect(201);
}
before(async () => {
  h = await tenantHarness();
  [p, other] = h.principals;
  lead = (
    await h.post(
      "leads",
      req({
        name: "Commission buyer",
        phone: "+12025550192",
        segment: "res",
        want: "Apartment",
        source: "manual",
      }),
    )
  ).body;
  ct = (
    await h.post(
      "contracts",
      req({
        type: "broker_agreement",
        leadId: lead.id,
        title: "Commission agreement",
        valueMinor: "900719925474099300",
        keyDate: "2027-11-01",
        signers: [{ name: "Verification client", role: "Client" }],
      }),
    )
  ).body;
});
after(async () => h.close());
test("commission rounding uses exact integers and allocates residual minor units deterministically", () => {
  assert.deepEqual(commissionAmounts("101", 5000, [5000, 5000]), {
    grossMinor: "51",
    amounts: ["26", "25"],
  });
  const large = commissionAmounts(
    "999999999999999999",
    10000,
    [3333, 3333, 3334],
  );
  assert.equal(large.grossMinor, "999999999999999999");
  assert.equal(
    large.amounts.reduce((a, v) => a + BigInt(v), 0n),
    999999999999999999n,
  );
  assert.throws(() => commissionAmounts("100", 250, [9999]));
});
test("commission endpoints enforce identity, scope, permissions and real company payees", async () => {
  await h.api().get("/api/v1/commissions").expect(401);
  h.state.principal = { ...p, pool: "platform" };
  await h.get("commissions", 403);
  h.state.principal = { ...p, permissions: ["commissions.read"] };
  await h.get("commissions");
  await h.post("commissions", input(), 403);
  h.state.principal = p;
  await h.post(
    "commissions",
    input({ splits: [{ payeeId: other.id, shareBps: 10000 }] }),
    400,
  );
  await h.post(
    "commissions",
    input({
      splits: [
        { payeeId: p.id, shareBps: 5000 },
        { payeeId: p.id, shareBps: 5000 },
      ],
    }),
    400,
  );
  await h.post("commissions", input({ rateBps: 0 }), 400);
});
test("calculation snapshots actual contract value and payees and replays safely as a draft forecast", async () => {
  const b = input();
  m = (await h.post("commissions", b)).body;
  assert.equal(m.forecast, true);
  assert.equal(m.status, "calculated");
  assert.equal(m.agreedValueMinor, "900719925474099300");
  assert.equal(m.lines[0].who.en, p.name);
  assert.equal(
    m.lines.reduce((sum, l) => sum + BigInt(l.amountMinor), 0n),
    BigInt(m.grossMinor),
  );
  assert.equal((await h.post("commissions", b)).body.id, m.id);
  await h.post("commissions", input(), 409);
  await h.post(
    "commissions/" + m.id + "/action",
    req({
      version: m.version,
      action: "approve",
      reason: "Unsigned contract cannot be approved",
    }),
    409,
  );
});
test("cross-company records and forged payees stay isolated", async () => {
  h.state.principal = other;
  await h.get("commissions/" + m.id, 404);
  await h.post("commissions", input(), 400);
  assert.equal((await h.get("commissions")).body.total, 0);
  h.state.principal = p;
});
test("changed contract terms require a fresh calculation, including after signing", async () => {
  ct = (
    await h.post(
      "contracts/" + ct.id + "/update",
      req({
        version: ct.version,
        title: "Updated commission agreement",
        valueMinor: "101",
        keyDate: "2027-11-01",
        signers: [{ name: "Verification client", role: "Client" }],
      }),
    )
  ).body;
  assert.equal(
    (await h.get("commissions/" + m.id)).body.needsRecalculation,
    true,
  );
  let d = (await h.get("contracts/" + ct.id)).body;
  const doc = (await upload("contract", ct.id)).body;
  d = (
    await h.post(
      "contracts/" +
        ct.id +
        "/requirements/" +
        d.requirements[0].id +
        "/attach",
      req({ version: d.version, documentId: doc.id }),
    )
  ).body;
  const today = (await h.get("tasks")).body.today;
  ct = (
    await h.post(
      "contracts/" + ct.id + "/action",
      req({
        version: d.version,
        action: "record_signed",
        signedDate: today,
        documentId: doc.id,
        reason: "Verification external signature only",
      }),
    )
  ).body;
  await h.post(
    "commissions/" + m.id + "/action",
    req({
      version: m.version,
      action: "approve",
      reason: "Stale values must not be approved",
    }),
    409,
  );
  m = (
    await h.post(
      "commissions/" + m.id + "/recalculate",
      input({
        version: m.version,
        rateBps: 5000,
        splits: [{ payeeId: null, shareBps: 10000 }],
      }),
    )
  ).body;
  assert.equal(m.grossMinor, "51");
  m = (
    await h.post(
      "commissions/" + m.id + "/action",
      req({
        version: m.version,
        action: "approve",
        reason: "Approve current signed agreement",
      }),
    )
  ).body;
  assert.equal(m.status, "approved");
  assert.ok(m.approvedAt);
});
test("payable and paid records require real receipt evidence and external references, never initiate transfers", async () => {
  await h.post(
    "commissions/" + m.id + "/action",
    req({
      version: m.version,
      action: "mark_payable",
      reason: "Receipt evidence is required",
    }),
    400,
  );
  receipt = (await upload("receipt", ct.id)).body;
  m = (
    await h.post(
      "commissions/" + m.id + "/action",
      req({
        version: m.version,
        action: "mark_payable",
        documentId: receipt.id,
        reason: "Receipt evidence reviewed manually",
      }),
    )
  ).body;
  assert.equal(m.status, "payable");
  await h.post(
    "documents/" + receipt.id + "/archive",
    req({ version: receipt.version, action: "archive" }),
    409,
  );
  await h.post(
    "contracts/" + ct.id + "/action",
    req({
      version: ct.version,
      action: "void",
      reason: "Cannot void payable commission",
    }),
    409,
  );
  await h.post(
    "commissions/" + m.id + "/action",
    req({
      version: m.version,
      action: "record_paid",
      documentId: receipt.id,
      reason: "Missing actual paid date and reference",
    }),
    400,
  );
  const today = (await h.get("tasks")).body.today;
  m = (
    await h.post(
      "commissions/" + m.id + "/action",
      req({
        version: m.version,
        action: "record_paid",
        documentId: receipt.id,
        paidDate: today,
        reference: "verification-manual-reference",
        reason: "Record external payment fixture only",
      }),
    )
  ).body;
  assert.equal(m.status, "paid");
  assert.equal(m.paymentReference, "verification-manual-reference");
  await h.post(
    "commissions/" + m.id + "/action",
    req({
      version: m.version,
      action: "cancel",
      reason: "Paid records cannot be canceled",
    }),
    409,
  );
  await h.post(
    "contracts/" + ct.id + "/action",
    req({
      version: ct.version,
      action: "void",
      reason: "Paid commission requires reversal",
    }),
    409,
  );
});
test("voiding draft contracts cancels forecasts atomically and canceled records can be revised only for active contracts", async () => {
  let draft = (
    await h.post(
      "contracts",
      req({
        type: "broker_agreement",
        leadId: lead.id,
        title: "Second draft agreement",
        valueMinor: "10000",
        keyDate: "2027-11-01",
        signers: [{ name: "Verification client", role: "Client" }],
      }),
    )
  ).body;
  let forecast = (
    await h.post(
      "commissions",
      input({ contractId: draft.id, contractVersion: draft.version }),
    )
  ).body;
  forecast = (
    await h.post(
      "commissions/" + forecast.id + "/action",
      req({
        version: forecast.version,
        action: "cancel",
        reason: "Cancel forecast for correction",
      }),
    )
  ).body;
  forecast = (
    await h.post(
      "commissions/" + forecast.id + "/recalculate",
      input({
        contractId: draft.id,
        contractVersion: draft.version,
        version: forecast.version,
      }),
    )
  ).body;
  assert.equal(forecast.status, "calculated");
  h.state.failAudit = true;
  await h.post(
    "contracts/" + draft.id + "/action",
    req({
      version: draft.version,
      action: "void",
      reason: "Failure must roll everything back",
    }),
    500,
  );
  h.state.failAudit = false;
  assert.equal(
    (await h.get("commissions/" + forecast.id)).body.status,
    "calculated",
  );
  await h.post(
    "contracts/" + draft.id + "/action",
    req({
      version: draft.version,
      action: "void",
      reason: "Voiding draft cancels forecast",
    }),
  );
  assert.equal(
    (await h.get("commissions/" + forecast.id)).body.status,
    "canceled",
  );
});

test("commission seed creates one labeled calculated forecast and preserves it on rerun", async () => {
  await h.db.exec("BEGIN");
  const first = await seedCommissions(h.db, ["test-beta"]);
  await h.db.exec("COMMIT");
  assert.equal(first.commissionsCreated, 1);
  const row = (
    await h.db.query("SELECT * FROM tenant.commissions WHERE company_id=$1", [
      other.companyId,
    ])
  ).rows[0];
  assert.equal(row.status, "calculated");
  assert.equal(row.paid_at, null);
  await h.db.query(
    "UPDATE tenant.commissions SET status='canceled',reason='Preserve edited seed' WHERE id=$1",
    [row.id],
  );
  await h.db.exec("BEGIN");
  const repeat = await seedCommissions(h.db, ["test-beta"]);
  await h.db.exec("COMMIT");
  assert.equal(repeat.commissionsCreated, 0);
  assert.equal(
    (
      await h.db.query("SELECT status FROM tenant.commissions WHERE id=$1", [
        row.id,
      ])
    ).rows[0].status,
    "canceled",
  );
});
test("effective commission feature gates enforce the global switch, plan matrix, expiring overrides and company availability", async () => {
  await h.db.exec(
    "UPDATE platform.features SET platform_on=false WHERE key='commissions'",
  );
  await h.get("commissions", 403);
  await h.db.exec(
    "UPDATE platform.features SET platform_on=true WHERE key='commissions';UPDATE platform.feature_plans SET enabled=false WHERE feature_key='commissions'",
  );
  await h.get("commissions", 403);
  await h.db.query(
    "INSERT INTO platform.feature_overrides(company_id,feature_key,enabled,expires_at,reason) VALUES($1,'commissions',true,now()+interval '1 day','Feature override verification')",
    [p.companyId],
  );
  await h.get("commissions");
  await h.db.exec(
    "UPDATE platform.features SET platform_on=false WHERE key='commissions'",
  );
  await h.get("commissions", 403);
  await h.db.exec(
    "UPDATE platform.features SET platform_on=true WHERE key='commissions';UPDATE platform.feature_plans SET enabled=true WHERE feature_key='commissions'",
  );
  await h.db.query(
    "UPDATE platform.feature_overrides SET enabled=false WHERE company_id=$1 AND feature_key='commissions'",
    [p.companyId],
  );
  await h.get("commissions", 403);
  await h.db.query(
    "UPDATE platform.feature_overrides SET expires_at=now()-interval '1 day' WHERE company_id=$1 AND feature_key='commissions'",
    [p.companyId],
  );
  await h.get("commissions");
  await h.db.query(
    "UPDATE platform.companies SET status='pending' WHERE id=$1",
    [p.companyId],
  );
  await h.get("commissions", 403);
  await h.db.query("UPDATE platform.companies SET status='trial' WHERE id=$1", [
    p.companyId,
  ]);
  const view = await h.database.tenant(p.companyId, (c) =>
    c.query("SELECT DISTINCT company_id FROM platform.company_feature_access"),
  );
  assert.deepEqual(
    view.rows.map((r) => r.company_id),
    [p.companyId],
  );
});
