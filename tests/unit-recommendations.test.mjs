import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { tenantHarness } from "./tenant-harness.mjs";
import { KimiClient } from "../dist/infrastructure/ai/kimi.client.js";
import { KimiRecommendationGateway } from "../dist/modules/sales/recommendations/kimi-recommendation.gateway.js";
let h,
  p,
  other,
  lead,
  dev,
  co,
  within,
  over,
  server,
  mode = "normal",
  calls = [],
  releaseRank;
const needs = {
  types: ["apt"],
  locations: ["New Cairo"],
  minBedrooms: 3,
  maxBedrooms: 3,
  minArea: 120,
  maxArea: 200,
  maxDeliveryYear: 2028,
};
const body = (extra = {}) => ({
  requestId: randomUUID(),
  leadVersion: 0,
  language: "en",
  preferences: {},
  ...extra,
});
async function unit(extra = {}) {
  return (
    await h.db.query(
      "INSERT INTO platform.catalog_items(kind,parent_id,name,status,price_minor,area,bedrooms,data,archived_at) VALUES('units',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [
        extra.parent ?? co.id,
        { en: extra.name ?? "Public apartment", ar: "شقة" },
        extra.status ?? "available",
        extra.price ?? "1000000000",
        extra.area ?? 150,
        extra.bedrooms ?? 3,
        {
          type: extra.type ?? "apt",
          listing: extra.listing ?? "primary",
          location: {
            en: extra.location ?? "New Cairo",
            ar: "القاهرة الجديدة",
          },
          deliveryYear: 2027,
          ...extra.data,
        },
        extra.archived ? new Date() : null,
      ],
    )
  ).rows[0];
}
async function finish(id) {
  for (let n = 0; n < 100; n++) {
    const r = (await h.get(`leads/${lead.id}/unit-recommendations/${id}`)).body;
    if (r.status !== "processing") return r;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Recommendation job did not finish");
}
before(async () => {
  h = await tenantHarness();
  [p, other] = h.principals;
  await h.db.exec(
    "UPDATE platform.companies SET status='active';UPDATE platform.subscriptions SET status='active'",
  );
  lead = (
    await h.db.query(
      "INSERT INTO tenant.leads(company_id,public_id,name,phone,email,segment,want,budget_minor,source,owner_user_id) VALUES($1,'L-AI',$2,'+201012345678','private-buyer@example.test','res',$3,1000000000,'manual',$4) RETURNING *",
      [
        p.companyId,
        { en: "Private Buyer Identity", ar: "اسم خاص" },
        {
          en: "3 bedroom apartment in New Cairo, 120-200 square metres. private-buyer@example.test +201012345678",
          ar: "شقة في القاهرة الجديدة",
        },
        p.id,
      ],
    )
  ).rows[0];
  dev = (
    await h.db.query(
      'INSERT INTO platform.catalog_items(kind,name) VALUES(\'developers\',\'{"en":"Developer","ar":"مطوّر"}\') RETURNING *',
    )
  ).rows[0];
  co = (
    await h.db.query(
      'INSERT INTO platform.catalog_items(kind,parent_id,name) VALUES(\'compounds\',$1,\'{"en":"New Cairo Gardens","ar":"كمباوند"}\') RETURNING *',
      [dev.id],
    )
  ).rows[0];
  within = await unit({ name: "Within budget", price: "1000000000" });
  over = await unit({
    name: "Larger apartment",
    price: "1050000000",
    area: 180,
  });
  await unit({ price: "1100000001" });
  await unit({ listing: "resale" });
  await unit({ listing: "rental" });
  await unit({ status: "hold" });
  await unit({ bedrooms: 2 });
  await unit({ archived: true });
  await unit({ area: 250 });
  const hidden = (
    await h.db.query(
      'INSERT INTO platform.catalog_items(kind,parent_id,name,archived_at) VALUES(\'compounds\',$1,\'{"en":"Hidden","ar":"مخفي"}\',now()) RETURNING *',
      [dev.id],
    )
  ).rows[0];
  await unit({ parent: hidden.id });
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const data of req) raw += data;
    const b = JSON.parse(raw);
    calls.push(b);
    res.setHeader("Content-Type", "application/json");
    if (mode === "unavailable") {
      res.writeHead(429);
      res.end('{"error":{"message":"FAKE_SECRET_NOT_FOR_CLIENTS"}}');
      return;
    }
    const extraction = b.messages[0].content.startsWith("Extract");
    let content;
    if (extraction) content = needs;
    else {
      const facts = JSON.parse(b.messages[1].content);
      if (mode === "hold") await new Promise((r) => (releaseRank = r));
      content = {
        unitIds:
          mode === "invent"
            ? [randomUUID()]
            : [over.id, within.id].filter((id) =>
                facts.candidates.some((c) => c.id === id),
              ),
      };
    }
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(content),
              reasoning_content: "private reasoning",
            },
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 30 },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const transport = (url, options) =>
    fetch(
      `http://127.0.0.1:${server.address().port}/chat/completions`,
      options,
    );
  const client = new KimiClient(
    { apiKey: "fake-key-for-http-fixture-only" },
    transport,
  );
  h.app.get(KimiRecommendationGateway).createClient = () => client;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await h.close();
});
test("recommendations enforce authentication, permissions, lead ownership and tenant boundaries", async () => {
  await h
    .api()
    .post(`/api/v1/leads/${lead.id}/unit-recommendations`)
    .set("Origin", h.origin)
    .send(body())
    .expect(401);
  h.state.principal = { ...p, permissions: ["leads.read"] };
  await h.post(`leads/${lead.id}/unit-recommendations`, body(), 403);
  h.state.principal = other;
  await h.post(`leads/${lead.id}/unit-recommendations`, body(), 404);
  h.state.principal = { ...p, id: other.id, scope: "own" };
  await h.get(`leads/${lead.id}/unit-recommendations`, 404);
  h.state.principal = { ...p, workspace: { mode: "read" } };
  await h.post(`leads/${lead.id}/unit-recommendations`, body(), 403);
  h.state.principal = { ...p, workspace: { mode: "manage" } };
  await h.post(`leads/${lead.id}/unit-recommendations`, body(), 403);
  h.state.principal = p;
  await h.post(
    `leads/${lead.id}/unit-recommendations`,
    body({ leadVersion: 999 }),
    409,
  );
  await h.post(
    `leads/${lead.id}/unit-recommendations`,
    { ...body(), companyId: other.companyId },
    400,
  );
  assert.deepEqual(
    (await h.get(`leads/${lead.id}/unit-recommendations`)).body,
    { run: null },
  );
  assert.equal(calls.length, 0);
});
test("real HTTP provider calls rank only eligible catalog units with explicit 10% budget warnings and no lead identity", async () => {
  const req = body({ preferences: { location: "New Cairo", type: "apt" } });
  const started = (await h.post(`leads/${lead.id}/unit-recommendations`, req))
    .body;
  assert.equal(started.status, "processing");
  const r = await finish(started.id);
  assert.equal(r.status, "succeeded");
  assert.equal(r.result.ceilingMinor, "1100000000");
  assert.equal(r.result.eligibleCount, 2);
  assert.equal(r.result.items.length, 2);
  assert.equal(r.result.items[0].unit.id, over.id);
  assert.equal(r.result.items[0].overBudgetMinor, "50000000");
  assert.match(r.result.items[0].warnings[0].en, /Above budget/);
  assert.equal(r.result.items[1].overBudgetMinor, "0");
  assert.match(r.result.items[1].reasons[0].en, /Within/);
  assert.equal(calls.length, 2);
  const prompts = JSON.stringify(calls);
  for (const privateValue of [
    "Private Buyer Identity",
    "private-buyer@example.test",
    "+201012345678",
    p.companyId,
    lead.id,
  ])
    assert(!prompts.includes(privateValue));
  assert(!JSON.stringify(r).includes("private reasoning"));
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int n FROM tenant.lead_activities WHERE lead_id=$1",
        [lead.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await h.db.query("SELECT stage FROM tenant.leads WHERE id=$1", [lead.id]))
      .rows[0].stage,
    "new",
  );
  const duplicate = (await h.post(`leads/${lead.id}/unit-recommendations`, req))
    .body;
  assert.equal(duplicate.id, started.id);
  const cached = (
    await h.post(
      `leads/${lead.id}/unit-recommendations`,
      body({ preferences: { type: "apt", location: "New Cairo" } }),
    )
  ).body;
  assert.equal(cached.status, "succeeded");
  assert.equal(calls.length, 2);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int n FROM tenant.lead_unit_recommendations WHERE attempted",
      )
    ).rows[0].n,
    1,
  );
  await h.post(
    `leads/${lead.id}/unit-recommendations`,
    { ...req, preferences: { type: "villa" } },
    409,
  );
  // Existing rows written with the old insertion-order fingerprint remain readable.
  await h.db.query(
    "UPDATE tenant.lead_unit_recommendations SET fingerprint='legacy-order-sensitive-hash' WHERE id=$1",
    [started.id],
  );
  assert.equal(
    (await h.get(`leads/${lead.id}/unit-recommendations/${started.id}`)).body
      .status,
    "succeeded",
  );
  assert.equal(
    (await h.post(`leads/${lead.id}/unit-recommendations`, req)).body.id,
    started.id,
  );
  assert.equal(calls.length, 2);
  h.state.principal = other;
  await h.get(`leads/${lead.id}/unit-recommendations/${started.id}`, 404);
  h.state.principal = p;
});
test("explicit refinements are hard filters and no-match runs do not ask Kimi to invent alternatives", async () => {
  const count = calls.length;
  const r = await finish(
    (
      await h.post(
        `leads/${lead.id}/unit-recommendations`,
        body({ preferences: { type: "villa" } }),
      )
    ).body.id,
  );
  assert.equal(r.status, "succeeded");
  assert.equal(r.result.eligibleCount, 0);
  assert.deepEqual(r.result.items, []);
  assert.equal(calls.length, count + 1);
});
test("provider failure and invented unit IDs are safe failures, with no paid automatic retries", async () => {
  mode = "unavailable";
  let count = calls.length;
  const input = body({ preferences: { minArea: 130 } });
  let r = await finish(
    (await h.post(`leads/${lead.id}/unit-recommendations`, input)).body.id,
  );
  assert.equal(r.status, "failed");
  assert.equal(r.error.code, "provider_unavailable");
  assert(!JSON.stringify(r).includes("FAKE_SECRET"));
  await h.post(`leads/${lead.id}/unit-recommendations`, input);
  assert.equal(calls.length, count + 1);
  mode = "invent";
  r = await finish(
    (
      await h.post(
        `leads/${lead.id}/unit-recommendations`,
        body({ preferences: { minArea: 131 } }),
      )
    ).body.id,
  );
  assert.equal(r.status, "failed");
  assert.equal(r.error.code, "ai_invalid_response");
  assert.equal(r.result, null);
  mode = "normal";
});
test("changed catalog data invalidates cached recommendations and in-flight jobs", async () => {
  mode = "hold";
  const started = (
    await h.post(
      `leads/${lead.id}/unit-recommendations`,
      body({ preferences: { minArea: 132 } }),
    )
  ).body;
  for (let n = 0; n < 100 && !releaseRank; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert(releaseRank);
  await h.db.query(
    "UPDATE platform.catalog_items SET version=version+1,updated_at=now() WHERE id=$1",
    [within.id],
  );
  releaseRank();
  const r = await finish(started.id);
  assert.notEqual(r.status, "succeeded");
  assert.equal(r.result, null);
  assert.equal(r.error.code, "lead_or_catalog_changed");
  mode = "normal";
  releaseRank = undefined;
});
test("audit failures prevent paid requests and rate limits are enforced per company", async () => {
  h.state.failAudit = true;
  let count = calls.length;
  await h.post(
    `leads/${lead.id}/unit-recommendations`,
    body({ preferences: { minArea: 133 } }),
    500,
  );
  h.state.failAudit = false;
  assert.equal(calls.length, count);
  await h.db.query(
    "INSERT INTO tenant.lead_unit_recommendations(company_id,lead_id,user_id,request_id,fingerprint,input,status) SELECT $1,$2,$3,gen_random_uuid(),'fixture','{}','failed' FROM generate_series(1,100)",
    [p.companyId, lead.id, p.id],
  );
  await h.post(
    `leads/${lead.id}/unit-recommendations`,
    body({ preferences: { minArea: 134 } }),
    429,
  );
  assert.equal(calls.length, count);
});
