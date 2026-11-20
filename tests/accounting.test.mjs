import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { runFinanceSweep } from "../dist/modules/finance/accounting/finance-sweep.js";
import { SessionService } from "../dist/common/auth/session.service.js";
let h,
  owner,
  other,
  options,
  cash,
  equity,
  bank,
  developer,
  claim,
  journal,
  receipt,
  accountant,
  manager;
const b = (x) => ({ requestId: randomUUID(), ...x });
const base = "accounting/";
let today = new Date().toLocaleDateString("en-CA", {
  timeZone: "Africa/Cairo",
});
const get = (p, status = 200) => h.get(base + p, status);
const post = (p, x, status = 201) => h.post(base + p, b(x), status);
async function invite(name, roles) {
  h.state.principal = owner;
  const r = (
    await h.post("team/invite", { name, email: name + "@example.test", roles })
  ).body;
  await h.post(
    "team/activate",
    { token: r.token, password: "accounting-fixture-password" },
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
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  accountant = await invite("AccountingStaff", ["accountant", "employee"]);
  manager = await invite("AccountingManager", ["finance_manager", "employee"]);
  h.state.principal = owner;
});
after(() => h?.close());
afterEach(() => {
  h.state.principal = owner;
  h.state.failAudit = false;
});
test("finance roles preserve CRM scope and setup is explicit, isolated and does not invent cash", async () => {
  assert.equal(accountant.scope, "own");
  assert.ok(accountant.permissions.includes("finance.post"));
  assert.ok(!accountant.permissions.includes("finance.settings"));
  h.state.principal = accountant;
  await post("setup", { year: Number(today.slice(0, 4)) }, 403);
  h.state.principal = owner;
  const body = b({ year: Number(today.slice(0, 4)) });
  await h.post(base + "setup", body);
  await h.post(base + "setup", body);
  options = (await get("options")).body;
  cash = options.accounts.find((a) => a.system_key === "cash");
  equity = options.accounts.find((a) => a.system_key === "opening_equity");
  assert.equal((await get("treasuries")).body.items[0].balanceMinor, "0");
  h.state.principal = {
    ...accountant,
    roles: ["agent", "employee"],
    permissions: [...accountant.permissions],
  };
  await get("options", 403);
  h.state.principal = other;
  assert.equal((await get("context")).body.configured, false);
});
test("drafts do not change balances; posting is balanced, idempotent and immutable at database level", async () => {
  await post(
    "journals",
    {
      date: today,
      memo: "Unbalanced opening",
      lines: [
        { accountId: cash.id, debitMinor: "10000" },
        { accountId: equity.id, creditMinor: "9999" },
      ],
    },
    400,
  );
  journal = (
    await post("journals", {
      date: today,
      memo: "Explicit opening balance",
      cashFlow: "opening",
      lines: [
        { accountId: cash.id, debitMinor: "1000000" },
        { accountId: equity.id, creditMinor: "1000000" },
      ],
    })
  ).body;
  assert.equal((await get("treasuries")).body.items[0].balanceMinor, "0");
  const action = b({ version: 1, action: "post" });
  await h.post(base + "journals/" + journal.id + "/action", action);
  await h.post(base + "journals/" + journal.id + "/action", action);
  assert.equal((await get("treasuries")).body.items[0].balanceMinor, "1000000");
  await assert.rejects(
    h.database.tenant(owner.companyId, (c) =>
      c.query(
        "UPDATE tenant.fin_journal_lines SET debit_minor=1 WHERE journal_id=$1",
        [journal.id],
      ),
    ),
    /immutable/,
  );
  await post(
    "journals/" + journal.id,
    {
      version: 2,
      date: today,
      memo: "Tamper posted journal",
      lines: [
        { accountId: cash.id, debitMinor: "1" },
        { accountId: equity.id, creditMinor: "1" },
      ],
    },
    409,
  );
});
test("cash and bank transfers post exactly once and preserve total cash", async () => {
  bank = (await post("treasuries", { name: "QA Bank", kind: "bank" })).body;
  const cashbox = (await get("treasuries")).body.items.find(
    (t) => t.kind === "cash",
  );
  await post("transactions", {
    kind: "transfer",
    date: today,
    treasuryId: cashbox.id,
    toTreasuryId: bank.id,
    amountMinor: "200000",
    method: "bank_transfer",
    memo: "Cash deposited into bank",
  });
  const ts = (await get("treasuries")).body.items;
  assert.equal(ts.find((t) => t.id === cashbox.id).balanceMinor, "800000");
  assert.equal(ts.find((t) => t.id === bank.id).balanceMinor, "200000");
  await post(
    "transactions",
    {
      kind: "payment",
      date: today,
      treasuryId: cashbox.id,
      counterAccountId: options.accounts.find(
        (a) => a.system_key === "operating_expense",
      ).id,
      amountMinor: "800001",
      memo: "Too much cash",
    },
    400,
  );
});
test("developer claims, partial collections and receipts use brokerage revenue rather than property value", async () => {
  developer = (
    await post("parties", { kind: "developer", name: "QA Developer" })
  ).body;
  claim = (
    await post("obligations", {
      kind: "developer_claim",
      partyId: developer.id,
      date: today,
      dueDate: today,
      description: "Earned commission",
      netMinor: "100000",
      taxBps: 1400,
    })
  ).body;
  await post(
    "obligations/" + claim.id + "/action",
    { version: 1, action: "post" },
    409,
  );
  await post("obligations/" + claim.id + "/action", {
    version: 1,
    action: "submit",
  });
  await post("obligations/" + claim.id + "/action", {
    version: 2,
    action: "approve",
  });
  await post("obligations/" + claim.id + "/action", {
    version: 3,
    action: "post",
  });
  const o = (await get("obligations/" + claim.id)).body;
  assert.equal(o.total_minor, "114000");
  assert.equal(o.remainingMinor, "114000");
  const tx = b({
    kind: "receipt",
    date: today,
    treasuryId: bank.id,
    obligationId: claim.id,
    amountMinor: "50000",
    method: "bank_transfer",
    memo: "Partial developer collection",
  });
  receipt = (await h.post(base + "transactions", tx)).body;
  await h.post(base + "transactions", tx);
  assert.equal(
    (await get("obligations/" + claim.id)).body.remainingMinor,
    "64000",
  );
  await post(
    "transactions",
    { ...tx, requestId: randomUUID(), amountMinor: "64001" },
    400,
  );
  h.state.principal = accountant;
  await post(
    "obligations/" + claim.id + "/action",
    { version: 4, action: "approve" },
    403,
  );
  h.state.principal = other;
  await get("obligations/" + claim.id, 404);
  await post(
    "transactions",
    {
      kind: "receipt",
      date: today,
      treasuryId: bank.id,
      obligationId: claim.id,
      amountMinor: "1",
      memo: "Cross company",
    },
    400,
  );
});
test("reversals retain history, reopen receivables and require open periods", async () => {
  await post("transactions/" + receipt.id + "/action", {
    version: 1,
    action: "reverse",
    date: today,
    reason: "QA receipt entered in error",
  });
  assert.equal(
    (await get("obligations/" + claim.id)).body.remainingMinor,
    "114000",
  );
  await post(
    "transactions/" + receipt.id + "/action",
    {
      version: 1,
      action: "reverse",
      date: today,
      reason: "Duplicate reversal",
    },
    409,
  );
  const period = (await get("periods")).body.items[0];
  await post("periods/" + period.id + "/action", {
    version: period.version,
    action: "close",
    reason: "Period close test",
  });
  await post(
    "transactions",
    {
      kind: "receipt",
      date: today,
      treasuryId: bank.id,
      obligationId: claim.id,
      amountMinor: "1",
      memo: "Closed period",
    },
    400,
  );
  await post("periods/" + period.id + "/action", {
    version: period.version + 1,
    action: "reopen",
    reason: "Continue isolated tests",
  });
});
test("audit failures roll back finance documents and cross-company SQL remains isolated", async () => {
  const prior = (await get("journals")).body.total;
  h.state.failAudit = true;
  await post(
    "journals",
    {
      date: today,
      memo: "Audit rollback journal",
      lines: [
        { accountId: cash.id, debitMinor: "123" },
        { accountId: equity.id, creditMinor: "123" },
      ],
    },
    500,
  );
  h.state.failAudit = false;
  assert.equal((await get("journals")).body.total, prior);
  const rows = await h.database.tenant(other.companyId, (c) =>
    c.query("SELECT * FROM tenant.fin_accounts WHERE id=$1", [cash.id]),
  );
  assert.equal(rows.rows.length, 0);
});
let salesP, leadP, deal, agreement, dealClaim, agentPayable, hrAdvance;
test("cash custody payout, expense settlement and cash return do not turn the whole advance into expense", async () => {
  const employee = (
    await h.db.query("SELECT id FROM tenant.hr_employees WHERE user_id=$1", [
      accountant.id,
    ])
  ).rows[0];
  const custody = (
    await post("custodies", {
      employeeId: employee.id,
      amountMinor: "10000",
      purpose: "Travel expense custody",
    })
  ).body;
  await post("custodies/" + custody.id + "/action", {
    version: 1,
    action: "approve",
  });
  await post("custodies/" + custody.id + "/action", {
    version: 2,
    action: "payout",
    date: today,
    treasuryId: bank.id,
  });
  let row = (await get("custodies")).body.items.find(
    (x) => x.id === custody.id,
  );
  assert.equal(row.remainingMinor, "10000");
  await post("custodies/" + custody.id + "/action", {
    version: 3,
    action: "expense",
    date: today,
    amountMinor: "6000",
    accountId: options.accounts.find(
      (a) => a.system_key === "operating_expense",
    ).id,
    reason: "Taxi receipts submitted",
  });
  await post(
    "custodies/" + custody.id + "/action",
    {
      version: 4,
      action: "return",
      date: today,
      amountMinor: "4001",
      treasuryId: bank.id,
      reason: "Too much return",
    },
    400,
  );
  await post("custodies/" + custody.id + "/action", {
    version: 4,
    action: "return",
    date: today,
    amountMinor: "4000",
    treasuryId: bank.id,
    reason: "Unused cash returned",
  });
  row = (await get("custodies")).body.items.find((x) => x.id === custody.id);
  assert.equal(row.status, "closed");
  assert.equal(row.spentMinor, "6000");
  assert.equal(row.remainingMinor, "0");
});
test("cheques have no cash effect until clearance and a bounce reopens the claim", async () => {
  const before = (await get("treasuries")).body.items.find(
    (x) => x.id === bank.id,
  ).balanceMinor;
  const cheque = (
    await post("cheques", {
      number: "QA-CHEQUE-1",
      bank: "QA Issuing Bank",
      kind: "incoming",
      treasuryId: bank.id,
      partyId: developer.id,
      obligationId: claim.id,
      amountMinor: "5000",
      dueDate: today,
    })
  ).body;
  assert.equal(
    (await get("treasuries")).body.items.find((x) => x.id === bank.id)
      .balanceMinor,
    before,
  );
  await post("cheques/" + cheque.id + "/action", {
    version: 1,
    action: "deposit",
    reason: "Deposited with bank",
  });
  await post("cheques/" + cheque.id + "/action", {
    version: 2,
    action: "clear",
    date: today,
    reason: "Bank confirmed clearance",
  });
  assert.equal(
    (await get("obligations/" + claim.id)).body.remainingMinor,
    "109000",
  );
  await post("cheques/" + cheque.id + "/action", {
    version: 3,
    action: "bounce",
    date: today,
    reason: "Bank returned cheque",
  });
  assert.equal(
    (await get("obligations/" + claim.id)).body.remainingMinor,
    "114000",
  );
  assert.equal(
    (await get("treasuries")).body.items.find((x) => x.id === bank.id)
      .balanceMinor,
    before,
  );
});
test("signed CRM contracts enter the finance inbox, agreement tiers/splits book revenue and staff liabilities once", async () => {
  salesP = await invite("AccountingAgent", ["agent", "employee"]);
  leadP = await invite("AccountingTeamLead", ["team_lead", "employee"]);
  await h.post("team/groups", {
    name: "Finance test sales team",
    leadUserId: leadP.id,
    memberUserIds: [salesP.id],
  });
  const buyer = (
    await h.post(
      "leads",
      b({
        name: "Finance Buyer",
        phone: "+12025550888",
        segment: "res",
        want: "Apartment",
        source: "manual",
      }),
    )
  ).body;
  const contract = (
    await h.post(
      "contracts",
      b({
        type: "broker_agreement",
        leadId: buyer.id,
        ownerId: salesP.id,
        title: "Finance test contract",
        valueMinor: "1000000",
        keyDate: today,
        signers: [{ name: "Finance Buyer", role: "Client" }],
      }),
    )
  ).body;
  await h.db.query(
    "UPDATE tenant.contracts SET status='signed',signed_date=$2,version=version+1 WHERE id=$1",
    [contract.id, today],
  );
  deal = (await get("deals")).body.items.find(
    (x) => x.contract_id === contract.id,
  );
  assert.equal(deal.state, "needs_review");
  agreement = (
    await post("agreements", {
      name: "Developer deal commission",
      developerId: developer.id,
      mode: "tiers",
      tiers: [
        { fromMinor: "0", rateBps: 1000 },
        { fromMinor: "2000000", rateBps: 1200 },
      ],
      agentBps: 2000,
      leadBps: 500,
      dueDays: 30,
    })
  ).body;
  const payload = b({
    version: deal.version,
    agreementId: agreement.id,
    agreementVersion: 1,
    date: today,
    agentId: salesP.id,
    leadId: leadP.id,
  });
  await h.post(base + "deals/" + deal.id + "/book", payload);
  await h.post(base + "deals/" + deal.id + "/book", payload);
  const docs = (await get("obligations?limit=100")).body.items.filter(
    (x) => x.deal_id === deal.id,
  );
  dealClaim = docs.find((x) => x.kind === "developer_claim");
  agentPayable = docs.find(
    (x) => x.kind === "commission_payable" && x.total_minor === "20000",
  );
  assert.equal(docs.length, 3);
  assert.equal(dealClaim.net_minor, "100000");
  assert.equal(agentPayable.remainingMinor, "20000");
  h.state.principal = salesP;
  await get("options", 403);
  const own = (await get("self")).body;
  assert.equal(own.items.length, 1);
  assert.equal(own.items[0].total_minor, "20000");
  await get("self?kind=team", 403);
  h.state.principal = leadP;
  assert.ok(
    (await get("self?kind=team")).body.items.some(
      (x) => x.id === agentPayable.id,
    ),
  );
});
test("HR salary advance accounting links existing money movements, and commission offset updates both ledgers once", async () => {
  const due = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  h.state.principal = salesP;
  hrAdvance = (
    await h.post(
      "hr-resources/advances",
      b({
        amountMinor: "5000",
        mode: "lump_sum",
        installments: 1,
        firstDue: due,
        reason: "Personal advance request",
      }),
    )
  ).body;
  h.state.principal = owner;
  await h.post(
    "hr-resources/advances/" + hrAdvance.id + "/action",
    b({ version: 1, action: "approve" }),
  );
  await h.post(
    "hr-resources/advances/" + hrAdvance.id + "/action",
    b({
      version: 2,
      action: "payout",
      date: today,
      reference: "Recorded cash payout",
    }),
  );
  await post("hr-advances/" + hrAdvance.id + "/action", {
    version: 3,
    action: "book_payout",
    treasuryId: bank.id,
    reference: "Actual payout treasury",
  });
  await post(
    "hr-advances/" + hrAdvance.id + "/action",
    { version: 3, action: "book_payout", treasuryId: bank.id },
    409,
  );
  const offset = b({
    version: agentPayable.version,
    action: "offset_advance",
    advanceId: hrAdvance.id,
    advanceVersion: 3,
    amountMinor: "5000",
    date: today,
    reason: "Employee advance offset approved against commission",
  });
  await h.post(
    base + "obligations/" + agentPayable.id + "/settle-advance",
    offset,
  );
  await h.post(
    base + "obligations/" + agentPayable.id + "/settle-advance",
    offset,
  );
  assert.equal(
    (await h.get("hr-resources/advances/" + hrAdvance.id)).body.balanceMinor,
    "0",
  );
  assert.equal(
    (await get("obligations/" + agentPayable.id)).body.remainingMinor,
    "15000",
  );
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::integer AS n FROM tenant.advance_payments WHERE advance_id=$1",
        [hrAdvance.id],
      )
    ).rows[0].n,
    1,
  );
});

