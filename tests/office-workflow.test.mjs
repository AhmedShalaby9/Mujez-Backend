import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { SessionService } from "../dist/common/auth/session.service.js";
import { runOfficeSweep } from "../dist/modules/office/office-sweep.js";
let h, owner, other, a, b, tl, team;
let seq = 0;
const req = (data, version) => ({
  requestId: randomUUID(),
  data,
  ...(version === undefined ? {} : { version }),
});
async function employee(name, role = "agent") {
  const i = (
    await h.post("team/invite", { name, email: name + "@example.test", role })
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
const property = (more = {}) => ({
  title: "Apartment " + ++seq,
  ownerName: "Property Owner",
  ownerPhones: ["+201000000100"],
  city: "Cairo",
  areaName: "Maadi",
  address: "Street " + seq,
  type: "apartment",
  purpose: "both",
  furnishing: "furnished",
  bedrooms: 2,
  bathrooms: 2,
  area: 120,
  saleMinor: "100000000",
  rentMinor: "1000000",
  ...more,
});
async function createClient(more = {}) {
  const r = await h.post(
    "office/clients",
    req({
      name: "Client " + ++seq,
      phone: "+1202555" + String(seq).padStart(4, "0"),
      source: "inbound_call",
      needs: {
        purpose: "rent",
        areas: ["Maadi"],
        rentBudgetMinor: "1000000",
        type: "apartment",
        furnishing: "furnished",
        minBedrooms: 2,
      },
      ...more,
    }),
  );
  return (await h.get("office/clients/" + r.body.id)).body;
}
async function createProperty(more = {}) {
  const r = await h.post("office/properties", req(property(more)));
  return (await h.get("office/properties/" + r.body.id)).body;
}
async function book(p, c, purpose = "rent") {
  return (
    await h.post(
      "office/bookings",
      req({
        propertyId: p.id,
        propertyVersion: p.version,
        clientId: c.id,
        purpose,
      }),
    )
  ).body;
}
const dates = async () =>
  (
    await h.db.query(
      "SELECT ((now() AT TIME ZONE 'Africa/Cairo')::date-40)::text start,((now() AT TIME ZONE 'Africa/Cairo')::date+5)::text finish,((now() AT TIME ZONE 'Africa/Cairo')::date+40)::text later,(now() AT TIME ZONE 'Africa/Cairo')::date::text today",
    )
  ).rows[0];
before(async () => {
  h = await tenantHarness();
  [owner, other] = h.principals;
  await h.db.query(
    "UPDATE platform.companies SET company_type='real_estate_office',finance_enabled=false,ai_enabled=false WHERE id=$1",
    [owner.companyId],
  );
  await h.db.query(
    "INSERT INTO tenant.office_cities(company_id,name_en,name_ar) VALUES($1,'Cairo','القاهرة')",
    [owner.companyId],
  );
  owner.permissions.push("team.read", "team.manage");
  a = await employee("OfficeAlice");
  b = await employee("OfficeBob");
  tl = await employee("OfficeLead", "team_lead");
  team = (
    await h.post("team/groups", {
      name: "Office Team",
      leadUserId: tl.id,
      memberUserIds: [a.id],
    })
  ).body;
  h.state.principal = a;
});
after(() => h?.close());
afterEach(() => {
  h.state.principal = a;
  h.state.failAudit = false;
});
test("sales create visible properties immediately, see all owner details but cannot edit a colleague property or read their clients", async () => {
  const p = await createProperty(),
    c = await createClient();
  h.state.principal = b;
  assert.equal(
    (await h.get("office/properties/" + p.id)).body.data.ownerName,
    "Property Owner",
  );
  await h.get("office/clients/" + c.id, 404);
  assert.equal(
    (await h.get("office/clients?q=" + encodeURIComponent(c.phone))).body.total,
    0,
  );
  await h.post("office/properties/" + p.id, req(property(), p.version), 403);
  h.state.principal = owner;
  await h.get("office/clients/" + c.id);
  h.state.principal = tl;
  await h.get("office/clients/" + c.id);
  h.state.principal = other;
  await h.get("office/options", 403);
});
test("company isolation, actual team membership, saved views and all client/property filters are enforced on the server", async () => {
  const p = await createProperty({
      title: "Filter property",
      rentMinor: "999999",
      floor: 3,
      finish: "ready",
      verifiedOn: "2026-01-01",
    }),
    c = await createClient({ name: "Filter Client" });
  assert(
    (
      await h.get(
        "office/properties?q=Filter&purpose=rent&minPrice=999999&maxPrice=999999&minBedrooms=2&minBathrooms=2&minArea=100&maxArea=130&minFloor=3&maxFloor=3&city=Cairo&areaName=Maadi&finish=ready",
      )
    ).body.items.some((x) => x.id === p.id),
  );
  assert.equal(
    (await h.get("office/properties?q=Filter&maxPrice=999998&purpose=rent"))
      .body.total,
    0,
  );
  assert(
    (
      await h.get(
        "office/clients?q=Filter&purpose=rent&areaName=Maadi&callbacks=no_contact",
      )
    ).body.items.some((x) => x.id === c.id),
  );
  await h.get("office/clients?ownerId=" + b.id);
  await h.get("office/clients?companyId=" + other.companyId, 400);
  await h.get("office/properties?minPrice=100&maxPrice=1", 400);
  const f = await h.post(
    "office/filters",
    req({
      view: "clients",
      name: "My rent clients",
      filters: { purpose: "rent" },
    }),
  );
  assert(f.body.id);
  h.state.principal = b;
  assert.equal(
    (await h.get("office/filters?view=clients")).body.items.length,
    0,
  );
  h.state.principal = owner;
  await h.post("team/groups/" + team.id, {
    version: team.version,
    name: "Office Team",
    leadUserId: tl.id,
    memberUserIds: [],
  });
  h.state.principal = tl;
  await h.get("office/clients/" + c.id, 404);
});
test("booking is open-ended, private, exclusive and idempotent; only own client can be booked and own deal closed", async () => {
  const p = await createProperty(),
    c = await createClient();
  const input = req({
    propertyId: p.id,
    clientId: c.id,
    propertyVersion: p.version,
    purpose: "rent",
  });
  const d = (await h.post("office/bookings", input)).body;
  assert.deepEqual((await h.post("office/bookings", input)).body, d);
  assert.equal(
    (await h.get("office/properties/" + p.id)).body.status,
    "booked",
  );
  h.state.principal = b;
  const own = await createClient();
  const shared = (await h.get("office/properties/" + p.id)).body;
  assert.equal(shared.booking.salesperson, a.name);
  assert(!JSON.stringify(shared).includes(c.name));
  assert.equal(shared.booking.id, undefined);
  assert.equal(
    (await h.get("office/deals")).body.items.some((x) => x.id === d.id),
    false,
  );
  await h.post(
    "office/deals/" + d.id,
    req({ action: "cancel", reason: "Client cancelled" }, d.version),
    404,
  );
  await h.post(
    "office/bookings",
    req({
      propertyId: p.id,
      propertyVersion: 1,
      clientId: own.id,
      purpose: "rent",
    }),
    409,
  );
  h.state.principal = a;
  const dt = await dates();
  await h.post(
    "office/deals/" + d.id,
    req(
      {
        action: "close",
        priceMinor: "1000000",
        leaseStart: dt.start,
        leaseEnd: dt.finish,
      },
      d.version,
    ),
  );
  assert.equal(
    (await h.get("office/properties/" + p.id)).body.status,
    "rented",
  );
  await h.post(
    "office/deals/" + d.id,
    req(
      {
        action: "close",
        priceMinor: "1000000",
        leaseStart: dt.start,
        leaseEnd: dt.finish,
      },
      d.version,
    ),
    409,
  );
});
test("cancellation releases stock and sale close creates no finance/commission records; failed audits roll back all workflow writes", async () => {
  let p = await createProperty(),
    c = await createClient(),
    d = await book(p, c, "sale");
  await h.post(
    "office/deals/" + d.id,
    req({ action: "cancel", reason: "Changed requirements" }, d.version),
  );
  p = (await h.get("office/properties/" + p.id)).body;
  assert.equal(p.status, "available");
  d = await book(p, c, "sale");
  h.state.failAudit = true;
  await h.post(
    "office/deals/" + d.id,
    req({ action: "close", priceMinor: "100000000" }, 0),
    500,
  );
  h.state.failAudit = false;
  assert.equal(
    (await h.get("office/properties/" + p.id)).body.status,
    "booked",
  );
  await h.post(
    "office/deals/" + d.id,
    req({ action: "close", priceMinor: "100000000" }, 0),
  );
  assert.equal((await h.get("office/properties/" + p.id)).body.status, "sold");
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int n FROM tenant.fin_deals WHERE company_id=$1",
        [owner.companyId],
      )
    ).rows[0].n,
    0,
  );
});
test("recommendations use only office stock, saved requirements and monthly rent; the 10% cap is exact and unknown/incompatible prices are excluded", async () => {
  const c = await createClient();
  const exact = await createProperty({ rentMinor: "1100000" }),
    over = await createProperty({ rentMinor: "1100001" }),
    wrong = await createProperty({
      rentMinor: "1000000",
      furnishing: "unfurnished",
    });
  const r = (
    await h.get("office/clients/" + c.id + "/recommendations?purpose=rent")
  ).body;
  assert(
    r.items.some(
      (x) =>
        x.property.id === exact.id &&
        x.aboveBudgetMinor === "100000" &&
        x.aboveBudgetPercent === 10,
    ),
  );
  assert(!r.items.some((x) => [over.id, wrong.id].includes(x.property.id)));
  h.state.principal = b;
  await h.get("office/clients/" + c.id + "/recommendations?purpose=rent", 404);
});
test("duplicate warnings, client notes/viewings, validation and immutable activity ownership work without modifying shared catalog", async () => {
  const p = await createProperty(),
    c = await createClient();
  await h.post("office/properties", req({ ...p.data, title: p.title }), 409);
  await h.post(
    "office/clients/" + c.id + "/activities",
    req(
      {
        kind: "call",
        notes: "Incoming requirement",
        followUpAt: "2028-01-01T12:00",
      },
      c.version,
    ),
  );
  let detail = (await h.get("office/clients/" + c.id)).body;
  assert(detail.lastContactAt);
  assert.equal(detail.activities.length, 1);
  await h.post(
    "office/clients/" + c.id + "/activities",
    req(
      {
        kind: "viewing",
        notes: "View requested",
        propertyId: p.id,
        scheduledAt: "2028-01-02T10:00",
      },
      detail.version,
    ),
  );
  detail = (await h.get("office/clients/" + c.id)).body;
  assert.equal(detail.activities.length, 2);
  await h.post(
    "office/clients/" + c.id + "/activities",
    req(
      { kind: "call", notes: "Bad clock", followUpAt: "2028-01-01T99:99" },
      detail.version,
    ),
    400,
  );
});
test("15-day notifications reach all current sales and managers once, renewals reschedule and expiration releases stock with Finance disabled", async () => {
  const p = await createProperty(),
    c = await createClient(),
    d = await book(p, c);
  const dt = await dates();
  await h.post(
    "office/deals/" + d.id,
    req(
      {
        action: "close",
        priceMinor: "1000000",
        leaseStart: dt.start,
        leaseEnd: dt.finish,
      },
      d.version,
    ),
  );
  await runOfficeSweep(h.database);
  let count = (
    await h.db.query(
      "SELECT count(*)::int n FROM tenant.office_lease_notifications WHERE company_id=$1 AND deal_id=$2 AND kind='expiring'",
      [owner.companyId, d.id],
    )
  ).rows[0].n;
  assert.equal(count, 1);
  const notes = (
    await h.db.query(
      "SELECT user_id,title FROM tenant.notifications WHERE company_id=$1 AND kind='office.lease.expiring' AND route LIKE $2",
      [owner.companyId, "%" + p.id],
    )
  ).rows;
  for (const id of [owner.id, a.id, b.id, tl.id])
    assert(notes.some((x) => x.user_id === id));
  const before = notes.length;
  await runOfficeSweep(h.database);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int n FROM tenant.notifications WHERE company_id=$1 AND kind='office.lease.expiring' AND route LIKE $2",
        [owner.companyId, "%" + p.id],
      )
    ).rows[0].n,
    before,
  );
  await h.post(
    "office/deals/" + d.id,
    req({ action: "renew", leaseEnd: dt.later }, 1),
  );
  await runOfficeSweep(h.database);
  await h.db.query(
    "UPDATE tenant.office_deals SET lease_end=$3::date WHERE company_id=$1 AND id=$2",
    [owner.companyId, d.id, dt.today],
  );
  const result = await runOfficeSweep(h.database);
  assert(result.released >= 1);
  assert.equal(
    (await h.get("office/properties/" + p.id)).body.status,
    "available",
  );
  const n = (
    await h.db.query(
      "SELECT count(*)::int n FROM tenant.office_lease_notifications WHERE company_id=$1 AND deal_id=$2 AND kind='available'",
      [owner.companyId, d.id],
    )
  ).rows[0].n;
  assert.equal(n, 1);
  await runOfficeSweep(h.database);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int n FROM tenant.office_lease_notifications WHERE company_id=$1 AND deal_id=$2 AND kind='available'",
        [owner.companyId, d.id],
      )
    ).rows[0].n,
    1,
  );
});
test("uploaded photos are company-visible; contracts are client-private, signature validated and actor-idempotent", async () => {
  const client = await createClient();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=",
    "base64",
  );
  const upload = async (kind, file, extra = {}, status = 201) =>
    h
      .api()
      .post("/api/v1/office/media")
      .set("Origin", h.origin)
      .set("Cookie", "__Host-mujez_session=" + "a".repeat(64))
      .field("requestId", extra.requestId ?? randomUUID())
      .field("kind", kind)
      .field("clientId", extra.clientId ?? client.id)
      .attach("file", file, {
        filename: kind === "photo" ? "photo.png" : "contract.pdf",
      })
      .expect(status);
  const requestId = randomUUID();
  const photo = (await upload("photo", png, { requestId })).body;
  assert.deepEqual((await upload("photo", png, { requestId })).body, photo);
  const contract = (
    await upload("contract", Buffer.from("%PDF-1.7\nfixture PDF"), {
      clientId: client.id,
    })
  ).body;
  h.state.principal = b;
  await h.get("office/media/" + photo.id);
  await h.get("office/media/" + contract.id, 404);
  await upload("photo", Buffer.from('<svg onload="alert(1)"></svg>'), {}, 400);
  h.state.principal = other;
  await h.get("office/media/" + photo.id, 403);
});
test("office global search returns company stock but never another sales client, and failing sweeps are isolated and retry without partial notices", async () => {
  const c = await createClient({ name: "Search private client" }),
    p = await createProperty({ title: "Search office stock" });
  h.state.principal = b;
  const result = (await h.get("search?q=Search")).body.items;
  assert(
    result.some((x) => x.id === p.id && x.route.includes("/office/properties")),
  );
  assert(!result.some((x) => x.id === c.id));
  h.state.principal = a;
  const d = await book(p, c),
    dt = await dates();
  await h.post(
    "office/deals/" + d.id,
    req(
      {
        action: "close",
        priceMinor: "1000000",
        leaseStart: dt.start,
        leaseEnd: dt.finish,
      },
      d.version,
    ),
  );
  const before = (
    await h.db.query(
      "SELECT count(*)::int n FROM tenant.office_lease_notifications WHERE company_id=$1 AND deal_id=$2",
      [owner.companyId, d.id],
    )
  ).rows[0].n;
  h.state.failAudit = true;
  const fail = await runOfficeSweep(h.database);
  assert(fail.failed > 0);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int n FROM tenant.office_lease_notifications WHERE company_id=$1 AND deal_id=$2",
        [owner.companyId, d.id],
      )
    ).rows[0].n,
    before,
  );
  h.state.failAudit = false;
  await runOfficeSweep(h.database);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int n FROM tenant.office_lease_notifications WHERE company_id=$1 AND deal_id=$2",
        [owner.companyId, d.id],
      )
    ).rows[0].n,
    before + 1,
  );
});
test("lease batches advance past already-notified rentals without starving remaining office properties", async () => {
  const client = await createClient();
  const dt = await dates();
  await h.db.query(
    "INSERT INTO tenant.office_properties(company_id,code,title,responsible_id,created_by,status,data) SELECT $1,'BATCH-'||n,'Batch property '||n,$2,$2,'rented',$3::jsonb FROM generate_series(1,501) n",
    [owner.companyId, a.id, property()],
  );
  await h.db.query(
    "INSERT INTO tenant.office_deals(company_id,code,property_id,client_id,owner_id,purpose,status,price_minor,lease_start,lease_end) SELECT $1,'BATCH-DEAL-'||p.code,p.id,$2,$3,'rent','rented',1000000,$4::date,$5::date FROM tenant.office_properties p WHERE p.company_id=$1 AND p.code LIKE 'BATCH-%'",
    [owner.companyId, client.id, a.id, dt.start, dt.finish],
  );
  const delivered = async () =>
    (
      await h.db.query(
        "SELECT count(*)::int n FROM tenant.office_lease_notifications n JOIN tenant.office_deals d ON d.company_id=n.company_id AND d.id=n.deal_id WHERE n.company_id=$1 AND d.code LIKE 'BATCH-DEAL-%'",
        [owner.companyId],
      )
    ).rows[0].n;
  await runOfficeSweep(h.database);
  assert.equal(await delivered(), 500);
  await runOfficeSweep(h.database);
  assert.equal(await delivered(), 501);
  await runOfficeSweep(h.database);
  assert.equal(await delivered(), 501);
});

