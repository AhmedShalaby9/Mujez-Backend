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
  const created = (
    await h.post("brokerage/deals", deal({ status: "reservation" }))
  ).body;
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
