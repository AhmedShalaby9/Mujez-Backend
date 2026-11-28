import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";

let h, owner, agent, lead, mine, theirs, extra;
const projects = {};
let seq = 0;
const req = (data, version) => ({
  requestId: randomUUID(),
  data,
  ...(version === undefined ? {} : { version }),
});
async function employee(name, role = "agent") {
  const i = (
    await h.post("team/invite", { name, email: name + "@proj.test", role })
  ).body;
  await h.post(
    "team/activate",
    { token: i.token, password: "office-fixture-password" },
    200,
  );
  const account = (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [i.accountId],
    )
  ).rows[0];
  return new SessionService(h.database, {
    consume: async () => true,
  }).employeeProfile(account);
}
const clientData = (projectIds, more = {}) => ({
  name: "Client " + ++seq,
  phone: "+1202556" + String(seq).padStart(4, "0"),
  needs: {
    purpose: "rent",
    rentBudgetMinor: "1000000",
    ...(projectIds ? { projectIds } : {}),
  },
  ...more,
});
const addClient = async (projectIds, status = 201, more = {}) =>
  (await h.post("office/clients", req(clientData(projectIds, more)), status))
    .body;
const propertyData = (cityId) => ({
  title: "Unit " + ++seq,
  ownerName: "Property Owner",
  ownerPhones: ["+201000000100"],
  cityId,
  areaName: "Area",
  address: "Street " + seq,
  type: "apartment",
  purpose: "rent",
  furnishing: "furnished",
  area: 100,
  rentMinor: "1000000",
});
const ids = async (path) =>
  (await h.get(path)).body.items.map((x) => x.id).sort();
const grant = async (user, cityIds) => {
  const previous = h.state.principal;
  h.state.principal = owner;
  const current = (await h.get(`office/agents/${user.id}/permissions`)).body;
  await h.post(
    `office/agents/${user.id}/permissions`,
    req(
      { allCities: cityIds === null, cityIds: cityIds ?? [] },
      current.version,
    ),
  );
  h.state.principal = previous;
};

before(async () => {
  h = await tenantHarness();
  owner = h.principals[0];
  owner.permissions.push("team.read", "team.manage", "units.read");
  await h.db.query(
    "UPDATE platform.companies SET company_type='real_estate_office' WHERE id=$1",
    [owner.companyId],
  );
  owner.company = { type: "real_estate_office" };
  for (const name of ["North", "South", "East"])
    projects[name] = (
      await h.post("office/cities", req({ nameEn: name, nameAr: name + " ar" }))
    ).body.id;
  agent = await employee("agent");
  // Before any limit: one client per project and one without a project.
  h.state.principal = agent;
  mine = (await addClient([projects.North])).id;
  theirs = (await addClient([projects.South])).id;
  extra = (await addClient(null)).id;
});
after(async () => h?.close());
afterEach(() => {
  h.state.principal = owner;
});

test("without a limit nothing changes", async () => {
  h.state.principal = agent;
  assert.deepEqual(await ids("office/clients"), [mine, theirs, extra].sort());
  const options = (await h.get("office/options")).body;
  assert.equal(options.restrictedProjects, false);
  assert.equal(options.cities.length, 3);
});

test("a limited salesperson sees only their projects' clients", async () => {
  await grant(agent, [projects.North]);
  h.state.principal = agent;
  // The client with no project yet stays with its salesperson.
  assert.deepEqual(await ids("office/clients"), [mine, extra].sort());
  await h.get("office/clients/" + theirs, 404);
  const found = (await h.get("search?q=Client")).body.items.map((x) => x.id);
  assert.equal(found.includes(theirs), false);
  assert.equal(found.includes(mine), true);
  const options = (await h.get("office/options")).body;
  assert.equal(options.restrictedProjects, true);
  assert.deepEqual(
    options.cities.map((c) => c.id),
    [projects.North],
  );
  h.state.principal = owner;
  assert.equal((await ids("office/clients")).length, 3);
});

test("new clients and units are limited to allowed projects", async () => {
  await grant(agent, [projects.North]);
  h.state.principal = agent;
  await addClient([projects.South], 403);
  await addClient([projects.North, projects.South], 403);
  await addClient([], 400);
  // One allowed project is applied for apps that do not send any.
  const auto = await addClient(null);
  assert.deepEqual(
    (await h.get("office/clients/" + auto.id)).body.needs.projectIds,
    [projects.North],
  );
  await h.post("office/properties", req(propertyData(projects.South)), 403);
  await h.post("office/properties", req(propertyData(projects.North)));

  await grant(agent, [projects.North, projects.East]);
  h.state.principal = agent;
  await addClient(null, 400);
  await addClient([projects.East]);
});

test("editing keeps projects the salesperson cannot see", async () => {
  await grant(agent, null);
  h.state.principal = agent;
  const shared = (await addClient([projects.North, projects.South])).id;
  await grant(agent, [projects.North]);
  h.state.principal = agent;
  const row = (await h.get("office/clients/" + shared)).body;
  const update = (projectIds, version, status = 201) =>
    h.post(
      "office/clients/" + shared,
      req(
        clientData(projectIds, { name: row.name, phone: row.phone }),
        version,
      ),
      status,
    );
  await update([], row.version, 400);
  await update([projects.North], row.version);
  h.state.principal = owner;
  const saved = (await h.get("office/clients/" + shared)).body;
  assert.deepEqual(
    saved.needs.projectIds.sort(),
    [projects.North, projects.South].sort(),
  );
  // An app that sends no projects leaves them as they were.
  h.state.principal = agent;
  await update(null, saved.version);
  h.state.principal = owner;
  assert.equal(
    (await h.get("office/clients/" + shared)).body.needs.projectIds.length,
    2,
  );
});

test("management cannot hand a client to a salesperson without its project", async () => {
  await grant(agent, [projects.North]);
  await addClient([projects.South], 400, { ownerId: agent.id });
  await addClient([projects.North], 201, { ownerId: agent.id });
});

test("tasks and team lead views follow the same limit", async () => {
  lead = await employee("lead", "team_lead");
  await grant(agent, [projects.North]);
  h.state.principal = owner;
  await h.post("team/groups", {
    name: "Projects team",
    leadUserId: lead.id,
    memberUserIds: [lead.id, agent.id],
  });
  await grant(lead, [projects.North]);
  h.state.principal = {
    ...lead,
    role: "team_lead",
    roles: ["team_lead"],
    permissions: [...new Set([...lead.permissions, "team.self.read"])],
  };
  const seen = await ids("office/my-team/clients");
  assert.equal(seen.includes(mine), true);
  assert.equal(seen.includes(theirs), false);
  h.state.principal = agent;
  const choices = (await h.get("tasks/lead-options?limit=100")).body.items.map(
    (x) => x.id,
  );
  assert.equal(choices.includes(theirs), false);
  assert.equal(choices.includes(mine), true);
});
