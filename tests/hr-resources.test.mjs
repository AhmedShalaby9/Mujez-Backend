import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
import { repaymentPlan } from "../dist/modules/hr/resources/resources.schema.js";
let h, owner, other, staffP, hrP, officerP, staff, asset, advance;
const b = (x) => ({ requestId: randomUUID(), ...x });
async function invite(name, roles) {
  h.state.principal = owner;
  const a = (
    await h.post("team/invite", { name, email: name + "@example.test", roles })
  ).body;
  await h.post(
    "team/activate",
    { token: a.token, password: "resources-fixture-password" },
    200,
  );
  const account = (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [a.accountId],
    )
  ).rows[0];
  return new SessionService(h.database, {
    consume: async () => true,
  }).employeeProfile(account);
}
const path = "hr-resources/";
const detail = () => h.get(path + "advances/" + advance.id);
const act = async (action, extra = {}, status = 201) => {
  const r = (await detail()).body;
  return h.post(
    path + "advances/" + advance.id + "/action",
    b({ version: r.version, action, ...extra }),
    status,
  );
};
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  staffP = await invite("ResourceStaff", ["agent", "employee"]);
  hrP = await invite("ResourceManager", ["hr_manager", "employee"]);
  officerP = await invite("ResourceOfficer", ["hr_officer", "employee"]);
  staff = (
    await h.db.query("SELECT * FROM tenant.hr_employees WHERE user_id=$1", [
      staffP.id,
    ])
  ).rows[0];
  h.state.principal = owner;
});
after(() => h?.close());
afterEach(() => {
  h.state.principal = owner;
  h.state.failAudit = false;
});
test("monthly repayments clamp month-end and preserve every minor unit", () => {
  const p = repaymentPlan("10000", "2027-01-31", 3, "3334", "2027-03-01");
  assert.deepEqual(
    p.map((x) => x.dueDate),
    ["2027-01-31", "2027-02-28", "2027-03-31"],
  );
  assert.deepEqual(
    p.map((x) => x.amountMinor),
    ["3333", "3333", "3334"],
  );
  assert.equal(p[1].paidMinor, "1");
  assert.equal(p[1].overdue, true);
});
test("assets are private, versioned, require HR and roll back on audit failure", async () => {
  h.state.principal = staffP;
  await h.get(path + "assets?view=company", 403);
  await h.post(
    path + "assets",
    b({ kind: "laptop", name: "QA laptop", details: {} }),
    403,
  );
  h.state.principal = owner;
  h.state.failAudit = true;
  await h.post(
    path + "assets",
    b({ kind: "laptop", name: "Rollback", details: {} }),
    500,
  );
  h.state.failAudit = false;
  assert.equal(
    (await h.db.query("SELECT count(*) FROM tenant.company_assets")).rows[0]
      .count,
    0,
  );
  const body = b({
    kind: "laptop",
    name: "QA Laptop",
    details: { brand: "Test", serial: "S-1", notes: "Private procurement" },
  });
  asset = (await h.post(path + "assets", body)).body;
  assert.equal(asset.code, "AST-0001");
  assert.equal((await h.post(path + "assets", body)).body.id, asset.id);
  await h.post(
    path + "assets/" + asset.id,
    b({ version: 99, kind: "laptop", name: "Stale", details: {} }),
    409,
  );
  h.state.principal = other;
  await h.get(path + "assets/" + asset.id, 404);
});
test("custody, own acknowledgment, returns and offboarding warnings retain history", async () => {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Africa/Cairo",
  });
  await h.post(
    path + "assets/" + asset.id + "/action",
    b({
      version: 1,
      action: "assign",
      employeeId: staff.id,
      date: today,
      condition: "New in box",
    }),
  );
  await h.post(
    path + "assets/" + asset.id + "/action",
    b({
      version: 2,
      action: "assign",
      employeeId: staff.id,
      date: today,
      condition: "Second assignment",
    }),
    409,
  );
  await h.post(
    path + "assets/" + asset.id,
    b({
      version: 2,
      kind: "laptop",
      name: "QA Laptop",
      details: {},
      status: "retired",
    }),
    409,
  );
  h.state.principal = hrP;
  await h.post(
    path + "assets/" + asset.id + "/action",
    b({ version: 2, action: "acknowledge" }),
    403,
  );
  h.state.principal = staffP;
  const own = (await h.get(path + "assets?view=my")).body;
  assert.equal(own.total, 1);
  assert.equal(own.items[0].details.notes, undefined);
  await h.post(
    path + "assets/" + asset.id + "/action",
    b({ version: 2, action: "acknowledge" }),
  );
  h.state.principal = owner;
  const r = (await h.get(path + "assets/" + asset.id)).body;
  assert.ok(r.acknowledgedAt);
  await h.post(
    path + "assets/" + asset.id + "/action",
    b({
      version: r.version,
      action: "return",
      date: today,
      condition: "Good condition",
    }),
  );
  const history = (await h.get(path + "assets/" + asset.id)).body;
  assert.equal(history.status, "available");
  assert.equal(history.history.length, 1);
  assert.equal(history.history[0].return_condition, "Good condition");
});
test("former custodians never see the next employee's identity or HR notes", async () => {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Africa/Cairo",
  });
  const e = (
    await h.db.query("SELECT id FROM tenant.hr_employees WHERE user_id=$1", [
      hrP.id,
    ])
  ).rows[0];
  const r = (await h.get(path + "assets/" + asset.id)).body;
  await h.post(
    path + "assets/" + asset.id + "/action",
    b({
      version: r.version,
      action: "assign",
      employeeId: e.id,
      date: today,
      condition: "Reissued",
    }),
  );
  h.state.principal = staffP;
  const list = (await h.get(path + "assets?view=my")).body;
  assert.equal(list.total, 1);
  assert.equal(list.items[0].employeeId, null);
  assert.equal(list.items[0].previousCustody, true);
  const own = (await h.get(path + "assets/" + asset.id)).body;
  assert.equal(own.employeeId, null);
  assert.equal(own.history.length, 1);
  assert.equal(own.history[0].employee_id, staff.id);
  assert.equal(own.details.notes, undefined);
  h.state.principal = officerP;
  await h.get(path + "advances?view=company", 403);
  const dbRows = await h.database.tenant(other.companyId, (c) =>
    c.query("SELECT id FROM tenant.company_assets WHERE id=$1", [asset.id]),
  );
  assert.equal(dbRows.rows.length, 0);
});
test("only employee can request, only HR manager/owner review, reason and no self approval", async () => {
  const firstDue = new Date(Date.now() + 40 * 86400000)
    .toISOString()
    .slice(0, 10);
  h.state.principal = staffP;
  advance = (
    await h.post(
      path + "advances",
      b({
        amountMinor: "10000",
        mode: "monthly",
        installments: 3,
        firstDue,
        reason: "Household costs",
      }),
    )
  ).body;
  await h.get(path + "advances?view=company", 403);
  await act("approve", {}, 403);
  h.state.principal = officerP;
  await h.get(path + "advances?view=company", 403);
  await h.post(
    path + "advances/" + advance.id + "/action",
    b({ version: 1, action: "approve" }),
    403,
  );
  h.state.principal = hrP;
  await act("reject", {}, 400);
  await act("approve");
  const self = (
    await h.post(
      path + "advances",
      b({
        amountMinor: "10000",
        mode: "lump_sum",
        installments: 1,
        firstDue,
        reason: "Own request",
      }),
    )
  ).body;
  await h.post(
    path + "advances/" + self.id + "/action",
    b({ version: 1, action: "approve" }),
    403,
  );
  h.state.principal = other;
  await h.get(path + "advances/" + advance.id, 404);
});
test("manual payout, partial repayment, exact balance, reversals and stale protection", async () => {
  h.state.principal = hrP;
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Africa/Cairo",
  });
  await act("repay", { date: today, amountMinor: "100" }, 409);
  await act("payout", { date: today, reference: "Manual bank reference" });
  const r = (await detail()).body;
  assert.equal(r.balanceMinor, "10000");
  assert.equal(r.repaidMinor, "0");
  const body = b({
    version: r.version,
    action: "repay",
    date: today,
    amountMinor: "2500",
    reference: "Receipt #1",
  });
  await h.post(path + "advances/" + advance.id + "/action", body);
  await h.post(path + "advances/" + advance.id + "/action", body);
  assert.equal((await detail()).body.balanceMinor, "7500");
  await act("repay", { date: today, amountMinor: "7501" }, 400);
  const stale = b({
    version: r.version,
    action: "repay",
    date: today,
    amountMinor: "100",
  });
  await h.post(path + "advances/" + advance.id + "/action", stale, 409);
  await act("repay", { date: today, amountMinor: "7500" });
  let paid = (await detail()).body;
  assert.equal(paid.status, "paid");
  assert.equal(paid.balanceMinor, "0");
  const payment = paid.payments[0];
  await act("reverse", {
    paymentId: payment.id,
    note: "Receipt entered in error",
  });
  paid = (await detail()).body;
  assert.equal(paid.status, "active");
  assert.equal(paid.balanceMinor, "7500");
  assert.ok(paid.payments[0].reversed_at);
  await act(
    "reverse",
    { paymentId: payment.id, note: "Duplicate reversal" },
    409,
  );
  h.state.principal = staffP;
  assert.equal((await detail()).body.balanceMinor, "7500");
  assert.equal((await h.get(path + "advances?view=my")).body.total, 1);
});
test("module toggle and audit failure block writes without changing balances", async () => {
  h.state.principal = hrP;
  const r = (await detail()).body;
  h.state.failAudit = true;
  await act(
    "repay",
    {
      date: new Date().toLocaleDateString("en-CA", {
        timeZone: "Africa/Cairo",
      }),
      amountMinor: "100",
    },
    500,
  );
  h.state.failAudit = false;
  assert.equal((await detail()).body.balanceMinor, r.balanceMinor);
  await h.db.query(
    "UPDATE platform.companies SET hr_enabled=false WHERE id=$1",
    [owner.companyId],
  );
  await h.get(path + "assets?view=company", 403);
  await h.get(path + "advances?view=my", 403);
  await h.db.query(
    "UPDATE platform.companies SET hr_enabled=true WHERE id=$1",
    [owner.companyId],
  );
});