test("cities are selected from the managed directory, deleted cities cannot be newly chosen, and only one Egyptian owner phone is accepted", async () => {
  h.state.principal = owner;
  const options = (await h.get("office/options")).body;
  const cairo = options.cities.find((c) => c.nameEn === "Cairo");
  assert.ok(cairo);
  await h.post(
    "office/properties",
    req(property({ ownerPhones: ["+12025550100"] })),
    400,
  );
  await h.post(
    "office/properties",
    req(property({ ownerPhones: ["+201000000100", "+201000000101"] })),
    400,
  );
  await h.post(
    "office/properties",
    req(property({ city: "Invented city" })),
    400,
  );
  const saved = await createProperty({ cityId: cairo.id, city: undefined });
  assert.equal(saved.data.cityId, cairo.id);
  assert.equal(saved.data.city, "Cairo");
  const filter = (await h.get("office/properties?city=" + cairo.id)).body;
  assert.ok(filter.items.some((x) => x.id === saved.id));
  const deleted = (
    await h.db.query(
      "INSERT INTO tenant.office_cities(company_id,name_en,name_ar,archived) VALUES($1,'Deleted town','مدينة محذوفة',true) RETURNING id",
      [owner.companyId],
    )
  ).rows[0];
  await h.post("office/properties", req(property({ cityId: deleted.id })), 400);
  await h.post(
    "office/properties/" + saved.id,
    req({ ...saved.data, title: saved.title, cityId: cairo.id }, saved.version),
  );
});
test("office invitations and role edits accept only sales and team leads without changing brokerage roles", async () => {
  h.state.principal = owner;
  for (const role of [
    "hr_manager",
    "employee",
    "accountant",
    "finance_manager",
  ])
    await h.post(
      "team/invite",
      {
        name: "Office blocked role",
        email: randomUUID() + "@example.test",
        role,
      },
      400,
    );
  const account = (
    await h.db.query(
      "SELECT id FROM platform.company_employee_accounts WHERE company_id=$1 AND user_id=$2",
      [owner.companyId, a.id],
    )
  ).rows[0];
  await h.post(
    "team/" + account.id + "/roles",
    { roles: ["agent", "hr_manager"], version: 0 },
    400,
  );
});