test("commission advance offsets reverse atomically and cannot be separately reversed in HR", async () => {
  const a = (await h.get("hr-resources/advances/" + hrAdvance.id)).body,
    pay = a.payments[0];
  await h.post(
    "hr-resources/advances/" + hrAdvance.id + "/action",
    b({
      version: a.version,
      action: "reverse",
      paymentId: pay.id,
      note: "Attempt to reverse accounting-linked receipt",
    }),
    409,
  );
  let o = (await get("obligations/" + agentPayable.id)).body;
  const reverse = b({
    version: o.version,
    action: "reverse_offset",
    settlementId: o.offsets[0].id,
    date: today,
    reason: "Correct mistaken commission offset",
  });
  await h.post(base + "obligations/" + o.id + "/settle-advance", reverse);
  await h.post(base + "obligations/" + o.id + "/settle-advance", reverse);
  assert.equal(
    (await h.get("hr-resources/advances/" + hrAdvance.id)).body.balanceMinor,
    "5000",
  );
  o = (await get("obligations/" + agentPayable.id)).body;
  const current = (await h.get("hr-resources/advances/" + hrAdvance.id)).body;
  await h.post(
    base + "obligations/" + o.id + "/settle-advance",
    b({
      version: o.version,
      action: "offset_advance",
      advanceId: hrAdvance.id,
      advanceVersion: current.version,
      date: today,
      amountMinor: "5000",
      reason: "Re-enter approved correct offset",
    }),
  );
  assert.equal(
    (await h.get("hr-resources/advances/" + hrAdvance.id)).body.balanceMinor,
    "0",
  );
});
test("cancelling a collected deal records a developer refund and recovers paid commissions without deleting history", async () => {
  await post("transactions", {
    kind: "receipt",
    date: today,
    treasuryId: bank.id,
    obligationId: dealClaim.id,
    amountMinor: "100000",
    method: "bank_transfer",
    memo: "Developer paid earned commission",
  });
  await post("transactions", {
    kind: "payment",
    date: today,
    treasuryId: bank.id,
    obligationId: agentPayable.id,
    amountMinor: "10000",
    method: "bank_transfer",
    memo: "Partial employee commission paid",
  });
  await h.db.query(
    "UPDATE tenant.contracts SET status='void',version=version+1 WHERE id=$1",
    [deal.contract_id],
  );
  let d = (await get("deals")).body.items.find((x) => x.id === deal.id);
  assert.equal(d.state, "needs_adjustment");
  await post("deals/" + deal.id + "/action", {
    version: d.version,
    action: "adjust",
    date: today,
    reason: "Contract cancelled and commission recovered",
  });
  const docs = (await get("obligations?limit=100")).body.items.filter(
      (x) => x.deal_id === deal.id,
    ),
    credit = docs.find((x) => x.kind === "credit_note"),
    recovery = docs.find((x) => x.kind === "employee_recovery");
  assert.equal(credit.remainingMinor, "100000");
  assert.equal(recovery.total_minor, "15000");
  assert.equal(
    (await get("obligations/" + agentPayable.id)).body.remainingMinor,
    "0",
  );
  assert.equal(
    (await get("obligations/" + dealClaim.id)).body.remainingMinor,
    "0",
  );
  await post("transactions", {
    kind: "payment",
    date: today,
    treasuryId: bank.id,
    obligationId: credit.id,
    amountMinor: "100000",
    method: "bank_transfer",
    memo: "Actual developer refund",
  });
  assert.equal(
    (await get("obligations/" + credit.id)).body.remainingMinor,
    "0",
  );
});
test("financial statements reconcile to posted journals; drafts and client funds do not inflate revenue", async () => {
  for (const kind of ["trial_balance", "balance_sheet", "cash_flow"]) {
    const r = (
      await get("reports?kind=" + kind + "&from=" + today + "&to=" + today)
    ).body;
    assert.equal(r.summary.differenceMinor, "0", kind);
  }
  const before = (
    await get("reports?kind=profit_loss&from=" + today + "&to=" + today)
  ).body.summary.revenueMinor;
  const customer = (
    await post("parties", { name: "Installment buyer", kind: "customer" })
  ).body;
  const o = (
    await post("obligations", {
      kind: "customer_funds",
      partyId: customer.id,
      developerId: developer.id,
      date: today,
      dueDate: today,
      netMinor: "10000",
      description: "Buyer installment held for developer",
    })
  ).body;
  await post("obligations/" + o.id + "/action", {
    version: 1,
    action: "submit",
  });
  await post("obligations/" + o.id + "/action", {
    version: 2,
    action: "approve",
  });
  await post("obligations/" + o.id + "/action", { version: 3, action: "post" });
  await post("transactions", {
    kind: "receipt",
    date: today,
    treasuryId: bank.id,
    obligationId: o.id,
    amountMinor: "10000",
    memo: "Buyer funds received",
  });
  assert.equal(
    (await get("reports?kind=profit_loss&from=" + today + "&to=" + today)).body
      .summary.revenueMinor,
    before,
  );
  assert.equal((await get("overview")).body.summary.clientFundsMinor, "10000");
  const aging = (await get("reports?kind=aging&to=" + today)).body;
  assert.ok(aging.items.some((x) => x.id === claim.id));
  const ledger = (
    await get(
      "reports?kind=account_statement&accountId=" +
        cash.id +
        "&from=" +
        today +
        "&to=" +
        today,
    )
  ).body;
  assert.ok(ledger.items.length > 0);
});

