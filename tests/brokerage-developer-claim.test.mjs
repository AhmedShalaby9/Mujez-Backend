import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
let h, owner, agent, leadId;
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
const today = new Date().toLocaleDateString("en-CA", {
  timeZone: "Africa/Cairo",
});
let developer, project;
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
      "INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES($1,$2,'company_user','Agent','agent@claim.test',$3,'active') RETURNING id",
      [owner.companyId, "claim-agent", role],
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
      'INSERT INTO tenant.leads(company_id,public_id,name,phone,segment,want,source,owner_user_id,brokerage_status) VALUES($1,\'L-CLAIM\',\'{"en":"Lead","ar":"Lead"}\',\'+201000000003\',\'res\',\'{"en":"Apartment","ar":"Apartment"}\',\'manual\',$2,\'potential\') RETURNING id',
      [owner.companyId, id],
    )
  ).rows[0].id;
  h.state.principal = owner;
  developer = (
    await h.post("brokerage/developers", {
      requestId: randomUUID(),
      name: "Claim Developer",
    })
  ).body;
  project = (
    await h.post("brokerage/projects", {
      requestId: randomUUID(),
      developerId: developer.id,
      code: "CLAIMPROJ",
      name: "Claim Project",
      location: "Cairo",
      segment: "res",
    })
  ).body;
});
after(async () => h.close());

async function approvedDeal(clientPhone) {
  h.state.principal = agent;
  const created = (
    await h.post("brokerage/deals", {
      requestId: randomUUID(),
      leadId,
      agentId: agent.id,
      clientName: "Buyer",
      clientPhone,
      sellingType: "primary",
      status: "contracted",
      developerId: developer.id,
      projectId: project.id,
      unitValueMinor: "500000000",
      details,
      documents: [document],
    })
  ).body;
  h.state.principal = owner;
  return (
    await h.post(`brokerage/deals/${created.id}/decision`, {
      requestId: randomUUID(),
      version: 0,
      decision: "approved",
    })
  ).body;
}

test("the developer's claim posts automatically once Finance is configured and an agreement exists, and never blocks approval otherwise", async () => {
  // Finance isn't even set up yet: approval still succeeds, no claim.
  const beforeFinance = await approvedDeal("+201000000010");
  assert.equal(beforeFinance.approvalStatus, "approved");
  assert.equal(beforeFinance.developerClaimObligationId, null);

  h.state.principal = owner;
  await h.post("accounting/setup", {
    requestId: randomUUID(),
    year: Number(today.slice(0, 4)),
  });

  // Finance is set up, but this developer has no agreement yet: still no
  // claim, and the deal approval itself is unaffected.
  const noAgreement = await approvedDeal("+201000000011");
  assert.equal(noAgreement.approvalStatus, "approved");
  assert.equal(noAgreement.developerClaimObligationId, null);

  // The first deal above auto-created a Finance party for this developer
  // (reference_id-linked); find it and give it an agreement.
  const party = (
    await h.db.query(
      "SELECT id FROM tenant.fin_parties WHERE company_id=$1 AND kind='developer' AND reference_id=$2",
      [owner.companyId, developer.id],
    )
  ).rows[0];
  assert.ok(party);
  await h.post("accounting/agreements", {
    requestId: randomUUID(),
    name: "Claim test agreement",
    developerId: party.id,
    mode: "percent",
    rateBps: 500,
    agentBps: 0,
    leadBps: 0,
    dueDays: 30,
  });

  const withAgreement = await approvedDeal("+201000000012");
  assert.ok(withAgreement.developerClaimObligationId);
  const obligation = (
    await h.db.query(
      "SELECT kind,party_id,net_minor::text AS net_minor,status FROM tenant.fin_obligations WHERE company_id=$1 AND id=$2",
      [owner.companyId, withAgreement.developerClaimObligationId],
    )
  ).rows[0];
  assert.equal(obligation.kind, "developer_claim");
  assert.equal(obligation.party_id, party.id);
  // 5,000,000 EGP (500000000 minor) at 5% (500 bps) = 250,000 EGP = 25,000,000 minor.
  assert.equal(obligation.net_minor, "25000000");
  assert.equal(obligation.status, "posted");

  // Re-saving the already-approved deal does not post a second claim.
  const reApproved = (
    await h.post(`brokerage/deals/${withAgreement.id}/update`, {
      requestId: randomUUID(),
      version: withAgreement.version,
      leadId,
      agentId: agent.id,
      clientName: "Buyer renamed",
      clientPhone: "+201000000012",
      sellingType: "primary",
      status: "contracted",
      developerId: developer.id,
      projectId: project.id,
      unitValueMinor: "500000000",
      details,
    })
  ).body;
  assert.equal(
    reApproved.developerClaimObligationId,
    withAgreement.developerClaimObligationId,
  );
  const count = (
    await h.db.query(
      "SELECT count(*)::int AS n FROM tenant.fin_obligations WHERE company_id=$1 AND kind='developer_claim'",
      [owner.companyId],
    )
  ).rows[0].n;
  assert.equal(count, 1);
});
