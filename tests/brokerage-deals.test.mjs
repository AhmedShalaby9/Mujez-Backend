import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";

let h, owner, agent, leadId, developer, project;
const details = {
  developerSalesperson: "Developer rep",
  developerSalespersonMobile: "+201000000001",
  area: 120,
  finishing: "Finished",
  deliveryYears: 2,
  paymentPlanYears: 6,
  downPaymentPercent: 10,
  expectedContractDate: "2026-12-20",
  reservationPrice: 8000000,
  reservationDate: "2026-11-26",
};
const document = {
  kind: "contract",
  fileName: "contract.pdf",
  mimeType: "application/pdf",
  data: Buffer.from("%PDF-1.4\nexample").toString("base64"),
};
const deal = (extra = {}) => ({
  requestId: randomUUID(),
  leadId,
  agentId: agent.id,
  clientName: "Actual buyer",
  clientPhone: "+201000000002",
  sellingType: "primary",
  status: "contracted",
  developerId: developer.id,
  projectId: project.id,
  unitValueMinor: "8000000",
  details,
  documents: [document],
  ...extra,
});

before(async () => {
  h = await tenantHarness();
  owner = { ...h.principals[0], company: { type: "brokerage" } };
  await h.db.query(
    "UPDATE platform.companies SET company_type='brokerage' WHERE id=$1",
    [owner.companyId],
  );
  const role = (
    await h.db.query(
      "INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES($1,'agent','{}',ARRAY['leads.read','leads.manage'],'own') RETURNING id",
      [owner.companyId],
    )
  ).rows[0].id;
  const id = (
    await h.db.query(
      "INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES($1,$2,'company_user','Agent','agent@deals.test',$3,'active') RETURNING id",
      [owner.companyId, "deal-agent", role],
    )
  ).rows[0].id;
  agent = {
    ...owner,
    id,
    pool: "company_user",
    role: "agent",
    scope: "own",
    permissions: ["leads.read", "leads.manage"],
    name: "Agent",
  };
  leadId = (
    await h.db.query(
      'INSERT INTO tenant.leads(company_id,public_id,name,phone,segment,want,source,owner_user_id,brokerage_status) VALUES($1,\'L-DEAL\',\'{"en":"Lead","ar":"Lead"}\',\'+201000000003\',\'res\',\'{"en":"Apartment","ar":"Apartment"}\',\'manual\',$2,\'potential\') RETURNING id',
      [owner.companyId, id],
    )
  ).rows[0].id;
  h.state.principal = owner;
  developer = (
    await h.post("brokerage/developers", {
      requestId: randomUUID(),
      name: "Developer A",
    })
  ).body;
  project = (
    await h.post("brokerage/projects", {
      requestId: randomUUID(),
      developerId: developer.id,
      code: "DEALPROJ",
      name: "Project A",
      location: "Cairo",
      segment: "res",
    })
  ).body;
});
after(async () => h.close());

test("sales deal waits for admin approval; approved contracted deal closes the lead", async () => {
  h.state.principal = agent;
  assert.equal(
    (await h.get("brokerage/deals/leads?search=Lead")).body[0].id,
    leadId,
  );
  await h.post(
    "brokerage/deals",
    deal({ sellingType: "resale", status: "eoi" }),
    400,
  );
  await h.post("brokerage/deals", deal({ documents: [] }), 400);
  const created = (await h.post("brokerage/deals", deal())).body;
  assert.equal(created.approvalStatus, "pending");
  assert.equal(
    (
      await h.db.query(
        "SELECT brokerage_status FROM tenant.leads WHERE id=$1",
        [leadId],
      )
    ).rows[0].brokerage_status,
    "potential",
  );
  await h.post(
    `brokerage/deals/${created.id}/decision`,
    { requestId: randomUUID(), version: 0, decision: "approved" },
    403,
  );
  h.state.principal = owner;
  const approved = (
    await h.post(`brokerage/deals/${created.id}/decision`, {
      requestId: randomUUID(),
      version: 0,
      decision: "approved",
    })
  ).body;
  assert.equal(approved.approvalStatus, "approved");
  assert.equal(
    (
      await h.db.query(
        "SELECT brokerage_status,stage FROM tenant.leads WHERE id=$1",
        [leadId],
      )
    ).rows[0].brokerage_status,
    "closed_deal",
  );
  h.state.principal = agent;
  const unchanged = (
    await h.post(`brokerage/deals/${created.id}/update`, {
      ...deal({ documents: [] }),
      version: 0,
    })
  ).body;
  assert.equal(unchanged.approvalStatus, "approved");
  assert.equal(unchanged.version, 0);
  const edited = (
    await h.post(`brokerage/deals/${created.id}/update`, {
      ...deal({ clientName: "Buyer changed", documents: [] }),
      version: 0,
    })
  ).body;
  assert.equal(edited.approvalStatus, "pending");
  h.state.principal = owner;
  await h.post(
    `brokerage/deals/${created.id}/decision`,
    { requestId: randomUUID(), version: 0, decision: "approved" },
    409,
  );
  const rejected = (
    await h.post(`brokerage/deals/${created.id}/decision`, {
      requestId: randomUUID(),
      version: 1,
      decision: "rejected",
      reason: "Wrong buyer details",
    })
  ).body;
  assert.equal(rejected.approvalStatus, "rejected");
  const adminCreated = (
    await h.post("brokerage/deals", deal({ status: "reservation" }))
  ).body;
  assert.equal(adminCreated.approvalStatus, "approved");
  const adminEdited = (
    await h.post(`brokerage/deals/${created.id}/update`, {
      ...deal({ clientName: "Corrected buyer", documents: [] }),
      version: 1,
    })
  ).body;
  assert.equal(adminEdited.approvalStatus, "approved");
  await h.post(
    `brokerage/developers/${developer.id}/archive`,
    { requestId: randomUUID(), version: 0 },
    409,
  );
  const renamed = (
    await h.post(`brokerage/developers/${developer.id}/update`, {
      requestId: randomUUID(),
      name: "Developer B",
      version: 0,
    })
  ).body;
  assert.equal(renamed.name, "Developer B");
  assert.equal(
    (await h.get(`brokerage/deals/${created.id}`)).body.developer,
    "Developer B",
  );
  assert.equal(
    (await h.get(`brokerage/deals/${created.id}`)).body.documents.length,
    1,
  );
});

