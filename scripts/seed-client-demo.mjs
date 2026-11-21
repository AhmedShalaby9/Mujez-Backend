// Explicit staging-only client demo. Creates synthetic records in one isolated demo company.
// Existing Jeeran and shared catalog records are never modified.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url),
  PDFDocument = require("pdfkit");
const credentialsArg = process.argv
  .find((x) => x.startsWith("--credentials="))
  ?.slice(14);
const stateArg = process.argv.find((x) => x.startsWith("--state="))?.slice(8);
if (!credentialsArg || !stateArg)
  throw Error(
    "Use --credentials=/private/file.json --state=/private/demo-state.json",
  );
const cfg = JSON.parse(await readFile(credentialsArg, "utf8"));
if (!/^[a-f0-9-]{36}$/.test(cfg.id)) throw Error("Invalid demo company ID");
if (!/^mujez-client-demo-\d{8}$/.test(cfg.slug))
  throw Error(
    "Only an explicitly provisioned isolated client demo company is allowed",
  );
const API = "https://api-stg.mujez.net/api/v1/",
  ORIGIN = "https://mujez-stg.mujez.net";
let state;
try {
  state = JSON.parse(await readFile(stateArg, "utf8"));
} catch {
  state = { companyId: cfg.id, slug: cfg.slug, results: {}, requests: {} };
}
if (state.companyId !== cfg.id)
  throw Error("State company does not match credentials");
const save = () =>
  writeFile(stateArg, JSON.stringify(state, null, 2), { mode: 0o600 });
const stableId = (key) => {
  const h = createHash("sha256")
    .update(cfg.slug + ":" + key)
    .digest("hex")
    .slice(0, 32);
  return (
    h.slice(0, 8) +
    "-" +
    h.slice(8, 12) +
    "-4" +
    h.slice(13, 16) +
    "-a" +
    h.slice(17, 20) +
    "-" +
    h.slice(20)
  );
};
async function login(email) {
  const r = await fetch(API + "auth/login", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: cfg.password }),
  });
  if (r.status !== 200) throw Error("Demo login failed (" + r.status + ")");
  return r.headers
    .getSetCookie()
    .map((x) => x.split(";")[0])
    .join("; ");
}
const ownerCookie = await login(cfg.email);
async function request(path, body, cookie = ownerCookie) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const multipart = body instanceof FormData;
    const r = await fetch(API + path, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: ORIGIN,
        Cookie: cookie,
        ...(multipart ? {} : { "Content-Type": "application/json" }),
      },
      ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
    });
    const raw = await r.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
    if (r.status === 429 && attempt < 3) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(Number(r.headers.get("retry-after") ?? 5) * 1000, 30000),
        ),
      );
      continue;
    }
    if (!r.ok)
      throw Error(path + " [" + r.status + "] " + JSON.stringify(data));
    return data;
  }
  throw Error("Demo request rate limit");
}
async function once(key, path, body, cookie = ownerCookie) {
  if (state.results[key]) return state.results[key];
  if (!state.requests[key]) {
    state.requests[key] = { path, body: { requestId: stableId(key), ...body } };
    await save();
  }
  const pending = state.requests[key];
  pending.path = path;
  if (key === "attendance-assignment")
    pending.body.effectiveFrom = body.effectiveFrom;
  if (key.startsWith("employee-profile-"))
    pending.body.managerId = body.managerId;
  if (pending.path === "team/groups") delete pending.body.requestId;
  const r = await request(pending.path, pending.body, cookie);
  state.results[key] = r;
  await save();
  return r;
}
const me = await request("auth/session");
if (
  me.company?.slug !== cfg.slug &&
  me.companyId !== cfg.id &&
  me.company?.id !== cfg.id &&
  me.company?.uuid !== cfg.id
)
  throw Error("Session does not belong to isolated demo company");
const context = await request("accounting/context");
state.today ??= context.today;
await save();
const today = state.today,
  at = (offset) =>
    new Date(Date.parse(today + "T00:00:00Z") + offset * 86400000)
      .toISOString()
      .slice(0, 10),
  minor = (n) => String(BigInt(n) * 100n);
if (!context.configured)
  await once("finance-setup", "accounting/setup", {
    year: Number(today.slice(0, 4)),
  });
const opts = await request("accounting/options");
const staff = cfg.staff.map((u) => ({
  ...u,
  ...opts.users.find((x) => x.email === u.email || x.name === u.name),
}));
// Options intentionally omit emails; the manifest's unique display names map each demo role.
if (staff.some((u) => !u.id))
  throw Error("A provisioned demo employee is missing");
const sales = staff.filter((u) => u.roles.includes("agent")),
  leads = staff.filter((u) => u.roles.includes("team_lead"));
const employeeFor = (user) => opts.employees.find((e) => e.user_id === user.id);
for (let n = 0; n < 2; n++)
  await once("team-" + n, "team/groups", {
    name: ["Residential Sales", "Investment Sales"][n],
    leadUserId: leads[n].id,
    memberUserIds: sales.slice(n * 3, n * 3 + 3).map((x) => x.id),
  });
console.log("Demo teams ready");
const departments = {};
for (const [key, name] of [
  ["sales", "Sales & Brokerage"],
  ["hr", "People Operations"],
  ["finance", "Finance & Accounting"],
  ["operations", "Office Operations"],
])
  departments[key] = await once("department-" + key, "hr/departments", {
    name,
    description: "Client demo — synthetic single-office organization",
  });
