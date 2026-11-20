import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
import { deliverEmployeeActivation } from "../dist/modules/identity/welcome/employee-delivery.js";
import { unseal } from "../dist/modules/identity/welcome/welcome.service.js";
let h, owner, other, employee, account, sessions, login;
const env = {
  WELCOME_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  DASHBOARD_URL: "https://app.example.test/",
};
const body = (b) => ({ requestId: randomUUID(), ...b });
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  sessions = new SessionService(h.database, { consume: async () => true });
});
after(() => h?.close());
afterEach(() => {
  h.state.principal = owner;
  h.state.failAudit = false;
});
const job = async () =>
  (
    await h.db.query(
      "SELECT * FROM platform.employee_activation_emails WHERE employee_id=$1",
      [employee.id],
    )
  ).rows[0];
test("HR creation atomically provisions one Employee-only account and an encrypted activation email; replay sends no duplicate", async () => {
  const b = body({
    name: "Personal employee",
    email: "personal@example.test",
    notes: "Private HR note",
  });
  employee = (await h.post("hr/employees", b)).body;
  assert.ok(employee.userId);
  assert.equal(employee.crmStatus, "invited");
  assert.equal(employee.loginDelivery, "queued");
  assert.equal((await h.post("hr/employees", b)).body.id, employee.id);
  account = (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE user_id=$1",
      [employee.userId],
    )
  ).rows[0];
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM platform.company_employee_invitations WHERE account_id=$1",
        [account.id],
      )
    ).rows[0].n,
    1,
  );
  const queued = await job();
  assert.ok(queued.ciphertext);
  assert.ok(!JSON.stringify(employee).includes("ciphertext"));
  const payload = JSON.parse(
    unseal(
      queued.ciphertext,
      env.WELCOME_ENCRYPTION_KEY,
      employee.id + ":" + queued.generation,
    ),
  );
  assert.ok(payload.token);
  assert.ok(
    !(
      await h.db.query(
        "SELECT response FROM tenant.sales_requests WHERE request_id=$1",
        [b.requestId],
      )
    ).rows[0].response.token,
  );
  await assert.rejects(
    sessions.loginEmployee(account.email, "not-set", false, "127.0.0.1"),
    (e) => e.getStatus() === 401,
  );
});
test("activation email uses the secure activation route; mail acceptance wipes the token and activation enables password login", async () => {
  let message;
  const result = await deliverEmployeeActivation(h.database, env, {
    sendMail: async (m) => {
      message = m;
      return { accepted: [account.email], rejected: [] };
    },
  });
  assert.equal(result.accepted, 1);
  assert.equal(message.from.address, "info@mujez.net");
  assert.equal(message.to, account.email);
  const token = message.text.match(/#token=([a-f0-9]{64})/)[1];
  assert.ok(
    message.text.includes("https://app.example.test/activate/team#token="),
  );
  assert.equal((await job()).ciphertext, null);
  const password = "personal-employee-password-2026";
  await h.post("team/activate", { token, password }, 200);
  await h.post("team/activate", { token, password }, 400);
  login = await sessions.loginEmployee(
    account.email,
    password,
    false,
    "127.0.0.1",
  );
  const p = await sessions.resolveEmployee(login.token);
  assert.deepEqual(p.roles, ["employee"]);
  assert.deepEqual(p.permissions, ["leave.self"]);
  h.state.principal = p;
  const own = (await h.get("employee/me")).body;
  assert.equal(own.employee.employeeCode, employee.employeeCode);
  assert.equal(own.employee.notes, undefined);
  for (const path of [
    "leads",
    "tasks",
    "pipeline",
    "hr/employees",
    "team",
    "company-overview",
  ])
    await h.get(path, 403);
  await h.get("leave/context");
});
test("mixed roles preserve the same account and personal scope, while disabling HR keeps login available without HR data", async () => {
  const member = (await h.get("team")).body.items.find(
    (x) => x.id === account.id,
  );
  await h.post("team/" + account.id + "/roles", {
    roles: ["agent", "employee"],
    version: member.rolesVersion,
  });
  const p = await sessions.resolveEmployee(login.token);
  assert.ok(p.roles.includes("agent"));
  assert.equal(p.scope, "own");
  h.state.principal = p;
  await h.get("leads");
  await h.db.query(
    "UPDATE platform.companies SET hr_enabled=false WHERE id=$1",
    [owner.companyId],
  );
  assert.deepEqual((await h.get("employee/me")).body, {
    hrEnabled: false,
    employee: null,
  });
  await h.get("leave/context", 403);
  await h.db.query(
    "UPDATE platform.companies SET hr_enabled=true WHERE id=$1",
    [owner.companyId],
  );
});
test("required and duplicate emails, disabled accounts and audit failures cannot create duplicate or partial login records", async () => {
  await h.post(
    "hr/employees",
    body({ name: "Missing email", email: null }),
    400,
  );
  await h.post(
    "hr/employees",
    body({ name: "Duplicate email", email: "PERSONAL@example.test" }),
    409,
  );
  h.state.failAudit = true;
  await h.post(
    "hr/employees",
    body({ name: "Rolled back login", email: "rollback-login@example.test" }),
    500,
  );
  h.state.failAudit = false;
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM platform.company_employee_accounts WHERE email='rollback-login@example.test'",
      )
    ).rows[0].n,
    0,
  );
  assert.equal((await h.get("hr/employees?q=Rolled%20back")).body.total, 0);
});
test("resends rotate invitations without resetting active logins; queued email retries safely and cross-company access is denied", async () => {
  const e = (
    await h.post(
      "hr/employees",
      body({ name: "Retry employee", email: "retry-person@example.test" }),
    )
  ).body;
  const old = (
    await h.db.query(
      "SELECT * FROM platform.employee_activation_emails WHERE employee_id=$1",
      [e.id],
    )
  ).rows[0];
  const oldToken = JSON.parse(
    unseal(
      old.ciphertext,
      env.WELCOME_ENCRYPTION_KEY,
      e.id + ":" + old.generation,
    ),
  ).token;
  await h.post(
    "hr/employees/" + e.id + "/login-invitation",
    body({ version: e.version }),
  );
  await h.post(
    "team/activate",
    { token: oldToken, password: "expired-token-password" },
    400,
  );
  const failed = await deliverEmployeeActivation(h.database, env, {
    sendMail: async () => {
      throw Error("SMTP offline");
    },
  });
  assert.equal(failed.accepted, 0);
  const retry = (
    await h.db.query(
      "SELECT * FROM platform.employee_activation_emails WHERE employee_id=$1",
      [e.id],
    )
  ).rows[0];
  assert.equal(retry.status, "retry");
  assert.ok(retry.ciphertext);
  await h.db.query(
    "UPDATE platform.employee_activation_emails SET next_attempt_at=now() WHERE employee_id=$1",
    [e.id],
  );
  assert.equal(
    (
      await deliverEmployeeActivation(h.database, env, {
        sendMail: async () => ({
          accepted: ["retry-person@example.test"],
          rejected: [],
        }),
      })
    ).accepted,
    1,
  );
  h.state.principal = other;
  await h.post(
    "hr/employees/" + e.id + "/login-invitation",
    body({ version: e.version }),
    404,
  );
  await assert.rejects(
    h.database.tenant(other.companyId, (c) =>
      c.query(
        "SELECT tenant.provision_employee_login($1,$2,$3,$4,$5,$6,false)",
        [
          owner.companyId,
          e.id,
          other.id,
          "a".repeat(64),
          randomUUID(),
          "invalid",
        ],
      ),
    ),
    (e) => e.code === "42501",
  );
});