test("office tasks and calendar link real office clients, preserve personal and current-team access, and keep contacts private", async () => {
  h.state.principal = owner;
  const currentTeam = (
    await h.db.query(
      "SELECT version FROM tenant.teams WHERE company_id=$1 AND id=$2",
      [owner.companyId, team.id],
    )
  ).rows[0];
  team = (
    await h.post("team/groups/" + team.id, {
      name: "Office Team",
      leadUserId: tl.id,
      memberUserIds: [a.id],
      version: currentTeam.version,
    })
  ).body;
  h.state.principal = a;
  const client = await createClient({
    name: "Private Office Client For Tools",
  });
  const contact = (
    await h.post("contacts", {
      requestId: randomUUID(),
      name: "Office Contact A",
      type: "buyer",
      phones: ["+201000000111"],
    })
  ).body;
  const options = (await h.get("tasks/lead-options")).body;
  assert.ok(options.items.some((x) => x.id === client.id));
  const task = (
    await h.post("tasks", {
      requestId: randomUUID(),
      title: "Office follow-up",
      priority: "high",
      leadId: client.id,
      dueDate: "2027-01-05",
    })
  ).body;
  assert.equal(task.lead.id, client.id);
  assert.equal(task.lead.kind, "office_client");
  const data = {
    requestId: randomUUID(),
    title: "Office viewing",
    type: "viewing",
    startsAt: "2027-01-05T10:00:00Z",
    endsAt: "2027-01-05T11:00:00Z",
    leadId: client.id,
    contactId: contact.id,
  };
  const event = (await h.post("events", data)).body;
  assert.equal(event.lead.id, client.id);
  assert.equal(event.contact.id, contact.id);
  assert.equal((await h.post("events", data)).body.id, event.id);
  h.state.principal = b;
  await h.get("tasks/" + task.id, 404);
  await h.get("events/" + event.id, 404);
  assert.ok(
    !(await h.get("events/options")).body.contacts.some(
      (x) => x.id === contact.id,
    ),
  );
  assert.ok(
    !(await h.get("events/options")).body.leads.some((x) => x.id === client.id),
  );
  await h.post(
    "tasks",
    {
      requestId: randomUUID(),
      title: "Cannot link",
      priority: "med",
      leadId: client.id,
    },
    400,
  );
  await h.post("events", { ...data, requestId: randomUUID() }, 400);
  await h.post(
    "events",
    { ...data, requestId: randomUUID(), leadId: null },
    400,
  );
  h.state.principal = tl;
  assert.ok((await h.get("tasks")).body.items.some((x) => x.id === task.id));
  assert.ok(
    (
      await h.get("events?from=2027-01-04T00:00:00Z&to=2027-01-10T00:00:00Z")
    ).body.items.some((x) => x.id === event.id),
  );
  const delegated = (
    await h.post("tasks", {
      requestId: randomUUID(),
      title: "Team office task",
      priority: "med",
      leadId: client.id,
      assigneeId: a.id,
    })
  ).body;
  assert.equal(delegated.assignee.id, a.id);
  await h.post("tasks/" + delegated.id + "/status", {
    requestId: randomUUID(),
    version: delegated.version,
    action: "complete",
  });
  await h.post(
    "tasks",
    {
      requestId: randomUUID(),
      title: "Outside team",
      priority: "med",
      assigneeId: b.id,
    },
    403,
  );
  const teamEvent = (
    await h.post("events", {
      ...data,
      requestId: randomUUID(),
      ownerId: a.id,
      contactId: null,
    })
  ).body;
  assert.equal(teamEvent.owner.id, a.id);
  await h.post(
    "events",
    { ...data, requestId: randomUUID(), ownerId: b.id, contactId: null },
    403,
  );
  h.state.principal = owner;
  await h.post(
    "office/clients/" + client.id,
    req(
      {
        name: client.name,
        phone: client.phone,
        email: client.email ?? "",
        source: client.source,
        status: client.status,
        needs: client.needs,
        followUpAt: null,
        ownerId: b.id,
      },
      client.version,
    ),
  );
  h.state.principal = a;
  assert.equal((await h.get("tasks/" + task.id)).body.lead, null);
  assert.equal((await h.get("events/" + event.id)).body.lead, null);
  assert.equal(
    (await h.get("tasks?q=Private%20Office%20Client%20For%20Tools")).body.total,
    0,
  );
  assert.ok(
    !(await h.get("tasks/lead-options")).body.items.some(
      (x) => x.id === client.id,
    ),
  );
});