for (let i = 0; i < staff.length; i++) {
  const u = staff[i],
    e = employeeFor(u);
  if (!e) throw Error("Missing HR profile");
  const key = u.roles.some((r) => ["agent", "team_lead"].includes(r))
    ? "sales"
    : u.roles.includes("hr_manager")
      ? "hr"
      : u.roles.some((r) => ["finance_manager", "payroll_officer"].includes(r))
        ? "finance"
        : "operations";
  const row = (await request("hr/employees?limit=100")).items.find(
    (x) => x.id === e.id,
  );
  await once("employee-profile-" + u.key, "hr/employees/" + e.id, {
    version: row?.version ?? 1,
    name: u.name,
    email: u.email,
    userId: u.id,
    managerId: row?.managerId ?? null,
    jobTitle: u.roles.includes("team_lead")
      ? "Sales Team Lead"
      : u.roles.includes("agent")
        ? "Property Consultant"
        : u.roles.includes("hr_manager")
          ? "HR Manager"
          : u.roles.includes("finance_manager")
            ? "Finance Manager"
            : u.roles.includes("payroll_officer")
              ? "Payroll Specialist"
              : "Office Coordinator",
    departmentId: departments[key].id,
    employmentType: "full_time",
    status: "active",
    joiningDate: at(-420 - i * 20),
    notes:
      "Synthetic employee profile for the client presentation; no real employee identity.",
  });
}
// The private inventory supplies connected reservation/contract examples; shared catalog is untouched.
const projects = [],
  units = [];