test("installment schedules split exactly, distinguish developer collections and cancel into customer refunds", async () => {
  const customer = (
    await post("parties", { kind: "customer", name: "Plan customer" })
  ).body;
  const y = Number(today.slice(0, 4)) + 1;
  const plan = (
    await post("installment-plans", {
      customerId: customer.id,
      developerId: developer.id,
      date: today,
      firstDue: y + "-01-31",
      totalMinor: "10001",
      installments: 3,
      intervalMonths: 1,
      collectionOwner: "developer",
      description: "Developer direct installments",
    })
  ).body;
  let installments = (await get("obligations?limit=100")).body.items.filter(
    (x) => x.plan_id === plan.id,
  );
  assert.deepEqual(installments.map((x) => x.net_minor).sort(), [
    "3333",
    "3333",
    "3335",
  ]);
  assert.deepEqual(installments.map((x) => x.due_date).sort(), [
    y + "-01-31",
    y + "-02-" + String(new Date(Date.UTC(y, 2, 0)).getUTCDate()),
    y + "-03-31",
  ]);
  const before = (await get("journals")).body.total;
  await post("installment-plans/" + plan.id + "/action", {
    version: 1,
    action: "approve",
  });
  assert.equal((await get("journals")).body.total, before);
  installments = (await get("obligations?limit=100")).body.items.filter(
    (x) => x.plan_id === plan.id,
  );
  await post("obligations/" + installments[0].id + "/action", {
    version: installments[0].version,
    action: "external_collection",
    date: today,
    amountMinor: "100",
    reference: "Developer receipt reference",
  });
  assert.equal((await get("journals")).body.total, before);
  const previousFunds = (await get("overview")).body.summary.clientFundsMinor;
  const internal = (
    await post("installment-plans", {
      customerId: customer.id,
      developerId: developer.id,
      date: today,
      firstDue: today,
      totalMinor: "12300",
      installments: 3,
      collectionOwner: "company",
      description: "Company collects client funds",
    })
  ).body;
  await post("installment-plans/" + internal.id + "/action", {
    version: 1,
    action: "approve",
  });
  const first = (await get("obligations?limit=100")).body.items.find(
    (x) => x.plan_id === internal.id,
  );
  await post("transactions", {
    kind: "receipt",
    date: today,
    treasuryId: bank.id,
    obligationId: first.id,
    amountMinor: "500",
    memo: "Partial client installment",
  });
  await post("installment-plans/" + internal.id + "/action", {
    version: 2,
    action: "cancel",
    date: today,
    reason: "Client cancelled installment agreement",
  });
  const credits = (await get("obligations?limit=100")).body.items.filter(
    (x) => x.kind === "credit_note" && x.party_id === customer.id,
  );
  assert.equal(
    credits.reduce((s, x) => s + BigInt(x.remainingMinor), 0n),
    500n,
  );
  assert.equal(
    (await get("overview")).body.summary.clientFundsMinor,
    previousFunds,
  );
});

