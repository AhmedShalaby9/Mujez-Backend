import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
import { runFinanceAutomation } from "../dist/modules/finance/accounting/finance-automation-sweep.js";
let h,
  owner,
  other,
  agent,
  lead,
  officer,
  employeeId,
  agreement,
  rule,
  contractId,
  advance,
  cash,
  teamId;
const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Africa/Cairo",
  }),
  month = today.slice(0, 7),
  b = (x) => ({ requestId: randomUUID(), ...x });
const get = (p, status = 200) => h.get("accounting/" + p, status),
  post = (p, x, status = 201) => h.post("accounting/" + p, b(x), status);
async function invite(name, roles) {
  h.state.principal = owner;
  const r = (
    await h.post("team/invite", {
      name,
      email: name + "@extension.test",
      roles,
    })
  ).body;
  await h.post(
    "team/activate",
    { token: r.token, password: "extension-fixture-password" },
    200,
  );
  const a = (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [r.accountId],
    )
  ).rows[0];
  return new SessionService(h.database, {
    consume: async () => true,
  }).employeeProfile(a);
}
async function contract(value = "1000000") {
  const buyer = (
    await h.post(
      "leads",
      b({
        name: "Extension buyer",
        phone: "+1202" + String(Date.now()).slice(-7),
        segment: "res",
        want: "Apartment",
        source: "manual",
      }),
    )
  ).body;
  const r = (
    await h.post(
      "contracts",
      b({
        type: "broker_agreement",
        leadId: buyer.id,
        ownerId: agent.id,
        title: "Extension contract",
        valueMinor: value,
        keyDate: today,
        signers: [{ name: "Buyer", role: "Client" }],
      }),
    )
  ).body;
  await h.db.query(
    "UPDATE tenant.contracts SET status='signed',signed_date=$2,version=version+1 WHERE id=$1",
    [r.id, today],
  );
  return r.id;
}
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  agent = await invite("CommissionAgent", ["agent", "employee"]);
  lead = await invite("CommissionLead", ["team_lead", "employee"]);
  officer = await invite("PayrollClerk", ["payroll_officer", "employee"]);
  h.state.principal = owner;
  teamId = (
    await h.post("team/groups", {
      name: "Commission team",
      leadUserId: lead.id,
      memberUserIds: [agent.id],
    })
  ).body.id;
  employeeId = (
    await h.db.query(
      "SELECT id FROM tenant.hr_employees WHERE company_id=$1 AND user_id=$2",
      [owner.companyId, agent.id],
    )
  ).rows[0].id;
  await h.db.query(
    "UPDATE tenant.hr_employees SET status='active' WHERE company_id=$1",
    [owner.companyId],
  );
  await post("setup", { year: Number(today.slice(0, 4)) });
  const opts = (await get("options")).body;
  cash = (await get("treasuries")).body.items[0];
  const j = (
    await post("journals", {
      date: today,
      memo: "QA opening",
      cashFlow: "opening",
      lines: [
        { accountId: cash.account_id, debitMinor: "10000000" },
        {
          accountId: opts.accounts.find(
            (a) => a.system_key === "opening_equity",
          ).id,
          creditMinor: "10000000",
        },
      ],
    })
  ).body;
  await post("journals/" + j.id + "/action", { version: 1, action: "post" });
  const developer = (
    await post("parties", { name: "Commission developer", kind: "developer" })
  ).body;
  agreement = (
    await post("agreements", {
      name: "Developer terms",
      developerId: developer.id,
      mode: "percent",
      rateBps: 1000,
      agentBps: 2000,
      leadBps: 1000,
    })
  ).body;
});
after(() => h?.close());
afterEach(() => {
  h.state.principal = owner;
  h.state.failAudit = false;
});
test("effective employee/team/role policies select by specificity and snapshot values for later adjustments", async () => {
  await post("commission-policies", {
    name: "Agent default",
    roleKey: "agent",
    mode: "percent",
    rateBps: 1000,
    from: today,
  });
  await post("commission-policies", {
    name: "Team tier",
    roleKey: "agent",
    teamId,
    mode: "tiers",
    tiers: [
      { fromMinor: "0", rateBps: 2000 },
      { fromMinor: "900000", rateBps: 2500 },
    ],
    from: today,
  });
  const personal = (
    await post("commission-policies", {
      name: "Employee fixed",
      roleKey: "agent",
      userId: agent.id,
      mode: "fixed",
      fixedMinor: "30000",
      from: today,
    })
  ).body;
  await post(
    "commission-policies",
    {
      name: "Conflicting policy",
      roleKey: "agent",
      userId: agent.id,
      mode: "fixed",
      fixedMinor: "1",
      from: today,
    },
    409,
  );
  contractId = await contract();
  let deal = (await get("deals")).body.items.find(
    (x) => x.contract_id === contractId,
  );
  await post("deals/" + deal.id + "/book", {
    version: deal.version,
    agreementId: agreement.id,
    agreementVersion: 1,
    date: today,
  });
  deal = (await get("deals")).body.items.find((x) => x.id === deal.id);
  assert.equal(deal.booked_terms.agentMinor, "30000");
  assert.equal(deal.booked_terms.leadMinor, "10000");
  assert.equal(deal.booked_terms.companyMinor, "60000");
  await post("commission-policies/" + personal.id, {
    version: 1,
    name: "Changed policy",
    roleKey: "agent",
    userId: agent.id,
    mode: "fixed",
    fixedMinor: "50000",
    from: today,
  });
  await h.db.query(
    "UPDATE tenant.contracts SET value_minor=2000000,version=version+1 WHERE id=$1",
    [contractId],
  );
  deal = (await get("deals")).body.items.find((x) => x.id === deal.id);
  await post("deals/" + deal.id + "/action", {
    version: deal.version,
    action: "adjust",
    date: today,
    reason: "Changed CRM value",
  });
  deal = (await get("deals")).body.items.find((x) => x.id === deal.id);
  assert.equal(deal.booked_terms.agentMinor, "30000");
  assert.equal(deal.booked_terms.grossMinor, "200000");
  h.state.principal = agent;
  await get("commission-policies", 403);
  h.state.principal = other;
  await post(
    "commission-policies/" + personal.id,
    {
      version: 2,
      name: "Spoofed",
      roleKey: "agent",
      mode: "percent",
      rateBps: 100,
      from: today,
    },
    404,
  );
});
test("authorized CRM automation posts once, creates linked installments, and atomically handles cancellation", async () => {
  rule = (
    await post("automation-rules", {
      name: "Signed brokerage",
      contractType: "broker_agreement",
      agreementId: agreement.id,
      active: true,
      autoAdjust: true,
      createInstallments: true,
      installments: 3,
      firstDueDays: 0,
      collectionOwner: "developer",
    })
  ).body;
  const id = await contract("3000000");
  let result = await runFinanceAutomation(h.database);
  assert.equal(result.errors, 0);
  assert.equal(result.processed, 1);
  assert.equal((await runFinanceAutomation(h.database)).processed, 0);
  let d = (await get("deals")).body.items.find((x) => x.contract_id === id);
  assert.ok(d.installment_plan_id);
  assert.equal(d.booked_terms.agentMinor, "50000");
  const obligations = (await get("obligations?limit=100")).body.items.filter(
    (x) => x.plan_id === d.installment_plan_id,
  );
  assert.equal(obligations.length, 3);
  assert.ok(
    obligations.every(
      (x) => x.collection_owner === "developer" && x.status === "posted",
    ),
  );
  await h.db.query(
    "UPDATE tenant.contracts SET status='void',version=version+1 WHERE id=$1",
    [id],
  );
  await post("automation-process", { version: 1, action: "process" });
  d = (await get("deals")).body.items.find((x) => x.id === d.id);
  assert.equal(d.state, "cancelled");
  assert.equal(
    (await get("installment-plans")).body.items.find(
      (x) => x.id === d.installment_plan_id,
    ).status,
    "cancelled",
  );
});
test("automation errors leave a reviewable inbox record and roll back all partial journals", async () => {
  const id = await contract("1");
  const before = (
    await h.db.query("SELECT count(*)::integer AS n FROM tenant.fin_journals")
  ).rows[0].n;
  const r = (
    await post("automation-process", { version: 1, action: "process" })
  ).body;
  assert.equal(r.errors.length, 1);
  const d = (await get("deals")).body.items.find((x) => x.contract_id === id);
  assert.equal(d.state, "needs_review");
  assert.match(d.automation_error, /positive|exceed/i);
  assert.equal(
    (await h.db.query("SELECT count(*)::integer AS n FROM tenant.fin_journals"))
      .rows[0].n,
    before,
  );
});
test("payroll officer can prepare salaries without seeing company finance and needs a separate approver", async () => {
  h.state.principal = officer;
  await get("context", 403);
  await get("salary-profiles");
  await post("salary-profiles", {
    employeeId,
    baseMinor: "100000",
    allowanceMinor: "20000",
    deductionMinor: "5000",
    deductionNote: "Approved absence deduction",
    advanceCapBps: 5000,
  });
  const run = (
    await post("payroll-runs", {
      month,
      date: today,
      employeeIds: [employeeId],
    })
  ).body;
  await post("payroll-runs/" + run.id + "/action", {
    version: 1,
    action: "submit",
  });
  await post(
    "payroll-runs/" + run.id + "/action",
    { version: 2, action: "approve" },
    403,
  );
  h.state.principal = owner;
  await post("payroll-runs/" + run.id + "/action", {
    version: 2,
    action: "approve",
  });
  await post("payroll-runs/" + run.id + "/action", {
    version: 3,
    action: "post",
  });
  const detail = (await get("payroll-runs/" + run.id)).body;
  assert.equal(detail.lines[0].net_minor, "115000");
  assert.ok(detail.lines[0].salary_obligation_id);
  await post(
    "obligations/" + detail.lines[0].salary_obligation_id + "/action",
    { version: 1, action: "reverse", date: today, reason: "Bypass source" },
    409,
  );
  await post("payroll-runs/" + run.id + "/action", {
    version: 4,
    action: "reverse",
    date: today,
    reason: "QA payroll correction",
  });
});
test("scheduled advance deductions are capped, update HR and finance once, and reverse together", async () => {
  h.state.principal = agent;
  advance = (
    await h.post(
      "hr-resources/advances",
      b({
        amountMinor: "100000",
        mode: "monthly",
        installments: 2,
        firstDue: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        reason: "Monthly salary advance",
      }),
    )
  ).body;
  h.state.principal = owner;
  await h.post(
    "hr-resources/advances/" + advance.id + "/action",
    b({ version: 1, action: "approve" }),
  );
  await h.post(
    "hr-resources/advances/" + advance.id + "/action",
    b({
      version: 2,
      action: "payout",
      date: today,
      reference: "Actual QA payout",
    }),
  );
  await post("hr-advances/" + advance.id + "/action", {
    version: 3,
    action: "book_payout",
    treasuryId: cash.id,
  });
  await h.db.query(
    "UPDATE tenant.salary_advances SET first_due=$2 WHERE id=$1",
    [advance.id, today],
  );
  const run = (
    await post("payroll-runs", {
      month,
      date: today,
      employeeIds: [employeeId],
    })
  ).body;
  let d = (await get("payroll-runs/" + run.id)).body;
  assert.equal(d.lines[0].advance_minor, "50000");
  assert.equal(d.lines[0].net_minor, "65000");
  await post("payroll-runs/" + run.id + "/action", {
    version: 1,
    action: "submit",
  });
  await post("payroll-runs/" + run.id + "/action", {
    version: 2,
    action: "approve",
  });
  const request = b({ version: 3, action: "post" });
  await h.post("accounting/payroll-runs/" + run.id + "/action", request);
  await h.post("accounting/payroll-runs/" + run.id + "/action", request);
  assert.equal(
    (await h.get("hr-resources/advances/" + advance.id)).body.balanceMinor,
    "50000",
  );
  const repayments = (await h.get("hr-resources/advances/" + advance.id)).body
    .payments;
  await post(
    "hr-advances/" + advance.id + "/action",
    {
      version: 4,
      action: "reverse_link",
      paymentId: repayments[0].id,
      date: today,
      reason: "Attempt to bypass payroll reversal",
    },
    409,
  );
  d = (await get("payroll-runs/" + run.id)).body;
  const tx = (
    await post("transactions", {
      kind: "payment",
      date: today,
      treasuryId: cash.id,
      obligationId: d.lines[0].salary_obligation_id,
      amountMinor: "65000",
      memo: "Actual QA net salary payment",
    })
  ).body;
  await post(
    "payroll-runs/" + run.id + "/action",
    {
      version: 4,
      action: "reverse",
      date: today,
      reason: "Cannot reverse paid payroll",
    },
    409,
  );
  await post("transactions/" + tx.id + "/action", {
    version: 1,
    action: "reverse",
    date: today,
    reason: "QA payment correction",
  });
  await post("payroll-runs/" + run.id + "/action", {
    version: 4,
    action: "reverse",
    date: today,
    reason: "QA payroll correction",
  });
  assert.equal(
    (await h.get("hr-resources/advances/" + advance.id)).body.balanceMinor,
    "100000",
  );
  for (const kind of ["trial_balance", "balance_sheet", "cash_flow"])
    assert.equal(
      (await get("reports?kind=" + kind)).body.summary.differenceMinor,
      "0",
    );
});
test("complete employee statements include posted balances and enforce personal/team boundaries", async () => {
  const all = (await get("staff-statements")).body;
  assert.ok(all.items.find((x) => x.id === agent.id).earnedMinor);
  h.state.principal = agent;
  const own = (await get("self")).body.staff;
  assert.equal(own.items.length, 1);
  assert.equal(own.items[0].id, agent.id);
  assert.equal(own.items[0].advanceBalanceMinor, "100000");
  h.state.principal = lead;
  const team = (await get("self?kind=team")).body.staff;
  assert.ok(team.items.some((x) => x.id === agent.id));
  const subordinate = team.items.find((x) => x.id === agent.id);
  assert.equal(subordinate.salaryOutstandingMinor, null);
  assert.equal(subordinate.advanceBalanceMinor, null);
  assert.equal(subordinate.payrollRestricted, true);
  assert.ok(
    subordinate.activity.every(
      (x) => !["salary_ap", "salary_advance"].includes(x.system_key),
    ),
  );
  h.state.principal = other;
  assert.equal(
    (await get("staff-statements")).body.items.some((x) => x.id === agent.id),
    false,
  );
});