for (let i = 0; i < 3; i++) {
  const p = await once("project-" + i, "projects", {
    code: "DEMO-P" + (i + 1),
    name: [
      "Garden Residence — Demo",
      "West Park — Demo",
      "Business Square — Demo",
    ][i],
    nameAr: ["جاردن ريزيدنس — عرض", "ويست بارك — عرض", "بيزنس سكوير — عرض"][i],
    developer: [
      "Cairo Development — Demo",
      "West Communities — Demo",
      "Urban Projects — Demo",
    ][i],
    location: ["New Cairo", "6th of October", "New Capital"][i],
    locationAr: ["القاهرة الجديدة", "السادس من أكتوبر", "العاصمة الإدارية"][i],
    segment: i === 2 ? "com" : "res",
  });
  const phase = await once("phase-" + i, "projects/" + p.id + "/phases", {
    code: "PH1",
    name: "Phase One",
    nameAr: "المرحلة الأولى",
    deliveryYear: 2027,
  });
  const building = await once(
    "building-" + i,
    "projects/phases/" + phase.id + "/buildings",
    { code: "B1", name: "Building One", nameAr: "المبنى الأول", floors: 8 },
  );
  projects.push(p);
  for (let j = 0; j < 3; j++) {
    const unit = await once("unit-" + i + "-" + j, "units", {
      code: "DEMO-" + (i + 1) + "0" + (j + 1),
      buildingId: building.id,
      listing: "primary",
      location: ["New Cairo", "6th of October", "New Capital"][i],
      type: i === 2 ? "office" : "apt",
      bedrooms: i === 2 ? null : 2 + j,
      area: 110 + j * 35,
      view: "Garden / city view",
      viewAr: "إطلالة على الحديقة أو المدينة",
      floor: 2 + j,
      priceMinor: minor(4800000 + i * 1700000 + j * 850000),
    });
    units.push({
      ...unit,
      projectIndex: i,
      priceMinor: minor(4800000 + i * 1700000 + j * 850000),
    });
  }
}
const names = [
  ["Ahmed Hassan", "أحمد حسن"],
  ["Mona Adel", "منى عادل"],
  ["Khaled Mostafa", "خالد مصطفى"],
  ["Reem Mahmoud", "ريم محمود"],
  ["Mohamed Nabil", "محمد نبيل"],
  ["Nadine Samir", "نادين سمير"],
  ["Hossam Tarek", "حسام طارق"],
  ["Aya Ibrahim", "آية إبراهيم"],
  ["Walid Magdy", "وليد مجدي"],
  ["Dalia Fathy", "داليا فتحي"],
  ["Tamer Sameh", "تامر سامح"],
  ["Hana Yasser", "هنا ياسر"],
  ["Mostafa Sherif", "مصطفى شريف"],
  ["Noha Emad", "نهى عماد"],
  ["Amr Wael", "عمرو وائل"],
  ["Salma Ashraf", "سلمى أشرف"],
  ["Yasser Fawzy", "ياسر فوزي"],
  ["Farida Hesham", "فريدة هشام"],
  ["Mahmoud Zaki", "محمود زكي"],
  ["May Ahmed", "مي أحمد"],
  ["Karim Omar", "كريم عمر"],
  ["Laila Hussein", "ليلى حسين"],
  ["Adel Gamal", "عادل جمال"],
  ["Malak Hany", "ملك هاني"],
  ["Sherif Salah", "شريف صلاح"],
  ["Rana Khaled", "رنا خالد"],
  ["Islam Saad", "إسلام سعد"],
  ["Nour Samy", "نور سامي"],
  ["Ehab Farouk", "إيهاب فاروق"],
  ["Basma Essam", "بسمة عصام"],
  ["Seif Alaa", "سيف علاء"],
  ["Yasmin Ali", "ياسمين علي"],
  ["Fady Raouf", "فادي رؤوف"],
  ["Hala Magdy", "هالة مجدي"],
  ["Hazem Nasser", "حازم ناصر"],
  ["Nada Soliman", "ندى سليمان"],
];
const stages = [
  "new",
  "attempting",
  "contacted",
  "qualified",
  "nurturing",
  "unresponsive",
  "viewing",
  "offer",
  "contract",
  "won",
  "lost",
  "unqualified",
];
const buyers = [];
for (let i = 0; i < names.length; i++) {
  const owner = sales[i % sales.length],
    budget = minor(5500000 + (i % 8) * 1250000),
    segment = i % 5 === 4 ? "com" : "res";
  const l = await once("lead-" + i, "leads", {
    name: names[i][0],
    nameAr: names[i][1],
    phone: "+1202555" + String(100 + i).padStart(4, "0"),
    email: "buyer" + (i + 1) + "@mujez-demo.test",
    segment,
    want:
      segment === "com"
        ? "Office in a serviced business district"
        : "Apartment in " +
          ["New Cairo", "6th of October", "New Capital"][i % 3],
    wantAr:
      segment === "com"
        ? "مكتب في منطقة أعمال متكاملة"
        : "شقة في " +
          ["القاهرة الجديدة", "السادس من أكتوبر", "العاصمة الإدارية"][i % 3],
    budgetMinor: budget,
    source: ["website", "referral", "social", "phone", "walk_in", "manual"][
      i % 6
    ],
    ownerId: owner.id,
    score: 50 + ((i * 7) % 48),
  });
  const detail = state.results["deal-details-" + i]
    ? { version: 0, opportunity: null }
    : await request("leads/" + l.id);
  const opportunity = detail.opportunity;
  await once(
    "deal-details-" + i,
    opportunity?.id ? "pipeline/" + opportunity.id + "/update" : "pipeline",
    {
      ...(opportunity?.id ? {} : { leadId: l.id }),
      version: opportunity?.version ?? detail.version,
      title:
        names[i][0] +
        " — " +
        (segment === "com" ? "Office purchase" : "Home purchase"),
      titleAr: names[i][1] + " — شراء " + (segment === "com" ? "مكتب" : "شقة"),
      type: "sale",
      valueMinor: budget,
    },
  );
  const stage = stages[i % stages.length];
  const current =
    stage !== "new" && !state.results["lead-stage-" + i]
      ? await request("leads/" + l.id)
      : { version: 0 };
  if (stage !== "new")
    await once("lead-stage-" + i, "leads/" + l.id + "/stage", {
      version: current.version,
      stage,
      reason: "Client demo sales progression — synthetic scenario",
    });
  if (i < 18 && !state.results["lead-note-" + i]) {
    const fresh = await request("leads/" + l.id);
    await once("lead-note-" + i, "leads/" + l.id + "/notes", {
      version: fresh.version,
      kind: i % 3 === 0 ? "call" : "note",
      ...(i % 3 === 0 ? { outcome: "interested" } : {}),
      note: [
        "Client interested in a 3-bedroom home, handover within two years. Demo scenario.",
        "Viewing arranged; compare payment schedules and service charges. Demo scenario.",
        "Follow up on preferred area, down payment and installment budget. Demo scenario.",
      ][i % 3],
    });
  }
  if (i < 18)
    await once("contact-" + i, "contacts", {
      type: i % 6 === 0 ? "investor" : "buyer",
      name: names[i][0],
      nameAr: names[i][1],
      phones: ["+1202555" + String(100 + i).padStart(4, "0")],
      emails: ["buyer" + (i + 1) + "@mujez-demo.test"],
      area: ["New Cairo", "6th of October", "New Capital"][i % 3],
      ownerId: owner.id,
      tags: ["Client demo", segment === "com" ? "Commercial" : "Residential"],
      notes: "Fictional contact for presentation; no real messages are sent.",
    });
  buyers.push({ id: l.id, ownerId: owner.id, index: i, name: names[i][0] });
}
// Team leads also manage their own high-value opportunities for role-based demo landing pages.
for (let i = 0; i < 4; i++) {
  const owner = leads[Math.floor(i / 2)],
    name = ["Fouad Mansour", "Rania Saeed", "Nabil Lotfy", "Hania Sami"][i],
    nameAr = ["فؤاد منصور", "رانيا سعيد", "نبيل لطفي", "هانيا سامي"][i];
  const lead = await once("lead-personal-" + i, "leads", {
    name,
    nameAr,
    phone: "+1202555" + String(136 + i).padStart(4, "0"),
    email: "vip" + i + "@mujez-demo.test",
    segment: i % 2 ? "com" : "res",
    want: i % 2 ? "Office in New Capital" : "Villa in New Cairo",
    wantAr: i % 2 ? "مكتب في العاصمة الإدارية" : "فيلا في القاهرة الجديدة",
    budgetMinor: minor(20000000 + i * 2500000),
    source: "referral",
    ownerId: owner.id,
    score: 92 + i,
  });
  if (!state.results["lead-personal-deal-" + i]) {
    const current = await request("leads/" + lead.id);
    await once("lead-personal-deal-" + i, "pipeline", {
      leadId: lead.id,
      version: current.version,
      title: name + " — investment opportunity",
      titleAr: nameAr + " — فرصة استثمارية",
      type: "sale",
      valueMinor: minor(20000000 + i * 2500000),
    });
  }
  if (!state.results["lead-personal-stage-" + i]) {
    const current = await request("leads/" + lead.id);
    await once("lead-personal-stage-" + i, "leads/" + lead.id + "/stage", {
      version: current.version,
      stage: i % 2 ? "viewing" : "qualified",
      reason: "Client demo — team leader personal opportunity",
    });
  }
  await once("lead-personal-task-" + i, "tasks", {
    title: "Review VIP shortlist — " + name,
    titleAr: "مراجعة القائمة المختصرة — " + nameAr,
    description: "Demo team lead personal follow-up",
    leadId: lead.id,
    assigneeId: owner.id,
    dueDate: at(i % 2),
    priority: "high",
  });
  if (i % 2 === 0)
    await once("lead-personal-event-" + i, "events", {
      type: "meeting",
      title: "VIP investment consultation — " + name,
      titleAr: "استشارة استثمار — " + nameAr,
      startsAt: at(1) + "T14:00:00+02:00",
      endsAt: at(1) + "T15:00:00+02:00",
      leadId: lead.id,
      ownerId: owner.id,
      place: "Single company office — Demo",
    });
  buyers.push({ id: lead.id, ownerId: owner.id, index: 36 + i, name });
}
console.log("Demo CRM leads, pipeline and contacts ready");
for (let i = 0; i < 30; i++) {
  const buyer = buyers[i],
    task = await once("task-" + i, "tasks", {
      title:
        [
          "Call to qualify requirements",
          "Prepare property shortlist",
          "Confirm viewing appointment",
          "Compare developer payment plans",
          "Send updated availability",
          "Review booking documents",
        ][i % 6] +
        " — " +
        buyer.name,
      titleAr: [
        "مكالمة لتحديد الاحتياجات",
        "تجهيز قائمة وحدات مناسبة",
        "تأكيد موعد المعاينة",
        "مقارنة خطط سداد المطورين",
        "مراجعة توافر الوحدات",
        "مراجعة مستندات الحجز",
      ][i % 6],
      description: "Synthetic demo task linked to the assigned lead.",
      leadId: buyer.id,
      assigneeId: buyer.ownerId,
      dueDate: at([-2, -1, 0, 0, 1, 2, 4, 7][i % 8]),
      priority: ["high", "med", "low"][i % 3],
    });
  if (i >= 22)
    await once("task-complete-" + i, "tasks/" + task.id + "/status", {
      version: task.version ?? 0,
      action: "complete",
    });
}
for (let i = 0; i < 8; i++)
  await once("calendar-" + i, "events", {
    type: ["viewing", "call", "meeting", "signing"][i % 4],
    title: [
      "Garden Residence viewing",
      "Investment consultation",
      "Payment plan review",
      "Booking documents meeting",
    ][i % 4],
    titleAr: [
      "معاينة جاردن ريزيدنس",
      "استشارة استثمار عقاري",
      "مراجعة خطة السداد",
      "اجتماع مستندات الحجز",
    ][i % 4],
    startsAt:
      at(i % 4) + "T" + String(11 + (i % 5)).padStart(2, "0") + ":00:00+02:00",
    endsAt:
      at(i % 4) + "T" + String(12 + (i % 5)).padStart(2, "0") + ":00:00+02:00",
    leadId: buyers[i].id,
    ownerId: buyers[i].ownerId,
    place: i % 2 ? "Company office" : "Demo project sales office",
    notes: "Presentation example; no external appointment invitation.",
  });