test("Sales Admin assigned as an additional role can approve a deal", async () => {
  h.state.principal = agent;
  const created = (await h.post("brokerage/deals", deal())).body;
  assert.equal(created.approvalStatus, "pending");

  h.state.principal = {
    ...agent,
    role: "sales_manager",
    roles: ["sales_manager", "sales_admin"],
    scope: "company",
  };
  assert.equal((await h.get("brokerage/deals/options")).body.canApprove, true);
  const approved = (
    await h.post(`brokerage/deals/${created.id}/decision`, {
      requestId: randomUUID(),
      version: 0,
      decision: "approved",
    })
  ).body;
  assert.equal(approved.approvalStatus, "approved");
});

test("EOI and reservation changes save straight through for anyone; only the move into a signed contract needs admin approval", async () => {
  h.state.principal = agent;
  const eoi = (await h.post("brokerage/deals", deal({ status: "eoi" }))).body;
  assert.equal(eoi.approvalStatus, "approved");
  const reserved = (
    await h.post(`brokerage/deals/${eoi.id}/update`, {
      ...deal({
        status: "reservation",
        clientName: "Still looking",
        documents: [],
      }),
      version: eoi.version,
    })
  ).body;
  assert.equal(reserved.approvalStatus, "approved");
  const contracted = (
    await h.post(`brokerage/deals/${eoi.id}/update`, {
      ...deal({ status: "contracted", documents: [] }),
      version: reserved.version,
    })
  ).body;
  assert.equal(contracted.approvalStatus, "pending");
});

test("contracts list filters by first approval date, agent and lead", async () => {
  h.state.principal = agent;
  const created = (await h.post("brokerage/deals", deal())).body;
  const base = "brokerage/deals?contracts=true";
  const ids = async (query = "") =>
    (await h.get(base + query)).body.items.map((x) => x.id);
  assert.equal(created.contractedAt, null);
  assert.equal((await ids()).includes(created.id), false);
  h.state.principal = owner;
  const approved = (
    await h.post(`brokerage/deals/${created.id}/decision`, {
      requestId: randomUUID(),
      version: 0,
      decision: "approved",
    })
  ).body;
  assert.equal(approved.contractedAt, approved.approvedAt);
  assert.equal(approved.contractModifiedAt, null);
  // 22:30 UTC on the 9th is already the 10th in Cairo. The trigger keeps the
  // date fixed, so it is lifted to move this fixture into the past.
  await h.db.exec(
    "ALTER TABLE tenant.brokerage_deals DISABLE TRIGGER brokerage_contract_dates",
  );
  await h.db.query(
    "UPDATE tenant.brokerage_deals SET contracted_at='2026-01-09T22:30:00Z' WHERE id=$1",
    [created.id],
  );
  await h.db.exec(
    "ALTER TABLE tenant.brokerage_deals ENABLE TRIGGER brokerage_contract_dates",
  );
  assert.deepEqual(
    await ids("&contractedFrom=2026-01-10&contractedTo=2026-01-10"),
    [created.id],
  );
  assert.deepEqual(await ids("&contractedTo=2026-01-09"), []);
  assert.equal(
    (await ids(`&agentId=${agent.id}&leadId=${leadId}`)).includes(created.id),
    true,
  );
  assert.deepEqual(await ids(`&agentId=${owner.id}`), []);
  assert.deepEqual(await ids(`&leadId=${randomUUID()}`), []);
  assert.equal((await ids("&search=Lead")).includes(created.id), true);
  await h.get(base + "&contractedFrom=2026-13-01", 400);
});