test("collection targets, performance and reminder deliveries use real data and are deduplicated per day", async () => {
  const target = (
    await post("collection-targets", {
      name: "Commission collection goal",
      from: today,
      to: today,
      amountMinor: "100000",
    })
  ).body;
  assert.ok(target.id);
  await post(
    "collection-targets",
    { name: "Overlapping goal", from: today, to: today, amountMinor: "1" },
    409,
  );
  const collections = (
    await get("reports?kind=collections&from=" + today + "&to=" + today)
  ).body;
  assert.equal(collections.summary.targetMinor, "100000");
  assert.equal(collections.summary.actualMinor, "0");
  assert.ok(collections.items.some((x) => BigInt(x.amount_minor) < 0n));
  for (const kind of ["sales_performance", "expenses_by_centre", "tax"])
    assert.ok(
      Array.isArray(
        (await get("reports?kind=" + kind + "&from=" + today + "&to=" + today))
          .body.items,
      ),
    );
  const first = await runFinanceSweep(h.database);
  assert.ok(first.notifications > 0);
  assert.equal((await runFinanceSweep(h.database)).notifications, 0);
  const unexpected = (
    await h.db.query(
      "SELECT n.user_id FROM tenant.notifications n WHERE n.kind LIKE 'finance.%' AND n.user_id=ANY($1::uuid[])",
      [[salesP.id, leadP.id]],
    )
  ).rows;
  assert.equal(unexpected.length, 0);
});
test("bank reconciliation matches actual selected lines and checked supporting files stay company private", async () => {
  const lines = (
    await get("reconciliation-lines?treasuryId=" + bank.id + "&to=" + today)
  ).body;
  await post(
    "reconciliations",
    {
      treasuryId: bank.id,
      date: today,
      statementMinor: "1",
      lineIds: lines.items.map((x) => x.id),
    },
    400,
  );
  await post("reconciliations", {
    treasuryId: bank.id,
    date: today,
    statementMinor: lines.bookBalanceMinor,
    lineIds: lines.items.map((x) => x.id),
  });
  const upload = await h
    .api()
    .post("/api/v1/accounting/files/obligations/" + claim.id)
    .set("Origin", h.origin)
    .set("Cookie", "__Host-mujez_session=" + "a".repeat(64))
    .field("requestId", randomUUID())
    .attach("file", Buffer.from("%PDF-1.4\nFinance verification only\n"), {
      filename: "qa-invoice.pdf",
      contentType: "application/pdf",
    })
    .expect(201);
  const files = (await get("files/obligations/" + claim.id)).body;
  assert.equal(files.items[0].id, upload.body.id);
  await h
    .api()
    .get("/api/v1/accounting/print/obligations/" + claim.id)
    .set("Cookie", "__Host-mujez_session=" + "a".repeat(64))
    .expect(200)
    .expect("Content-Type", /application\/pdf/);
  h.state.principal = other;
  await get("files/obligations/" + claim.id, 404);
  await get("attachments/" + upload.body.id + "/download", 404);
});