// A conspicuous nonbinding PDF is evidence for simulated contracts/documents.
if (!state.pdf) {
  const chunks = [];
  const pdf = new PDFDocument({
    size: "A4",
    info: {
      Title: "DEMONSTRATION ONLY — nonbinding sample",
      CreationDate: new Date(today + "T00:00:00Z"),
    },
  });
  pdf.on("data", (x) => chunks.push(x));
  const done = new Promise((resolve) => pdf.on("end", resolve));
  pdf.fontSize(24).text("DEMONSTRATION ONLY");
  pdf
    .moveDown()
    .fontSize(13)
    .text(
      "Nonbinding sample document for the Mujez client presentation.\nAll names, employment records and financial transactions in this demo company are fictional.\nThis is not evidence of a real sale, signature, payment or identity.",
    );
  pdf.end();
  await done;
  state.pdf = Buffer.concat(chunks).toString("base64");
  await save();
}
async function document(key, path, fields) {
  if (state.results[key]) return state.results[key];
  const f = new FormData();
  f.set("requestId", stableId(key));
  for (const [k, v] of Object.entries(fields))
    if (v !== null && v !== undefined) f.set(k, String(v));
  f.set(
    "file",
    new Blob([Buffer.from(state.pdf, "base64")], { type: "application/pdf" }),
    "DEMO-nonbinding-sample.pdf",
  );
  const r = await request(path, f);
  state.results[key] = r;
  await save();
  return r;
}
// Real ledger entries within the isolated demo: all references explicitly identify demonstration data.
const bank = await once("treasury-bank", "accounting/treasuries", {
    name: "Operating bank — Demo",
    kind: "bank",
    bankReference: "DEMO-ACCOUNT-NOT-A-REAL-BANK",
  }),
  cash = (await request("accounting/treasuries")).items.find(
    (x) => x.kind === "cash",
  );
const account = (key) => opts.accounts.find((x) => x.system_key === key)?.id;
const opening = await once("opening-journal", "accounting/journals", {
  date: at(-80),
  memo: "DEMO opening balances — simulated money",
  cashFlow: "opening",
  lines: [
    {
      accountId:
        bank.accountId ??
        (await request("accounting/treasuries")).items.find(
          (x) => x.id === bank.id,
        ).account_id,
      debitMinor: minor(2500000),
    },
    { accountId: cash.account_id, debitMinor: minor(100000) },
    { accountId: account("opening_equity"), creditMinor: minor(2600000) },
  ],
});
await once("opening-post", "accounting/journals/" + opening.id + "/action", {
  version: 1,
  action: "post",
});
const costCentres = [];
for (const name of [
  "Office Operations",
  "Marketing & Lead Generation",
  "Sales Operations",
])
  costCentres.push(
    await once("centre-" + name, "accounting/dimensions", {
      kind: "cost_centre",
      name,
    }),
  );
const developers = [];
for (const name of [
  "Cairo Development — Demo",
  "West Communities — Demo",
  "Urban Projects — Demo",
])
  developers.push(
    await once("developer-" + name, "accounting/parties", {
      kind: "developer",
      name,
      email: "accounts@developer-demo.test",
    }),
  );