test("a contract keeps its first date and records later changes", async () => {
  h.state.principal = owner;
  const created = (await h.post("brokerage/deals", deal())).body;
  assert.ok(created.contractedAt);
  assert.equal(created.contractModifiedAt, null);
  const listed = async () =>
    (await h.get("brokerage/deals?contracts=true&limit=100")).body.items.find(
      (x) => x.id === created.id,
    );

  // A salesperson adding only a document sends it back for approval.
  h.state.principal = agent;
  const changed = (
    await h.post(`brokerage/deals/${created.id}/update`, {
      ...deal(),
      version: 0,
    })
  ).body;
  assert.equal(changed.approvalStatus, "pending");
  assert.equal(changed.contractedAt, created.contractedAt);
  assert.ok(changed.contractModifiedAt);
  assert.equal((await listed()).contractedAt, created.contractedAt);
  assert.equal(
    (await h.get(`brokerage/deals/${created.id}`)).body.documents.length,
    2,
  );

  h.state.principal = owner;
  const again = (
    await h.post(`brokerage/deals/${created.id}/decision`, {
      requestId: randomUUID(),
      version: 1,
      decision: "approved",
    })
  ).body;
  assert.equal(again.contractedAt, created.contractedAt);
  assert.ok(
    Date.parse(again.contractModifiedAt) >=
      Date.parse(changed.contractModifiedAt),
  );

  const cancelled = (
    await h.post(`brokerage/deals/${created.id}/update`, {
      ...deal({ status: "cancelled", documents: [] }),
      version: 1,
    })
  ).body;
  assert.equal(cancelled.contractedAt, created.contractedAt);
  assert.equal((await listed()).status, "cancelled");
});

test("the owner and Sales Admins are notified about every deal step", async () => {
  async function member(key, additional) {
    const roleId = async (k) =>
      (
        await h.db.query(
          "INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES($1,$2,'{}',ARRAY['leads.read','leads.manage'],'company') ON CONFLICT(company_id,key) DO UPDATE SET key=excluded.key RETURNING id",
          [owner.companyId, k],
        )
      ).rows[0].id;
    const id = (
      await h.db.query(
        "INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES($1,$2,'company_user',$2,$3,$4,'active') RETURNING id",
        [
          owner.companyId,
          key,
          key + "@deals.test",
          await roleId(additional ? "sales_manager" : "sales_admin"),
        ],
      )
    ).rows[0].id;
    if (additional)
      await h.db.query(
        "INSERT INTO tenant.user_additional_roles(company_id,user_id,role_id) VALUES($1,$2,$3)",
        [owner.companyId, id, await roleId("sales_admin")],
      );
    return id;
  }
  const primary = await member("notify-primary", false);
  const extra = await member("notify-extra", true);
  const received = async (dealId, kind) =>
    (
      await h.db.query(
        "SELECT n.user_id,n.title FROM tenant.notifications n JOIN tenant.outbox_events e ON e.id=n.event_id WHERE e.aggregate_id=$1 AND n.kind=$2",
        [dealId, kind],
      )
    ).rows;
  const sorted = (rows) => rows.map((x) => x.user_id).sort();

  h.state.principal = agent;
  const created = (await h.post("brokerage/deals", deal())).body;
  const onCreate = await received(created.id, "brokerage.deal.created");
  assert.deepEqual(sorted(onCreate), [owner.id, primary, extra].sort());
  assert.match(
    onCreate[0].title,
    /New deal \(pending approval\) · Actual buyer · by Agent/,
  );

  await h.post(`brokerage/deals/${created.id}/update`, {
    ...deal({ clientName: "Updated buyer", documents: [] }),
    version: 0,
  });
  assert.equal(
    (await received(created.id, "brokerage.deal.updated")).length,
    3,
  );

  h.state.principal = owner;
  await h.post(`brokerage/deals/${created.id}/decision`, {
    requestId: randomUUID(),
    version: 1,
    decision: "approved",
  });
  // The approver does not notify themselves.
  assert.deepEqual(
    sorted(await received(created.id, "brokerage.deal.approved")),
    [primary, extra].sort(),
  );
});
