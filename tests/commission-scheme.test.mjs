import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";

let h, owner, advisor;
const salesPerms = ["leads.read", "leads.manage", "commissions.read"];

before(async () => {
  h = await tenantHarness();
  owner = { ...h.principals[0], company: { type: "brokerage" } };
  await h.db.query(
    "UPDATE platform.companies SET company_type='brokerage' WHERE id=$1",
    [owner.companyId],
  );
  const role = (
    await h.db.query(
      "INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES($1,'property_advisor','{}',$2,'own') RETURNING id",
      [owner.companyId, salesPerms],
    )
  ).rows[0].id;
  const id = (
    await h.db.query(
      "INSERT INTO tenant.users(company_id,oidc_subject,identity_pool,name,email,role_id,status) VALUES($1,$2,'company_user','Advisor','advisor@scheme.test',$3,'active') RETURNING id",
      [owner.companyId, "scheme-advisor", role],
    )
  ).rows[0].id;
  advisor = {
    ...owner,
    id,
    pool: "company_user",
    role: "property_advisor",
    scope: "own",
    permissions: salesPerms,
    name: "Advisor",
  };
});
after(async () => h.close());

test("defaults, owner-only edits, per-role optimistic concurrency, and brokerage-only access", async () => {
  h.state.principal = owner;
  const empty = (await h.get("brokerage/commission-scheme")).body;
  assert.equal(empty.roles.length, 8);
  assert.ok(
    empty.roles.every(
      (r) => r.monthlyTarget === 0 && r.version === 0 && r.tiers.length === 0,
    ),
  );

  h.state.principal = advisor;
  const readAsAdvisor = (await h.get("brokerage/commission-scheme")).body;
  assert.equal(readAsAdvisor.roles.length, 8);
  await h.post(
    "brokerage/commission-scheme",
    {
      requestId: randomUUID(),
      roles: empty.roles.map((r) =>
        r.roleKey === "property_advisor" ? { ...r, monthlyTarget: 5000000 } : r,
      ),
    },
    403,
  );

  h.state.principal = owner;
  const saved = (
    await h.post("brokerage/commission-scheme", {
      requestId: randomUUID(),
      roles: empty.roles.map((r) => {
        if (r.roleKey === "property_advisor")
          return {
            ...r,
            monthlyTarget: 5000000,
            quarterlyTarget: 15000000,
            tiers: [
              { kind: "volume", threshold: 15000000, ratePerMillion: 3000 },
              { kind: "volume", threshold: 30000000, ratePerMillion: 6000 },
            ],
          };
        if (r.roleKey === "team_leader")
          return {
            ...r,
            tiers: [
              { kind: "percent", threshold: 50, ratePerMillion: 2500 },
              { kind: "percent", threshold: 100, ratePerMillion: 3000 },
            ],
          };
        return r;
      }),
    })
  ).body;
  const pa = saved.roles.find((r) => r.roleKey === "property_advisor");
  assert.equal(pa.monthlyTarget, 5000000);
  assert.equal(pa.quarterlyTarget, 15000000);
  assert.equal(pa.version, 1);
  assert.deepEqual(pa.tiers, [
    { kind: "volume", threshold: 15000000, ratePerMillion: 3000 },
    { kind: "volume", threshold: 30000000, ratePerMillion: 6000 },
  ]);
  const tl = saved.roles.find((r) => r.roleKey === "team_leader");
  assert.deepEqual(tl.tiers, [
    { kind: "percent", threshold: 50, ratePerMillion: 2500 },
    { kind: "percent", threshold: 100, ratePerMillion: 3000 },
  ]);

  // Stale version on a second save is rejected.
  await h.post(
    "brokerage/commission-scheme",
    {
      requestId: randomUUID(),
      roles: saved.roles.map((r) =>
        r.roleKey === "property_advisor"
          ? { ...r, version: 0, monthlyTarget: 1 }
          : r,
      ),
    },
    409,
  );

  // Office companies don't use this scheme at all.
  h.state.principal = { ...owner, company: { type: "real_estate_office" } };
  await h.get("brokerage/commission-scheme", 403);
});

test("only manager ranks absorb lower ranks, each at or above their own rank is rejected", async () => {
  h.state.principal = owner;
  const current = (await h.get("brokerage/commission-scheme")).body.roles;
  // property_advisor has no one below it.
  await h.post(
    "brokerage/commission-scheme",
    {
      requestId: randomUUID(),
      roles: current.map((r) =>
        r.roleKey === "property_advisor"
          ? {
              ...r,
              absorptionRates: [{ roleKey: "senior", ratePerMillion: 1 }],
            }
          : r,
      ),
    },
    400,
  );
  // A rank cannot absorb itself or a higher rank.
  await h.post(
    "brokerage/commission-scheme",
    {
      requestId: randomUUID(),
      roles: current.map((r) =>
        r.roleKey === "team_leader"
          ? {
              ...r,
              absorptionRates: [{ roleKey: "team_leader", ratePerMillion: 1 }],
            }
          : r,
      ),
    },
    400,
  );
  await h.post(
    "brokerage/commission-scheme",
    {
      requestId: randomUUID(),
      roles: current.map((r) =>
        r.roleKey === "sales_director"
          ? {
              ...r,
              absorptionRates: [
                { roleKey: "head_of_sales", ratePerMillion: 1 },
              ],
            }
          : r,
      ),
    },
    400,
  );
  // No duplicates.
  await h.post(
    "brokerage/commission-scheme",
    {
      requestId: randomUUID(),
      roles: current.map((r) =>
        r.roleKey === "team_leader"
          ? {
              ...r,
              absorptionRates: [
                { roleKey: "property_advisor", ratePerMillion: 3000 },
                { roleKey: "property_advisor", ratePerMillion: 4000 },
              ],
            }
          : r,
      ),
    },
    409,
  );
  // A valid absorption table for sales_director saves and round-trips.
  const saved = (
    await h.post("brokerage/commission-scheme", {
      requestId: randomUUID(),
      roles: current.map((r) =>
        r.roleKey === "sales_director"
          ? {
              ...r,
              absorptionRates: [
                { roleKey: "property_advisor", ratePerMillion: 2000 },
                { roleKey: "property_consultant", ratePerMillion: 3000 },
                { roleKey: "senior", ratePerMillion: 5000 },
                { roleKey: "expert", ratePerMillion: 7000 },
                { roleKey: "team_leader", ratePerMillion: 4000 },
                { roleKey: "sales_manager", ratePerMillion: 3000 },
              ],
            }
          : r,
      ),
    })
  ).body.roles;
  const director = saved.find((r) => r.roleKey === "sales_director");
  assert.deepEqual(director.absorptionRates, [
    { roleKey: "property_advisor", ratePerMillion: 2000 },
    { roleKey: "property_consultant", ratePerMillion: 3000 },
    { roleKey: "senior", ratePerMillion: 5000 },
    { roleKey: "expert", ratePerMillion: 7000 },
    { roleKey: "team_leader", ratePerMillion: 4000 },
    { roleKey: "sales_manager", ratePerMillion: 3000 },
  ]);
  assert.deepEqual(
    saved.find((r) => r.roleKey === "property_advisor").absorptionRates,
    [],
  );
});