const supplier = await once("supplier", "accounting/parties", {
  kind: "supplier",
  name: "Office Services — Demo",
  email: "accounts@supplier-demo.test",
});
const agreements = [];
for (let i = 0; i < 3; i++)
  agreements.push(
    await once("agreement-" + i, "accounting/agreements", {
      developerId: developers[i].id,
      name:
        [
          "Residential sales 3%",
          "Investment sales 4%",
          "Commercial sales 2.5%",
        ][i] + " — Demo",
      mode: "percent",
      rateBps: [300, 400, 250][i],
      agentBps: 2000,
      leadBps: 500,
      dueDays: 30,
    }),
  );
await once("agent-policy", "accounting/commission-policies", {
  name: "Property consultants — 20% of brokerage commission",
  roleKey: "agent",
  mode: "percent",
  rateBps: 2000,
  from: at(-90),
});
await once("lead-policy", "accounting/commission-policies", {
  name: "Team leaders — 5% of brokerage commission",
  roleKey: "team_lead",
  mode: "percent",
  rateBps: 500,
  from: at(-90),
});
const contracts = [];
for (let i = 0; i < 6; i++) {
  const unit = units[i],
    buyer = buyers[i];
  let res = await once("reservation-" + i, "reservations", {
    unitId: unit.id,
    unitVersion: unit.version ?? 0,
    leadId: buyer.id,
    assigneeId: buyer.ownerId,
    hours: 72,
  });
  res = await once(
    "reservation-confirm-" + i,
    "reservations/" + res.id + "/action",
    {
      version: res.version ?? 0,
      action: "confirm",
      depositMinor: minor(50000 + i * 10000),
    },
  );
  const currentUnit = await request("units/" + unit.id);
  const contract = await once("contract-" + i, "contracts", {
    type: "sale",
    leadId: buyer.id,
    ownerId: buyer.ownerId,
    unitId: unit.id,
    unitVersion: currentUnit.version,
    reservationId: res.id,
    reservationVersion: res.version,
    title: "DEMO sale agreement — " + buyer.name,
    titleAr: "عقد بيع تجريبي — " + names[i][1],
    valueMinor: unit.priceMinor,
    keyDate: at(45 + i * 10),
    signers: [{ name: buyer.name, role: "Demo buyer" }],
    requirements: [],
  });
  contracts.push(contract);
  if (i < 4) {
    const doc = await document("contract-file-" + i, "documents", {
      kind: "contract",
      title: "DEMO nonbinding contract evidence",
      leadId: buyer.id,
      contractId: contract.id,
    });
    const current = await request("contracts/" + contract.id);
    await once("contract-sign-" + i, "contracts/" + contract.id + "/action", {
      version: current.version,
      action: "record_signed",
      signedDate: at(-45 + i * 12),
      documentId: doc.id,
      reason:
        "Demonstration only: record simulated signature using a clearly nonbinding sample document.",
    });
    const deal = (await request("accounting/deals?limit=100")).items.find(
      (x) => x.contract_id === contract.id,
    );
    await once("book-deal-" + i, "accounting/deals/" + deal.id + "/book", {
      version: deal.version,
      agreementId: agreements[unit.projectIndex].id,
      agreementVersion: 1,
      date: at(-45 + i * 12),
      agentId: buyer.ownerId,
      costCentreId: costCentres[2].id,
    });
    const obligations = (
      await request("accounting/obligations?limit=100")
    ).items.filter((x) => x.deal_id === deal.id);
    const claim = obligations.find((x) => x.kind === "developer_claim");
    if (i < 3)
      await once("developer-receipt-" + i, "accounting/transactions", {
        kind: "receipt",
        date: at(-20 + i * 6),
        treasuryId: bank.id,
        obligationId: claim.id,
        amountMinor:
          i === 1 ? String(BigInt(claim.total_minor) / 2n) : claim.total_minor,
        method: "bank_transfer",
        reference: "DEMO collection " + (i + 1),
        memo: "DEMO developer commission collection — simulated money",
      });
    for (const [n, o] of obligations
      .filter((x) => x.kind === "commission_payable")
      .entries())
      if (i < 2)
        await once(
          "commission-payment-" + i + "-" + n,
          "accounting/transactions",
          {
            kind: "payment",
            date: at(-12 + i * 5),
            treasuryId: bank.id,
            obligationId: o.id,
            amountMinor:
              i === 1 ? String(BigInt(o.total_minor) / 2n) : o.total_minor,
            method: "bank_transfer",
            reference: "DEMO commission settlement",
            memo: "DEMO employee commission settlement — simulated money",
          },
        );
    const fresh = await request("leads/" + buyer.id);
    await once("signed-lead-won-" + i, "leads/" + buyer.id + "/stage", {
      version: fresh.version,
      stage: "won",
      reason: "DEMO signed sale; simulated client presentation data",
    });
  }
}
console.log(
  "Demo contracts, earned commissions and actual-ledger settlements ready",
);
// Approved/posted/partially paid expenses and a pending expense for the live approval demo.
for (let i = 0; i < 7; i++) {
  const amount = [35000, 18000, 8500, 4200, 12000, 6500, 9500][i],
    date = at(-28 + i * 4),
    o = await once("expense-" + i, "accounting/obligations", {
      kind: "expense",
      partyId: supplier.id,
      date,
      dueDate: at(i - 5),
      description: [
        "Monthly office rent — Demo",
        "Digital marketing campaign — Demo",
        "Utilities and internet — Demo",
        "Office supplies — Demo",
        "CRM training workshop — Demo",
        "Listing photography — Demo",
        "Upcoming property exhibition — Demo",
      ][i],
      netMinor: minor(amount),
      accountId: account("operating_expense"),
      costCentreId: costCentres[i % 3].id,
    });
  if (i < 6) {
    await once(
      "expense-approve-" + i,
      "accounting/obligations/" + o.id + "/action",
      { version: 1, action: "approve" },
    );
    await once(
      "expense-post-" + i,
      "accounting/obligations/" + o.id + "/action",
      { version: 2, action: "post" },
    );
    if (i < 5)
      await once("expense-pay-" + i, "accounting/transactions", {
        kind: "payment",
        date: today,
        treasuryId: i % 2 ? cash.id : bank.id,
        obligationId: o.id,
        amountMinor: minor(i === 3 ? 2100 : amount),
        method: i % 2 ? "cash" : "bank_transfer",
        memo: "DEMO expense payment — simulated money",
      });
  }
}
const custody = await once("cash-custody", "accounting/custodies", {
  employeeId: employeeFor(sales[2]).id,
  amountMinor: minor(5000),
  purpose: "DEMO property exhibition expenses — simulated employee custody",
});
await once(
  "custody-approve",
  "accounting/custodies/" + custody.id + "/action",
  { version: 1, action: "approve", reason: "Approved client demo custody" },
);
await once("custody-payout", "accounting/custodies/" + custody.id + "/action", {
  version: 2,
  action: "payout",
  date: today,
  treasuryId: bank.id,
  reference: "DEMO custody payout",
});
await once(
  "custody-expense",
  "accounting/custodies/" + custody.id + "/action",
  {
    version: 3,
    action: "expense",
    date: today,
    accountId: account("operating_expense"),
    amountMinor: minor(1500),
    reason: "DEMO documented exhibition travel expenses",
    costCentreId: costCentres[2].id,
  },
);
await once("custody-return", "accounting/custodies/" + custody.id + "/action", {
  version: 4,
  action: "return",
  date: today,
  treasuryId: cash.id,
  amountMinor: minor(1000),
  reason: "DEMO unused custody cash returned",
});
await document(
  "custody-document",
  "accounting/files/custodies/" + custody.id,
  {},
);
await once("pending-custody", "accounting/custodies", {
  employeeId: employeeFor(sales[4]).id,
  amountMinor: minor(3500),
  purpose: "DEMO upcoming client viewing transport — pending approval",
});
const customer = await once("customer-party", "accounting/parties", {
  kind: "customer",
  name: names[8][0] + " — Demo",
  referenceId: buyers[8].id,
});
const plan = await once(
  "customer-installments",
  "accounting/installment-plans",
  {
    customerId: customer.id,
    developerId: developers[0].id,
    date: at(-40),
    firstDue: at(-30),
    totalMinor: minor(240000),
    installments: 6,
    intervalMonths: 1,
    collectionOwner: "company",
    description:
      "DEMO customer installments collected on behalf of developer — not brokerage income",
  },
);
await once(
  "customer-plan-approve",
  "accounting/installment-plans/" + plan.id + "/action",
  { version: 1, action: "approve" },
);
const planDocs = (await request("accounting/obligations?limit=100")).items
  .filter((x) => x.plan_id === plan.id)
  .sort((a, b) => a.due_date.localeCompare(b.due_date));