test("completed bank statements block backdated postings and can be reopened by a finance approver", async () => {
  const statement = (await get("reconciliations")).body.items[0];
  const body = {
    kind: "receipt",
    date: today,
    treasuryId: bank.id,
    counterAccountId: equity.id,
    amountMinor: "100",
    cashFlow: "financing",
    memo: "Owner contribution after statement",
  };
  await post("transactions", body, 400);
  h.state.principal = accountant;
  await post(
    "reconciliations/" + statement.id + "/action",
    {
      version: statement.version,
      action: "reopen",
      reason: "Correction needed",
    },
    403,
  );
  h.state.principal = owner;
  await post("reconciliations/" + statement.id + "/action", {
    version: statement.version,
    action: "reopen",
    reason: "Bank confirmed additional transaction",
  });
  await post("transactions", body);
  const lines = (
    await get("reconciliation-lines?treasuryId=" + bank.id + "&to=" + today)
  ).body;
  await post("reconciliations", {
    treasuryId: bank.id,
    date: today,
    statementMinor: lines.bookBalanceMinor,
    lineIds: lines.items.map((x) => x.id),
  });
});

test("party statements show control-account debt instead of cancelling it against revenue", async () => {
  const r = (
    await get(
      "reports?kind=party_statement&partyId=" +
        developer.id +
        "&from=" +
        today +
        "&to=" +
        today,
    )
  ).body;
  assert.ok(!r.items.some((x) => x.account_code === "4100"));
  assert.equal(r.summary.closingMinor, "104000");
  const history = (await get("history/obligations/" + claim.id)).body;
  assert.ok(
    history.items.some(
      (x) =>
        x.kind.startsWith("request.obligation.create") &&
        x.details.input.netMinor === "100000",
    ),
  );
});
