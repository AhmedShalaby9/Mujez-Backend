import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { tenantHarness } from "./tenant-harness.mjs";
import {
  parseColdFile,
  coldTemplate,
} from "../dist/modules/sales/cold-calls/cold-calls-file.js";
let h, p, other, rows;
const data =
  "name,phone\nAhmed,01012345678\nAhmed repeated,+201012345678\nReem,+201112345678\nBad,no-number\n,01212345678\n";
const b = (x) => ({ requestId: randomUUID(), ...x });
const upload = (
  path,
  raw = data,
  fields = {},
  status = 201,
  name = "contacts.csv",
) => {
  let r = h
    .api()
    .post("/api/v1/cold-calls/" + path)
    .set("Origin", h.origin)
    .set("Cookie", "__Host-mujez_session=" + "a".repeat(64));
  const merged =
    path === "columns" ? fields : { nameColumn: 1, phoneColumn: 2, ...fields };
  for (const [k, v] of Object.entries(merged)) r = r.field(k, v);
  return r
    .attach("file", Buffer.from(raw), {
      filename: name,
      contentType: name.endsWith("xlsx")
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "text/csv",
    })
    .expect(status);
};
before(async () => {
  h = await tenantHarness();
  [p, other] = h.principals;
});
after(() => h?.close());
afterEach(() => {
  h.state.principal = p;
  h.state.failAudit = false;
});
const mapping = { nameColumn: 1, phoneColumn: 2 };
test("CSV and XLSX honor the chosen column mapping in any order, preserve phone text, reject formulas/numbers/oversized/too-narrow sheets", async () => {
  const parsed = await parseColdFile(
    { buffer: Buffer.from("\uFEFF" + data), originalname: "data.csv" },
    mapping,
  );
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.duplicate, 1);
  assert.equal(parsed.errors.length, 2);
  assert.equal(parsed.rows[0].phone, "+201012345678");
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet("Contacts");
  s.addRow(["name", "phone"]);
  s.addRow(["Arabic", "٠١٢١٢٣٤٥٦٧٨"]);
  s.addRow(["Number", 1012345678]);
  s.addRow(["Formula", { formula: "1+1", result: "01000000000" }]);
  const x = await parseColdFile(
    {
      buffer: Buffer.from(await w.xlsx.writeBuffer()),
      originalname: "contacts.xlsx",
    },
    mapping,
  );
  assert.equal(x.rows.length, 1);
  assert.equal(x.errors.length, 2);
  const swapped = await parseColdFile(
    {
      buffer: Buffer.from("phone,name\n01012345678,Someone"),
      originalname: "swapped.csv",
    },
    { nameColumn: 2, phoneColumn: 1 },
  );
  assert.equal(swapped.rows[0].name, "Someone");
  assert.equal(swapped.rows[0].phone, "+201012345678");
  await assert.rejects(
    parseColdFile(
      { buffer: Buffer.from("name\nOnlyOneColumn"), originalname: "one.csv" },
      mapping,
    ),
    (e) => e.getStatus() === 400,
  );
  await assert.rejects(
    parseColdFile(
      { buffer: Buffer.from(data), originalname: "data.csv" },
      { nameColumn: 1, phoneColumn: 1 },
    ),
    (e) => e.getStatus() === 400,
  );
  await assert.rejects(
    parseColdFile(
      {
        buffer: Buffer.from(
          "name,phone\n" + "Someone,01012345678\n".repeat(2001),
        ),
        originalname: "large.csv",
      },
      mapping,
    ),
    (e) => e.getStatus() === 400,
  );
  await assert.rejects(
    parseColdFile(
      { buffer: Buffer.from("binary"), originalname: "old.xls" },
      mapping,
    ),
    (e) => e.getStatus() === 400,
  );
  const t = new ExcelJS.Workbook();
  await t.xlsx.load(await coldTemplate());
  assert.equal(t.worksheets[0].getColumn(2).numFmt, "@");
});
test("the columns endpoint reports headers and sample rows so the caller can map any layout, including extra columns", async () => {
  const raw =
    "full name,city,mobile\nSara,Cairo,01055555555\nKhaled,Giza,01066666666\n";
  const cols = (await upload("columns", raw, {})).body;
  assert.deepEqual(cols.columns, [
    { index: 1, label: "full name" },
    { index: 2, label: "city" },
    { index: 3, label: "mobile" },
  ]);
  assert.deepEqual(cols.sample, [
    ["Sara", "Cairo", "01055555555"],
    ["Khaled", "Giza", "01066666666"],
  ]);
  assert.equal(cols.totalRows, 2);
  const preview = (
    await upload("preview", raw, { nameColumn: 1, phoneColumn: 3 })
  ).body;
  assert.equal(preview.valid, 2);
  assert.equal(preview.sample[0].name, "Sara");
  assert.equal(preview.sample[0].phone, "+201055555555");
});
test("preview has no CRM writes; importing is scoped, deduplicated and idempotent without adding pipeline leads", async () => {
  const preview = (await upload("preview")).body;
  assert.equal(preview.valid, 2);
  assert.equal(preview.rejected, 2);
  assert.equal(preview.duplicates, 1);
  assert.equal((await h.get("cold-calls")).body.total, 0);
  const req = b({});
  const first = (await upload("import", data, req)).body;
  assert.equal(first.imported, 2);
  assert.deepEqual((await upload("import", data, req)).body, first);
  assert.equal((await upload("import", data, b({}))).body.imported, 0);
  assert.equal((await h.get("leads")).body.total, 0);
  assert.equal((await h.get("pipeline")).body.total, 0);
  rows = (await h.get("cold-calls")).body.items;
  assert.equal(rows.length, 2);
  h.state.principal = other;
  assert.equal((await h.get("cold-calls")).body.total, 0);
  await h.post(
    "cold-calls/" + rows[0].id + "/convert",
    b({ version: 0, segment: "res", want: "Apartment" }),
    404,
  );
  const isolated = await h.database.tenant(
    other.companyId,
    async (c) =>
      (await c.query("SELECT count(*)::int n FROM tenant.cold_calls")).rows[0]
        .n,
  );
  assert.equal(isolated, 0);
});
test("conversion atomically creates exactly one assigned CRM lead and pipeline placeholder and preserves lineage", async () => {
  const req = b({ version: 0, segment: "res", want: "Apartment" });
  const result = (await h.post("cold-calls/" + rows[0].id + "/convert", req))
    .body;
  assert.deepEqual(
    (await h.post("cold-calls/" + rows[0].id + "/convert", req)).body,
    result,
  );
  const lead = (await h.get("leads/" + result.leadId)).body;
  assert.equal(lead.owner.id, p.id);
  assert.equal(lead.source, "phone");
  assert.equal((await h.get("pipeline")).body.total, 1);
  await h.post(
    "cold-calls/" + rows[0].id + "/convert",
    b({ ...req, requestId: randomUUID(), version: 1 }),
    409,
  );
  const converted = (await h.get("cold-calls?status=converted")).body.items;
  assert.equal(converted[0].leadId, result.leadId);
});
test("audit failure rolls back imports and conversions; duplicate CRM contacts are skipped", async () => {
  h.state.failAudit = true;
  await upload("import", "name,phone\nRollback,01212345679", b({}), 500);
  assert.equal((await h.get("cold-calls?status=all")).body.total, 2);
  await h.post(
    "cold-calls/" + rows[1].id + "/convert",
    b({ version: 0, segment: "res", want: "Villa" }),
    500,
  );
  assert.equal((await h.get("leads")).body.total, 1);
  h.state.failAudit = false;
  const preview = (
    await upload("preview", "name,phone\nExisting," + rows[0].phone)
  ).body;
  assert.equal(preview.valid, 0);
  assert.equal(preview.duplicates, 1);
});
test("own-scope users cannot read or convert another agent records or assign their import to someone else", async () => {
  p.permissions.push("team.read", "team.manage");
  const invite = (
    await h.post("team/invite", {
      name: "Cold Sales",
      email: "cold@example.test",
      role: "agent",
    })
  ).body;
  await h.post(
    "team/activate",
    { token: invite.token, password: "cold-sales-fixture-password" },
    200,
  );
  const account = (
    await h.db.query(
      "SELECT * FROM platform.company_employee_accounts WHERE id=$1",
      [invite.accountId],
    )
  ).rows[0];
  const { SessionService } =
    await import("../dist/common/auth/session.service.js");
  const principal = await new SessionService(h.database, {
    consume: async () => true,
  }).employeeProfile(account);
  const id = principal.id;
  h.state.principal = principal;
  assert.equal((await h.get("cold-calls?status=all")).body.total, 0);
  await h.post(
    "cold-calls/" + rows[1].id + "/convert",
    b({ version: 0, segment: "res", want: "Villa" }),
    404,
  );
  await upload("preview", data, { ownerId: p.id }, 403);
  const own = (await upload("import", "name,phone\nOwn,01212345670", b({})))
    .body;
  assert.equal(own.imported, 1);
  assert.equal((await h.get("cold-calls")).body.items[0].ownerId, id);
  h.state.principal = { ...p, permissions: ["leads.read"] };
  await upload("preview", data, {}, 403);
});