if (planDocs[0])
  await once("customer-installment-receipt", "accounting/transactions", {
    kind: "receipt",
    date: at(-10),
    treasuryId: bank.id,
    obligationId: planDocs[0].id,
    amountMinor: minor(20000),
    method: "bank_transfer",
    memo: "DEMO customer funds held for developer — simulated money",
  });
await once("collection-target", "accounting/collection-targets", {
  name: "Monthly developer commission collections — Demo",
  from: today.slice(0, 7) + "-01",
  to: new Date(
    Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0),
  )
    .toISOString()
    .slice(0, 10),
  amountMinor: minor(800000),
});
await once("incoming-cheque", "accounting/cheques", {
  number: "DEMO-CHQ-001",
  bank: "Demo issuing bank",
  kind: "incoming",
  treasuryId: bank.id,
  partyId: developers[0].id,
  counterAccountId: account("developer_funds"),
  amountMinor: minor(75000),
  dueDate: at(2),
  notes: "Demonstration cheque; not a real bank instrument",
});
// Salary profiles and active advances; prior month posted and current month awaiting final approval.
const previousMonth = new Date(
    Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1),
  )
    .toISOString()
    .slice(0, 7),
  priorPayDate = new Date(
    Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 0),
  )
    .toISOString()
    .slice(0, 10);
for (let i = 0; i < staff.length; i++)
  await once("salary-profile-" + staff[i].key, "accounting/salary-profiles", {
    employeeId: employeeFor(staff[i]).id,
    baseMinor: minor(
      staff[i].roles.includes("team_lead")
        ? 28000
        : staff[i].roles.includes("agent")
          ? 15000
          : staff[i].roles.includes("finance_manager")
            ? 32000
            : 18000,
    ),
    allowanceMinor: minor(1500 + (i % 3) * 500),
    deductionMinor: minor(i === 4 ? 250 : 0),
    deductionNote: i === 4 ? "DEMO approved recurring deduction" : "",
    advanceCapBps: 3000,
  });
const priorPayroll = await once("prior-payroll", "accounting/payroll-runs", {
  month: previousMonth,
  date: priorPayDate,
  employeeIds: staff.map(employeeFor).map((e) => e.id),
});
await once(
  "prior-payroll-submit",
  "accounting/payroll-runs/" + priorPayroll.id + "/action",
  { version: 1, action: "submit" },
);
await once(
  "prior-payroll-approve",
  "accounting/payroll-runs/" + priorPayroll.id + "/action",
  { version: 2, action: "approve" },
);
await once(
  "prior-payroll-post",
  "accounting/payroll-runs/" + priorPayroll.id + "/action",
  { version: 3, action: "post" },
);
for (const o of (
  await request("accounting/obligations?kind=salary_payable&limit=100")
).items)
  await once("prior-salary-pay-" + o.id, "accounting/transactions", {
    kind: "payment",
    date: priorPayDate,
    treasuryId: bank.id,
    obligationId: o.id,
    amountMinor: o.total_minor,
    method: "bank_transfer",
    memo: "DEMO monthly salary payment — simulated money",
  });
