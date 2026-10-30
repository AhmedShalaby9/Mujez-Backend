import { seedContractsDocuments } from "../scripts/seed-contracts-documents.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
let h, p, other, lead, unit, res, contract, doc;
const req = (b) => ({ requestId: randomUUID(), ...b });
const fields = () =>
  req({
    type: "sale",
    title: "Verification sale agreement",
    leadId: lead.id,
    reservationId: res.id,
    reservationVersion: res.version,
    unitVersion: unit.version,
    valueMinor: "900719925474099300",
    keyDate: "2027-11-01",
    signers: [
      { name: "Verification buyer", role: "Buyer" },
      { name: "Verification seller", role: "Seller" },
    ],
  });
function upload(
  b = {},
  content = Buffer.from("%PDF-1.4\nVerification fixture only\n"),
  name = "verification.pdf",
  mime = "application/pdf",
  status = 201,
) {
  let r = h
    .api()
    .post("/api/v1/documents")
    .set("Origin", h.origin)
    .set("Cookie", "__Host-mujez_session=" + "a".repeat(64));
  for (const [k, v] of Object.entries(b))
    if (v !== undefined && v !== null) r = r.field(k, String(v));
  return r
    .attach("file", content, { filename: name, contentType: mime })
    .expect(status);
}
before(async () => {
  h = await tenantHarness();
  [p, other] = h.principals;
  lead = (
    await h.post(
      "leads",
      req({
        name: "Contract verification buyer",
        phone: "+12025550191",
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
        code: "CONTRACT-UNIT",
        listing: "resale",
        location: "Cairo",
        type: "apt",
        area: 140,
        view: "Garden",
        priceMinor: "100000000",
      }),
    )
  ).body;
  res = (
    await h.post(
      "reservations",
      req({
        unitId: unit.id,
        leadId: lead.id,
        unitVersion: unit.version,
        hours: 48,
      }),
    )
  ).body;
  res = (
    await h.post(
      "reservations/" + res.id + "/action",
      req({ version: res.version, action: "confirm", depositMinor: "10000" }),
    )
  ).body;
  unit = (await h.get("units/" + unit.id)).body;
});
after(async () => h.close());
test("finance modules enforce authenticated company scope and independent permissions", async () => {
  await h.api().get("/api/v1/contracts").expect(401);
  h.state.principal = { ...p, pool: "platform" };
  await h.get("documents", 403);
  h.state.principal = {
    ...p,
    permissions: ["contracts.read", "documents.read"],
  };
  await h.get("contracts");
  await h.get("documents");
  await h.post("contracts", fields(), 403);
  h.state.principal = p;
  await h.get("contracts?companyId=" + other.companyId, 400);
});
test("sale contracts atomically convert confirmed reservations and preserve exact values", async () => {
  const b = fields();
  contract = (await h.post("contracts", b)).body;
  assert.equal(contract.valueMinor, b.valueMinor);
  assert.equal(contract.reservationId, res.id);
  assert.equal(
    (await h.get("reservations/" + res.id)).body.status,
    "converted",
  );
  assert.equal((await h.get("units/" + unit.id)).body.status, "under_contract");
  assert.equal((await h.post("contracts", b)).body.id, contract.id);
  await h.post("contracts", fields(), 409);
  assert.equal(
    (await h.get("contracts/" + contract.id)).body.requirements.length,
    1,
  );
});
test("draft edits are versioned; sharing records external reference without pretending to send", async () => {
  const f = fields();
  contract = (
    await h.post(
      "contracts/" + contract.id + "/update",
      req({
        version: contract.version,
        title: "Edited verification agreement",
        valueMinor: f.valueMinor,
        keyDate: f.keyDate,
        signers: f.signers,
      }),
    )
  ).body;
  await h.post(
    "contracts/" + contract.id + "/update",
    req({
      version: 0,
      title: "Stale agreement",
      valueMinor: "1",
      keyDate: f.keyDate,
      signers: f.signers,
    }),
    409,
  );
  contract = (
    await h.post(
      "contracts/" + contract.id + "/action",
      req({
        version: contract.version,
        action: "record_shared",
        reason: "Recorded manual sharing for verification",
        reference: "verification-only-external-reference",
      }),
    )
  ).body;
  assert.equal(contract.status, "sent");
  assert.ok(contract.sharedAt);
});
test("real files upload, replay and download byte-for-byte; unsupported content and forged links fail", async () => {
  const b = req({
    kind: "contract",
    title: "Verification signed evidence",
    contractId: contract.id,
  });
  doc = (await upload(b)).body;
  assert.equal((await upload(b)).body.id, doc.id);
  await upload(
    b,
    Buffer.from("%PDF-1.4\nChanged fixture\n"),
    "verification.pdf",
    "application/pdf",
    409,
  );
  assert.equal(doc.contractId, contract.id);
  assert.equal(doc.leadId, lead.id);
  const response = await h.get("documents/" + doc.id + "/download");
  assert.equal(
    createHash("sha256").update(response.body).digest("hex"),
    doc.sha256,
  );
  assert.match(response.headers["content-disposition"], /^attachment/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.ok(!("content" in (await h.get("documents")).body.items[0]));
  await upload(
    req({ kind: "other", title: "Executable rejected" }),
    Buffer.from("MZfake"),
    "bad.exe",
    "application/octet-stream",
    400,
  );
  await upload(
    req({ kind: "other", title: "Foreign contract", contractId: randomUUID() }),
    undefined,
    undefined,
    undefined,
    400,
  );
  await h.post("documents", req({ kind: "other", title: "Missing file" }), 400);
});
test("company isolation protects metadata, binaries and contract evidence attachments", async () => {
  h.state.principal = other;
  await h.get("contracts/" + contract.id, 404);
  await h.get("documents/" + doc.id, 404);
  await h.get("documents/" + doc.id + "/download", 404);
  await upload(
    req({ kind: "contract", title: "Foreign link", contractId: contract.id }),
    undefined,
    undefined,
    undefined,
    400,
  );
  assert.equal((await h.get("documents")).body.total, 0);
  h.state.principal = p;
  const d = (await h.get("contracts/" + contract.id)).body;
  await h.post(
    "contracts/" +
      contract.id +
      "/requirements/" +
      d.requirements[0].id +
      "/attach",
    req({ version: d.version, documentId: randomUUID() }),
    400,
  );
});
test("manual signature requires matching current evidence and satisfied requirements, then updates inventory", async () => {
  const today = (
    await h.db.query(
      "SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS d",
    )
  ).rows[0].d;
  await h.post(
    "contracts/" + contract.id + "/action",
    req({
      version: contract.version,
      action: "record_signed",
      signedDate: today,
      documentId: doc.id,
      reason: "Record external signature fixture only",
    }),
    409,
  );
  let d = (await h.get("contracts/" + contract.id)).body;
  d = (
    await h.post(
      "contracts/" +
        contract.id +
        "/requirements/" +
        d.requirements[0].id +
        "/attach",
      req({ version: d.version, documentId: doc.id }),
    )
  ).body;
  assert.equal(d.requirements[0].satisfied, true);
  contract = (
    await h.post(
      "contracts/" + contract.id + "/action",
      req({
        version: d.version,
        action: "record_signed",
        signedDate: today,
        documentId: doc.id,
        reason: "Record external signature fixture only",
      }),
    )
  ).body;
  assert.equal(contract.storedStatus, "signed");
  assert.equal(contract.signedDocumentId, doc.id);
  assert.equal((await h.get("units/" + unit.id)).body.status, "sold");
  await h.post(
    "documents/" + doc.id + "/archive",
    req({ version: doc.version, action: "archive" }),
    409,
  );
});
test("voiding records reason and releases converted inventory; archived files retain bytes", async () => {
  contract = (
    await h.post(
      "contracts/" + contract.id + "/action",
      req({
        version: contract.version,
        action: "void",
        reason: "Verification agreement was fictional and is void",
      }),
    )
  ).body;
  assert.equal(contract.status, "void");
  assert.equal((await h.get("units/" + unit.id)).body.status, "available");
  doc = (
    await h.post(
      "documents/" + doc.id + "/archive",
      req({ version: doc.version, action: "archive" }),
    )
  ).body;
  assert.ok(doc.archivedAt);
  assert.equal((await h.get("documents")).body.total, 0);
  assert.equal((await h.get("documents?archived=all")).body.total, 1);
  await h.get("documents/" + doc.id + "/download");
});
test("storage quotas use retained actual bytes and current overrides; audit failure rolls upload back", async () => {
  await h.db.exec(`UPDATE platform.plan_versions SET limits='{"storageGb":0}'`);
  const b = req({ kind: "other", title: "Quota verification" });
  await upload(b, undefined, undefined, undefined, 409);
  await h.db.query(
    "INSERT INTO platform.limit_overrides(company_id,resource,limit_value,expires_at,reason) VALUES($1,'storage',1,now()+interval '1 day','Storage quota verification')",
    [p.companyId],
  );
  h.state.failAudit = true;
  await upload(b, undefined, undefined, undefined, 500);
  h.state.failAudit = false;
  assert.equal((await h.get("documents?archived=all")).body.total, 1);
  await upload(b);
  assert.equal((await h.get("documents?archived=all")).body.total, 2);
  const bytes = (
    await h.db.query(
      "SELECT bytes::text AS b FROM platform.company_storage_counts WHERE company_id=$1",
      [p.companyId],
    )
  ).rows[0].b;
  assert.equal((await h.get("documents")).body.storageBytes, bytes);
  const audits = (
    await h.db.query(
      "SELECT after,payload FROM tenant.audit_logs a LEFT JOIN tenant.outbox_events o ON o.aggregate_id=a.resource_id WHERE a.action='document.uploaded'",
    )
  ).rows;
  assert.ok(!JSON.stringify(audits).includes("Verification fixture only"));
});

test("finance seed creates real sample bytes and draft agreements once without fake signatures or identities", async () => {
  await h.db.exec(`UPDATE platform.plan_versions SET limits='{}'`);
  await h.db.exec("BEGIN");
  const first = await seedContractsDocuments(h.db, ["test-beta"]);
  await h.db.exec("COMMIT");
  assert.equal(first.contractsCreated, 1);
  assert.equal(first.documentsCreated, 1);
  await h.db.query(
    "UPDATE tenant.documents SET archived_at=now() WHERE company_id=$1",
    [other.companyId],
  );
  await h.db.exec("BEGIN");
  const repeat = await seedContractsDocuments(h.db, ["test-beta"]);
  await h.db.exec("COMMIT");
  assert.equal(repeat.contractsCreated, 0);
  assert.equal(repeat.documentsCreated, 0);
  const c = (
    await h.db.query("SELECT * FROM tenant.contracts WHERE company_id=$1", [
      other.companyId,
    ])
  ).rows[0];
  assert.equal(c.status, "draft");
  assert.equal(c.signed_document_id, null);
  const d = (
    await h.db.query("SELECT * FROM tenant.documents WHERE company_id=$1", [
      other.companyId,
    ])
  ).rows[0];
  assert.ok(d.archived_at);
  assert.equal(createHash("sha256").update(d.content).digest("hex"), d.sha256);
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM tenant.users")).rows[0].n,
    2,
  );
});

test("stored bytes and requirement definitions are immutable to the runtime database role", async () => {
  await assert.rejects(
    () =>
      h.database.tenant(p.companyId, (c) =>
        c.query("UPDATE tenant.documents SET content=$2 WHERE id=$1", [
          doc.id,
          Buffer.from("altered"),
        ]),
      ),
    /permission denied/,
  );
  await assert.rejects(
    () =>
      h.database.tenant(p.companyId, (c) =>
        c.query(
          "UPDATE tenant.contract_requirements SET required=false WHERE company_id=$1",
          [p.companyId],
        ),
      ),
    /permission denied/,
  );
});
