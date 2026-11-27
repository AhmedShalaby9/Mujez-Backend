import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
let h, owner, other, sessions;
async function invite(name, roles) {
  const b = (
    await h.post("team/invite", {
      name,
      email: name.toLowerCase() + "@example.test",
      roles,
    })
  ).body;
  await h.post(
    "team/activate",
    { token: b.token, password: "test-password-manager" },
    200,
  );
  return (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [b.accountId],
    )
  ).rows[0];
}
async function current(a) {
  return (await h.get("team")).body.items.find((x) => x.id === a.id);
}
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
  other.permissions.push("team.read", "team.manage");
  sessions = new SessionService(h.database, { consume: async () => true });
});
after(async () => h?.close());
afterEach(() => {
  h.state.principal = owner;
});
test("owner sets, clears and audits a direct manager; stale versions and self/loop reports are rejected", async () => {
  const leader = await invite("TeamLeader", ["team_leader"]);
  const manager = await invite("SalesManager", ["sales_manager"]);
  const director = await invite("SalesDirector", ["sales_director"]);
  let row = await current(leader);
  assert.equal(row.reportsToUserId, null);
  // A non-owner company user (even with team.manage) cannot set a manager.
  h.state.principal = { ...(await sessions.employeeProfile(leader)) };
  await h.post(
    "team/" + leader.id + "/manager",
    { reportsToUserId: manager.user_id, version: row.rolesVersion },
    403,
  );
  // A different company's owner cannot reach this company's roster either.
  h.state.principal = other;
  await h.post(
    "team/" + leader.id + "/manager",
    { reportsToUserId: manager.user_id, version: row.rolesVersion },
    404,
  );
  h.state.principal = owner;
  await h.post(
    "team/" + leader.id + "/manager",
    { reportsToUserId: leader.user_id, version: row.rolesVersion },
    400,
  );
  const saved = (
    await h.post("team/" + leader.id + "/manager", {
      reportsToUserId: manager.user_id,
      version: row.rolesVersion,
    })
  ).body;
  assert.equal(saved.reportsToUserId, manager.user_id);
  assert.equal(saved.rolesVersion, row.rolesVersion + 1);
  row = await current(leader);
  assert.equal(row.reportsToUserId, manager.user_id);
  const audit = (
    await h.db.query(
      "SELECT after FROM tenant.audit_logs WHERE company_id=$1 AND resource_id=$2 AND action='employee.manager_changed'",
      [owner.companyId, leader.user_id],
    )
  ).rows[0];
  assert.deepEqual(audit.after, { reportsToUserId: manager.user_id });
  // Stale version is rejected.
  await h.post(
    "team/" + leader.id + "/manager",
    { reportsToUserId: director.user_id, version: row.rolesVersion - 1 },
    409,
  );
  // Chaining the manager up the ladder works...
  let mgrRow = await current(manager);
  await h.post("team/" + manager.id + "/manager", {
    reportsToUserId: director.user_id,
    version: mgrRow.rolesVersion,
  });
  // ...but pointing the director back down into the chain is a loop.
  const dirRow = await current(director);
  await h.post(
    "team/" + director.id + "/manager",
    { reportsToUserId: leader.user_id, version: dirRow.rolesVersion },
    409,
  );
  // Clearing the manager works and still bumps the version.
  row = await current(leader);
  const cleared = (
    await h.post("team/" + leader.id + "/manager", {
      reportsToUserId: null,
      version: row.rolesVersion,
    })
  ).body;
  assert.equal(cleared.reportsToUserId, null);
  row = await current(leader);
  assert.equal(row.reportsToUserId, null);
});