// Assets can be handed over in the presentation without SSH.
for (let i = 0; i < 8; i++) {
  const asset = await once("asset-" + i, "hr-resources/assets", {
    kind: ["laptop", "phone", "sim_card", "tablet"][i % 4],
    name:
      [
        "ThinkPad consultant laptop",
        "Company sales phone",
        "Business SIM card",
        "Property presentation tablet",
      ][i % 4] +
      " " +
      (i + 1),
    details: {
      brand: ["Lenovo", "Samsung", "Demo Telecom", "Apple"][i % 4],
      model: ["ThinkPad E14", "Galaxy A55", "Business voice/data", "iPad"][
        i % 4
      ],
      serial: "DEMO-ASSET-" + (i + 1),
      notes: "Demonstration asset; serials and service details are fictional",
      purchaseDate: at(-180),
    },
  });
  if (i < 7)
    await once(
      "asset-assign-" + i,
      "hr-resources/assets/" + asset.id + "/action",
      {
        version: 1,
        action: "assign",
        employeeId: employeeFor(i === 6 ? staff.at(-1) : staff[i + 2]).id,
        date: at(-60),
        condition: "Good condition — demo handover",
      },
    );
}
for (let i = 0; i < 6; i++)
  await document("hr-document-" + i, "hr/documents", {
    employeeId: employeeFor(staff[i]).id,
    title: "Employment agreement — DEMO nonbinding sample",
    kind: "contract",
    expiresDate: at(240 + i * 30),
  });
const schedule = await once("attendance-schedule", "attendance/schedules", {
  name: "Single office — Sunday to Thursday",
  workdays: [0, 1, 2, 3, 4],
  startMinute: 540,
  endMinute: 1020,
  graceMinutes: 15,
});
await once("attendance-assignment", "attendance/assignments", {
  scheduleId: schedule.id,
  scheduleVersion: 1,
  target: "all",
  effectiveFrom: today,
});
// Import only synthetic historical schedule snapshots into this isolated demo company.
// Normal user assignments remain current/future-only; no real employee schedule is altered.
if (!state.results["historical-demo-schedule"]) {
  const sql = `BEGIN;SELECT set_config('app.company_id','${cfg.id}',true);INSERT INTO tenant.attendance_assignments(company_id,employee_id,schedule_id,effective_from,policy,assigned_by) SELECT a.company_id,a.employee_id,a.schedule_id,'${at(-60)}'::date,a.policy,a.assigned_by FROM tenant.attendance_assignments a JOIN platform.companies c ON c.id=a.company_id WHERE a.company_id='${cfg.id}' AND c.slug='${cfg.slug}' AND a.effective_from='${today}'::date ON CONFLICT(company_id,employee_id,effective_from) DO NOTHING;INSERT INTO tenant.audit_logs(company_id,action,resource_type,resource_id,after) SELECT c.id,'demo.attendance_imported','company',c.id,'{"synthetic":true,"reason":"Imported historical demonstration schedule snapshots; not real attendance"}'::jsonb FROM platform.companies c WHERE c.id='${cfg.id}' AND c.slug='${cfg.slug}' AND NOT EXISTS(SELECT 1 FROM tenant.audit_logs l WHERE l.company_id=c.id AND l.action='demo.attendance_imported');COMMIT;`;
  const r = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "mujez-staging",
      "docker exec -i mujez-staging-postgres-1 psql -X -q -v ON_ERROR_STOP=1 -U mujez_owner -d mujez",
    ],
    { input: sql, encoding: "utf8", timeout: 30000 },
  );
  if (r.status !== 0)
    throw Error("Demo-only historical schedule import failed: " + r.stderr);
  state.results["historical-demo-schedule"] = { imported: true };
  await save();
}
// Two demo users submit actual correction requests; the owner reviews them through normal APIs.
const cookies = {};
for (let i = 0; i < 2; i++) {
  const user = sales[i];
  cookies[user.key] = await login(user.email);
  let generated = 0;
  for (let d = -1; d >= -10 && generated < 3; d--) {
    const day = at(d);
    if ([5, 6].includes(new Date(day + "T00:00:00Z").getUTCDay())) continue;
    const correction = await once(
      "attendance-" + user.key + "-" + day,
      "attendance/corrections",
      {
        workDate: day,
        checkIn: day + (i ? "T09:20" : "T08:55"),
        checkOut: day + "T17:10",
        reason: "DEMO attendance correction — simulated office attendance",
      },
      cookies[user.key],
    );
    await once(
      "attendance-approve-" + user.key + "-" + day,
      "attendance/corrections/" + correction.id + "/action",
      {
        version: 1,
        action: "approve",
        note: "Approved synthetic client demo attendance",
      },
    );
    generated++;
  }
}
for (let i = 0; i < 2; i++) {
  const user = sales[i];
  const adv = await once(
    "advance-" + user.key,
    "hr-resources/advances",
    {
      amountMinor: minor(12000 + i * 6000),
      mode: "monthly",
      installments: 3,
      firstDue: at(3 + i),
      reason: "DEMO personal advance request; simulated funds",
    },
    cookies[user.key],
  );
  await once(
    "advance-approve-" + user.key,
    "hr-resources/advances/" + adv.id + "/action",
    { version: 1, action: "approve" },
  );
  await once(
    "advance-payout-" + user.key,
    "hr-resources/advances/" + adv.id + "/action",
    {
      version: 2,
      action: "payout",
      date: today,
      reference: "DEMO simulated advance payout",
    },
  );
  await once(
    "advance-book-" + user.key,
    "accounting/hr-advances/" + adv.id + "/action",
    {
      version: 3,
      action: "book_payout",
      treasuryId: bank.id,
      reference: "DEMO simulated bank advance",
    },
  );
}
const advancesList = (await request("accounting/hr-advances")).items,
  advanceToOffset = advancesList.find(
    (x) => x.employee_id === employeeFor(sales[1]).id,
  );
