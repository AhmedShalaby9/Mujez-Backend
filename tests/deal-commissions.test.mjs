import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
let h, owner, admin, agent, leadId, developer, project;
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
before(async () => {
  h = await tenantHarness();
  owner = { ...h.principals[0], company: { type: "brokerage" } };
  await h.db.query(
    "UPDATE platform.companies SET company_type='brokerage' WHERE id=$1",
    [owner.companyId],
  );
  async function makeUser(key, permissions, roleName, scope) {
    const role = (
      await h.db.query(
        "INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES($1,$2,'{}',$3,$4) RETURNING id",
        [owner.companyId, key, permissions, scope],
      )
    ).rows[0].id;
    const id = (
      await h.db.query(
        "INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES($1,$2,'company_user',$3,$4,$5,'active') RETURNING id",
        [owner.companyId, "dc-" + key, roleName, key + "@dc.test", role],
      )
    ).rows[0].id;
    return {
      ...owner,
      id,
      pool: "company_user",
      role: key,
      roles: [key],
      scope,
      permissions,
      name: roleName,
    };
  }
  agent = await makeUser(
    "agent",
    ["leads.read", "leads.manage"],
    "Agent",
    "own",
  );
  admin = await makeUser(
    "sales_admin",
    ["leads.read", "leads.manage"],
    "Sales Admin",
    "company",
  );
  leadId = (
    await h.db.query(
      'INSERT INTO tenant.leads(company_id,public_id,name,phone,segment,want,source,owner_user_id,brokerage_status) VALUES($1,\'L-COMM\',\'{"en":"Lead","ar":"Lead"}\',\'+201000000004\',\'res\',\'{"en":"Apartment","ar":"Apartment"}\',\'manual\',$2,\'potential\') RETURNING id',
      [owner.companyId, agent.id],
    )
  ).rows[0].id;
  h.state.principal = owner;
  developer = (
    await h.post("brokerage/developers", {
      requestId: randomUUID(),
      name: "Commission Developer",
    })
  ).body;
  project = (
    await h.post("brokerage/projects", {
      requestId: randomUUID(),
      developerId: developer.id,
      code: "COMMPROJ",
      name: "Commission Project",
      location: "Cairo",
      segment: "res",
    })
  ).body;
});
after(async () => h.close());

async function contractedDeal(clientPhone) {
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
  h.state.principal = admin;
  return (
    await h.post(`brokerage/deals/${created.id}/decision`, {
      requestId: randomUUID(),
      version: 0,
      decision: "approved",
    })
  ).body;
}

test("sales admin can manually enter commission entries; a plain agent cannot, and each person sees only their own", async () => {
  const deal = await contractedDeal("+201000000020");

  h.state.principal = agent;
  await h.post(
    "brokerage/commissions",
    {
      requestId: randomUUID(),
      dealId: deal.id,
      entries: [{ userId: agent.id, amountMinor: "100000" }],
    },
    403,
  );

  h.state.principal = admin;
  const created = (
    await h.post("brokerage/commissions", {
      requestId: randomUUID(),
      dealId: deal.id,
      entries: [
        { userId: agent.id, amountMinor: "100000", note: "Agent cut" },
        { userId: admin.id, amountMinor: "50000" },
      ],
    })
  ).body;
  assert.equal(created.ids.length, 2);

  // Finance isn't configured: entries exist, but with no obligation posted.
  h.state.principal = agent;
  const agentList = (await h.get("brokerage/commissions")).body;
  assert.equal(agentList.items.length, 1);
  assert.equal(agentList.items[0].userId, agent.id);
  assert.equal(agentList.items[0].amountMinor, "100000");
  assert.equal(agentList.items[0].posted, false);
  assert.equal(agentList.canManage, false);

  h.state.principal = admin;
  const adminList = (await h.get("brokerage/commissions")).body;
  assert.equal(adminList.items.length, 2);
  assert.equal(adminList.canManage, true);

  // Duplicate person in one submission is rejected.
  await h.post(
    "brokerage/commissions",
    {
      requestId: randomUUID(),
      dealId: deal.id,
      entries: [
        { userId: agent.id, amountMinor: "1000" },
        { userId: agent.id, amountMinor: "2000" },
      ],
    },
    400,
  );
});

test("a posted commission entry books a Finance commission_payable obligation once Finance is configured", async () => {
  h.state.principal = owner;
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Africa/Cairo",
  });
  await h.post("accounting/setup", {
    requestId: randomUUID(),
    year: Number(today.slice(0, 4)),
  });

  const deal = await contractedDeal("+201000000021");
  h.state.principal = admin;
  const created = (
    await h.post("brokerage/commissions", {
      requestId: randomUUID(),
      dealId: deal.id,
      entries: [{ userId: agent.id, amountMinor: "75000" }],
    })
  ).body;
  const list = (await h.get(`brokerage/commissions?dealId=${deal.id}`)).body;
  const entry = list.items.find((x) => x.userId === agent.id);
  assert.ok(entry);
  assert.equal(entry.posted, true);

  const party = (
    await h.db.query(
      "SELECT id FROM tenant.fin_parties WHERE company_id=$1 AND kind='employee' AND reference_id=$2",
      [owner.companyId, agent.id],
    )
  ).rows[0];
  assert.ok(party);
  const obligation = (
    await h.db.query(
      "SELECT kind,party_id,net_minor::text AS net_minor,tax_bps,status FROM tenant.fin_obligations o JOIN tenant.deal_commission_entries e ON e.obligation_id=o.id WHERE e.company_id=$1 AND e.deal_id=$2 AND e.user_id=$3",
      [owner.companyId, deal.id, agent.id],
    )
  ).rows[0];
  assert.equal(obligation.kind, "commission_payable");
  assert.equal(obligation.party_id, party.id);
  assert.equal(obligation.net_minor, "75000");
  assert.equal(obligation.tax_bps, 0);
  assert.equal(obligation.status, "posted");
});