test("office pipeline stages are scoped, versioned and audited while closure follows deals and brokerage is isolated", async () => {
  const c = await createClient({ name: "Pipeline scoped client" });
  const before = (await h.get("office/clients?q=Pipeline%20scoped%20client"))
    .body;
  assert.equal(before.total, 1);
  assert.equal(before.stats.find((s) => s.status === "new").count, 1);
  const payload = req({ status: "contacted" }, c.version);
  const moved = (await h.post("office/clients/" + c.id + "/stage", payload))
    .body;
  assert.equal(moved.status, "contacted");
  assert.deepEqual(
    (await h.post("office/clients/" + c.id + "/stage", payload)).body,
    moved,
  );
  await h.post(
    "office/clients/" + c.id + "/stage",
    req({ status: "viewing" }, c.version),
    409,
  );
  await h.post(
    "office/clients/" + c.id + "/stage",
    req({ status: "closed" }, moved.version),
    400,
  );
  h.state.principal = b;
  assert.equal(
    (await h.get("office/clients?q=Pipeline%20scoped%20client")).body.total,
    0,
  );
  await h.post(
    "office/clients/" + c.id + "/stage",
    req({ status: "lost" }, moved.version),
    404,
  );
  h.state.principal = a;
  h.state.failAudit = true;
  await h.post(
    "office/clients/" + c.id + "/stage",
    req({ status: "viewing" }, moved.version),
    500,
  );
  h.state.failAudit = false;
  assert.equal(
    (await h.get("office/clients/" + c.id)).body.status,
    "contacted",
  );
  const p = await createProperty();
  const booking = await book(p, c, "sale");
  await h.post(
    "office/deals/" + booking.id,
    req({ action: "close", priceMinor: "100000000" }, booking.version),
  );
  const closed = (await h.get("office/clients/" + c.id)).body;
  assert.equal(closed.status, "closed");
  await h.post(
    "office/clients/" + c.id + "/stage",
    req({ status: "new" }, closed.version),
    409,
  );
  h.state.principal = other;
  await h.get("office/clients", 403);
  await h.post(
    "office/clients/" + c.id + "/stage",
    req({ status: "new" }, closed.version),
    403,
  );
});