const employeeParty = (await request("accounting/options")).parties.find(
  (x) => x.kind === "employee" && x.reference_id === sales[1].id,
);
const payable = (
  await request("accounting/obligations?kind=commission_payable&limit=100")
).items.find(
  (x) =>
    x.party_id === employeeParty?.id && BigInt(x.remainingMinor) >= 500000n,
);
if (advanceToOffset && payable)
  await once(
    "commission-advance-offset",
    "accounting/obligations/" + payable.id + "/settle-advance",
    {
      version: payable.version,
      action: "offset_advance",
      advanceId: advanceToOffset.id,
      advanceVersion: advanceToOffset.version,
      date: today,
      amountMinor: minor(5000),
      reason: "DEMO approved employee advance offset against earned commission",
    },
  );
// A historic statement is reconciled; current-day postings remain available for the live demo.
const bankLines = await request(
  "accounting/reconciliation-lines?treasuryId=" + bank.id + "&to=" + at(-5),
);
await once("bank-reconciliation", "accounting/reconciliations", {
  treasuryId: bank.id,
  date: at(-5),
  statementMinor: bankLines.bookBalanceMinor,
  lineIds: bankLines.items.map((x) => x.id),
  notes: "DEMO reconciled historical bank statement — no real bank connection",
});
const currentPayroll = await once(
  "current-payroll",
  "accounting/payroll-runs",
  {
    month: today.slice(0, 7),
    date: today,
    employeeIds: staff.map(employeeFor).map((e) => e.id),
  },
);
await once(
  "current-payroll-submit",
  "accounting/payroll-runs/" + currentPayroll.id + "/action",
  { version: 1, action: "submit" },
);
// Annual leave: one approved request, one awaiting the team lead, and one rejected example.
const leavePolicy = await request("leave/policy");
if (!leavePolicy.configured)
  await once("annual-leave-policy", "leave/policy", {
    version: leavePolicy.version,
    annualDays: 21,
    weekends: [5, 6],
    carryLimitDays: 5,
    carryExpiry: "03-31",
  });
const leadCookie = await login(leads[0].email),
  futureDays = [];
for (let d = 2; d < 20 && futureDays.length < 3; d++) {
  const date = at(d),
    weekday = new Date(date + "T00:00:00Z").getUTCDay();
  if (
    ![5, 6].includes(weekday) &&
    !(leavePolicy.holidays ?? []).some((h) => h.date === date)
  )
    futureDays.push(date);
}
for (let i = 0; i < 3; i++) {
  const leave = await once("leave-request-" + i, "leave/requests", {
    employeeId: employeeFor(sales[i]).id,
    startDate: futureDays[i],
    endDate: futureDays[i],
    reason: "DEMO planned personal leave — fictional request",
  });
  if (i === 0) {
    await once(
      "leave-manager-approve",
      "leave/requests/" + leave.id + "/action",
      {
        version: 1,
        action: "manager_approve",
        note: "Approved demonstration team leave",
      },
      leadCookie,
    );
    await once("leave-hr-approve", "leave/requests/" + leave.id + "/action", {
      version: 2,
      action: "hr_approve",
      note: "Approved demo annual leave",
    });
  }
  if (i === 2)
    await once("leave-reject", "leave/requests/" + leave.id + "/action", {
      version: 1,
      action: "reject",
      note: "DEMO rejection: requested coverage conflicts with the scheduled client exhibition",
    });
}
// An Employee-only account has visible self-service data for the demonstration.
const officeEmployee = staff.find(
    (u) => u.roles.length === 1 && u.roles[0] === "employee",
  ),
  officeEmployeeCookie = await login(officeEmployee.email);
await document("employee-self-document", "hr/documents", {
  employeeId: employeeFor(officeEmployee).id,
  title: "Employment agreement — DEMO nonbinding sample",
  kind: "contract",
  expiresDate: at(270),
});
await once(
  "employee-pending-advance",
  "hr-resources/advances",
  {
    amountMinor: minor(6000),
    mode: "lump_sum",
    installments: 1,
    firstDue: at(20),
    reason: "DEMO advance awaiting HR review",
  },
  officeEmployeeCookie,
);
await once(
  "employee-pending-leave",
  "leave/requests",
  {
    employeeId: employeeFor(officeEmployee).id,
    startDate: futureDays[0],
    endDate: futureDays[0],
    reason: "DEMO employee personal leave awaiting HR review",
  },
  officeEmployeeCookie,
);
// An explicit new-contract automation rule remains OFF until the presenter enables it.
await once("automation-rule", "accounting/automation-rules", {
  name: "Signed Garden Residence sales — Demo",
  contractType: "sale",
  crmProjectId: projects[0].id,
  agreementId: agreements[0].id,
  autoAdjust: true,
  createInstallments: false,
  active: false,
});
state.summary = {
  companyId: cfg.id,
  slug: cfg.slug,
  employees: staff.length,
  teams: 2,
  leads: buyers.length,
  contacts: 18,
  tasks: 34,
  events: 10,
  projects: 3,
  privateUnits: units.length,
  contracts: contracts.length,
  assets: 8,
  finance: "posted and reconciled demo records",
};
await save();
for (const kind of ["trial_balance", "balance_sheet", "cash_flow"]) {
  const r = await request("accounting/reports?kind=" + kind);
  if (r.summary.differenceMinor !== "0")
    throw Error(kind + " does not reconcile");
}
console.log(JSON.stringify({ completed: true, ...state.summary }));
