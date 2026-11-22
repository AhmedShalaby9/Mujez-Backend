import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
import { runFinanceAutomation } from "../dist/modules/finance/accounting/finance-automation-sweep.js";
import { runFinanceSweep } from "../dist/modules/finance/accounting/finance-sweep.js";
let h, owner, other;
const b = (x) => ({ requestId: randomUUID(), ...x });
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  owner.permissions.push("team.read", "team.manage");
});
after(() => h?.close());
const toggle = (on) =>
  h.db.query("UPDATE platform.companies SET finance_enabled=$2 WHERE id=$1", [
    owner.companyId,
    on,
  ]);
test("Finance off blocks reads, writes, files, payroll and stale-session access, preserves data and leaves CRM and HR independent", async () => {
  await h.post("accounting/setup", b({ year: 2026 }));
  const original = (await h.get("accounting/options")).body.accounts;
  await toggle(false);
  h.state.principal = { ...owner, company: { financeEnabled: true } };
  for (const path of [
    "context",
    "options",
    "overview",
    "reports",
    "journals",
    "treasuries",
    "transactions",
    "obligations",
    "deals",
    "commission-policies",
    "automation-rules",
    "staff-statements",
    "payroll-context",
    "payroll-runs",
    "salary-profiles",
    "attachments/" + randomUUID() + "/download",
    "files/journals/" + randomUUID(),
    "print/journals/" + randomUUID(),
  ]) {
    const r = await h.get("accounting/" + path, 403);
    assert.equal(r.body.code, "finance_module_disabled", path);
  }
  for (const [path, payload] of [
    ["setup", { year: 2026 }],
    [
      "journals",
      {
        date: "2026-11-22",
        memo: "Blocked journal",
        lines: [
          { accountId: randomUUID(), debitMinor: "100" },
          { accountId: randomUUID(), creditMinor: "100" },
        ],
      },
    ],
    ["automation-process", { version: 1, action: "process" }],
  ]) {
    const r = await h.post("accounting/" + path, b(payload), 403);
    assert.equal(r.body.code, "finance_module_disabled", path);
  }
  for (const path of [
    "leads",
    "tasks",
    "team",
    "commissions",
    "commissions/options",
    "hr/employees",
  ])
    await h.get(path);
  h.state.principal = other;
  await h.get("accounting/context");
  h.state.principal = owner;
  await toggle(true);
  assert.deepEqual((await h.get("accounting/options")).body.accounts, original);
});
test("existing staff sessions refresh the module flag; self statements and background finance stop while disabled", async () => {
  const invite = (
    await h.post("team/invite", {
      name: "Optional Finance Agent",
      email: "optional-finance@example.test",
      roles: ["agent", "employee"],
    })
  ).body;
  await h.post(
    "team/activate",
    { token: invite.token, password: "optional-finance-test-password" },
    200,
  );
  const sessions = new SessionService(h.database, {
    consume: async () => true,
  });
  const login = await sessions.loginEmployee(
    "optional-finance@example.test",
    "optional-finance-test-password",
    false,
    "127.0.0.1",
  );
  await toggle(false);
  const principal = await sessions.resolveEmployee(login.token);
  assert.equal(principal.company.financeEnabled, false);
  h.state.principal = { ...principal, company: { financeEnabled: true } };
  assert.equal(
    (await h.get("accounting/self", 403)).body.code,
    "finance_module_disabled",
  );
  await h.get("commissions");
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int n FROM platform.finance_reminder_companies WHERE company_id=$1",
        [owner.companyId],
      )
    ).rows[0].n,
    0,
  );
  assert.equal((await runFinanceAutomation(h.database)).processed, 0);
  await runFinanceSweep(h.database);
  await toggle(true);
  assert.equal(
    (await sessions.resolveEmployee(login.token)).company.financeEnabled,
    true,
  );
  h.state.principal = owner;
});

test("migration keeps existing Finance access and makes new companies opt in", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { readFile, readdir } = await import("node:fs/promises");
  const db = new PGlite();
  try {
    for (const name of (
      await readdir(new URL("../database/migrations/", import.meta.url))
    )
      .sort()
      .filter((n) => n < "064"))
      await db.exec(
        await readFile(
          new URL("../database/migrations/" + name, import.meta.url),
          "utf8",
        ),
      );
    await db.query(
      "INSERT INTO platform.companies(public_id,slug,name) VALUES('MJ-legacy','legacy',jsonb_build_object('en','Legacy','ar','Legacy'))",
    );
    await db.exec(
      await readFile(
        new URL(
          "../database/migrations/064_company_finance_module.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.query(
      "INSERT INTO platform.companies(public_id,slug,name) VALUES('MJ-new','new',jsonb_build_object('en','New','ar','New'))",
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT slug,finance_enabled FROM platform.companies ORDER BY slug",
        )
      ).rows,
      [
        { slug: "legacy", finance_enabled: true },
        { slug: "new", finance_enabled: false },
      ],
    );
  } finally {
    await db.close();
  }
});

test("AI module is independent of CRM/Finance and rejects recommendation and analytics reads from stale sessions", async () => {
  h.state.principal = owner;
  await h.db.query(
    "UPDATE platform.companies SET ai_enabled=false WHERE id=$1",
    [owner.companyId],
  );
  h.state.principal = { ...owner, company: { aiEnabled: true } };
  for (const path of [
    "company-ai-insights/snapshot",
    "company-ai-insights",
    "leads/" + randomUUID() + "/unit-recommendations",
    "leads/" + randomUUID() + "/unit-recommendations/options",
  ])
    assert.equal((await h.get(path, 403)).body.code, "ai_module_disabled");
  h.state.principal = {
    ...owner,
    pool: "company_user",
    role: "team_lead",
    roles: ["team_lead", "employee"],
    permissions: [...owner.permissions, "team.self.read"],
    company: { aiEnabled: true },
  };
  assert.equal(
    (await h.get("team/my-team/ai-insights/snapshot", 403)).body.code,
    "ai_module_disabled",
  );
  h.state.principal = owner;
  await h.get("leads");
  await h.get("commissions");
  await h.get("accounting/context");
  await h.db.query(
    "UPDATE platform.companies SET ai_enabled=true WHERE id=$1",
    [owner.companyId],
  );
});