test("all other company types retain their original CRM pipeline and cannot use office stage writes", async () => {
  h.state.principal = owner;
  owner.permissions.push("tasks.read", "calendar.read", "contacts.read");
  try {
    for (const type of ["brokerage", "developer", "property_mgmt", "hybrid"]) {
      await h.db.query(
        "UPDATE platform.companies SET company_type=$2 WHERE id=$1",
        [owner.companyId, type],
      );
      const pipeline = (await h.get("pipeline")).body;
      assert.ok(Array.isArray(pipeline.items));
      assert.ok(Array.isArray(pipeline.stats));
      for (const path of [
        "tasks",
        "events?from=2027-01-04T00:00:00Z&to=2027-01-10T00:00:00Z",
        "contacts",
      ]) {
        const result = (await h.get(path)).body;
        assert.ok(Array.isArray(result.items));
      }
      await h.get("office/clients", 403);
      await h.post(
        "office/clients/" + randomUUID() + "/stage",
        req({ status: "new" }, 0),
        403,
      );
    }
  } finally {
    await h.db.query(
      "UPDATE platform.companies SET company_type='real_estate_office' WHERE id=$1",
      [owner.companyId],
    );
  }
});

test("office My team returns current scoped clients, tasks and exact office performance without brokerage records", async () => {
  h.state.principal = owner;
  const current = (await h.get("team/groups")).body.items.find(
    (t) => t.id === team.id,
  );
  team = (
    await h.post("team/groups/" + team.id, {
      name: current.name,
      leadUserId: tl.id,
      memberUserIds: [a.id],
      version: current.version,
    })
  ).body;
  h.state.principal = a;
  const client = await createClient({ name: "My team office client" });
  const task = (
    await h.post("tasks", {
      requestId: randomUUID(),
      title: "My team office task",
      priority: "high",
      leadId: client.id,
      dueDate: "2026-01-01",
    })
  ).body;
  await h.post(
    "office/clients/" + client.id + "/activities",
    req({ kind: "call", notes: "Recorded team call" }, client.version),
  );
  const property = await createProperty();
  const booking = await book(property, client, "sale");
  await h.post(
    "office/deals/" + booking.id,
    req({ action: "close", priceMinor: "123456789" }, booking.version),
  );
  h.state.principal = b;
  const hidden = await createClient({ name: "Outside team private client" });
  await h.post("tasks", {
    requestId: randomUUID(),
    title: "Outside team private task",
    priority: "low",
    leadId: hidden.id,
  });
  h.state.principal = tl;
  const result = (
    await h.get("office/my-team/clients?q=My%20team%20office&limit=1")
  ).body;
  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, client.id);
  assert.equal(result.team.id, team.id);
  assert.equal(
    (await h.get("office/my-team/clients?q=Outside%20team")).body.total,
    0,
  );
  await h.get("office/my-team/clients?memberId=" + b.id, 404);
  const tasks = (
    await h.get("office/my-team/tasks?q=My%20team%20office&memberId=" + a.id)
  ).body;
  assert.equal(tasks.total, 1);
  assert.equal(tasks.items[0].id, task.id);
  assert.equal(tasks.items[0].overdue, true);
  assert.equal(JSON.stringify(tasks).includes("Outside team"), false);
  const perf = (await h.get("office/my-team/performance?days=7")).body;
  assert.equal(perf.team.id, team.id);
  assert.equal(perf.timeZone, "Africa/Cairo");
  assert.deepEqual(perf.items.map((m) => m.id).sort(), [a.id, tl.id].sort());
  const member = perf.items.find((m) => m.id === a.id);
  assert.ok(member.clients >= 1);
  assert.ok(member.calls >= 1);
  assert.ok(member.overdueTasks >= 1);
  assert.ok(BigInt(member.saleMinor) >= 123456789n);
  assert.equal(
    perf.summary.saleMinor,
    perf.items.reduce((n, m) => n + BigInt(m.saleMinor), 0n).toString(),
  );
  await h.get("office/my-team/performance?days=8", 400);
  await h.get("office/my-team/tasks?status=not-real", 400);
  // Old brokerage rows must not enter office My team or its performance.
  await h.db.query(
    'INSERT INTO tenant.leads(company_id,public_id,name,phone,source,owner_user_id,segment,want) VALUES($1,\'L-MYTEAM-PRIVATE\',\'{"en":"Broker only record","ar":"Broker only record"}\',\'+12020009999\',\'manual\',$2,\'res\',\'{"en":"Apartment","ar":"Apartment"}\')',
    [owner.companyId, a.id],
  );
  assert.equal(
    (await h.get("office/my-team/clients?q=Broker%20only")).body.total,
    0,
  );
  const multiRole = {
    ...tl,
    role: "agent",
    roles: ["agent", "employee", "team_lead"],
  };
  h.state.principal = multiRole;
  assert.equal(
    (await h.get("office/my-team/performance")).body.team.id,
    team.id,
  );
  h.state.principal = {
    ...tl,
    permissions: tl.permissions.filter((x) => x !== "tasks.read"),
  };
  await h.get("office/my-team/performance", 403);
  await h.get("office/my-team/tasks", 403);
  h.state.principal = tl;
  try {
    for (const type of ["brokerage", "developer", "property_mgmt", "hybrid"]) {
      await h.db.query(
        "UPDATE platform.companies SET company_type=$2 WHERE id=$1",
        [owner.companyId, type],
      );
      await h.get("office/my-team/performance", 403);
      assert.ok(
        Array.isArray((await h.get("team/my-team/performance")).body.items),
      );
    }
  } finally {
    await h.db.query(
      "UPDATE platform.companies SET company_type='real_estate_office' WHERE id=$1",
      [owner.companyId],
    );
  }
  h.state.principal = a;
  await h.get("office/my-team/performance", 403);
  h.state.principal = owner;
  await h.get("office/my-team/clients", 403);
  h.state.principal = other;
  await h.get("office/my-team/tasks", 403);
  h.state.principal = owner;
  const latest = (await h.get("team/groups")).body.items.find(
    (t) => t.id === team.id,
  );
  await h.post("team/groups/" + team.id, {
    name: latest.name,
    leadUserId: tl.id,
    memberUserIds: [],
    version: latest.version,
  });
  h.state.principal = tl;
  assert.equal(
    (await h.get("office/my-team/clients?q=My%20team%20office")).body.total,
    0,
  );
  assert.equal(
    (await h.get("office/my-team/tasks?q=My%20team%20office")).body.total,
    0,
  );
  await h.get("office/my-team/tasks?memberId=" + a.id, 404);
  assert.deepEqual(
    (await h.get("office/my-team/performance")).body.items.map((m) => m.id),
    [tl.id],
  );
  h.state.principal = owner;
  await h.db.query(
    "UPDATE tenant.teams SET lead_user_id=$2 WHERE company_id=$1 AND id=$3",
    [owner.companyId, b.id, team.id],
  );
  h.state.principal = tl;
  await h.get("office/my-team/performance", 404);
  await h.get("office/my-team/clients", 404);
});