test("approved stale payroll can only be cancelled by an approver; failures leave no partial ledger", async () => {
  const run = (
    await post("payroll-runs", {
      month,
      date: today,
      employeeIds: [employeeId],
    })
  ).body;
  await post("payroll-runs/" + run.id + "/action", {
    version: 1,
    action: "submit",
  });
  await post("payroll-runs/" + run.id + "/action", {
    version: 2,
    action: "approve",
  });
  const profile = (await get("salary-profiles")).body.items.find(
    (x) => x.employee_id === employeeId,
  );
  await post("salary-profiles/" + profile.id, {
    version: profile.version,
    employeeId,
    baseMinor: "110000",
    allowanceMinor: "20000",
    deductionMinor: "5000",
    deductionNote: "Approved absence deduction",
    advanceCapBps: 5000,
  });
  const count = (
    await h.db.query("SELECT count(*)::integer AS n FROM tenant.fin_journals")
  ).rows[0].n;
  await post(
    "payroll-runs/" + run.id + "/action",
    { version: 3, action: "post" },
    409,
  );
  assert.equal(
    (await h.db.query("SELECT count(*)::integer AS n FROM tenant.fin_journals"))
      .rows[0].n,
    count,
  );
  h.state.principal = officer;
  await post(
    "payroll-runs/" + run.id + "/action",
    { version: 3, action: "cancel" },
    403,
  );
  h.state.principal = owner;
  await post("payroll-runs/" + run.id + "/action", {
    version: 3,
    action: "cancel",
  });
  h.state.failAudit = true;
  await post(
    "payroll-runs",
    { month, date: today, employeeIds: [employeeId] },
    500,
  );
  h.state.failAudit = false;
  assert.ok(
    (await get("payroll-runs")).body.items.every((x) =>
      ["reversed", "cancelled"].includes(x.status),
    ),
  );
});
