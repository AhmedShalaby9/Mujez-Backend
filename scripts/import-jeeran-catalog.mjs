import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { itemSchema } from "../dist/modules/inventory/catalog/catalog.schema.js";
import { recordPlatformEvent } from "../dist/infrastructure/outbox/domain-events.js";
const SOURCE = "jeeran";
export const digest = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex");
const clean = (v) =>
  typeof v === "string"
    ? v
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<\/(?:p|div|li)>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(
          /&(nbsp|amp|quot|apos|lt|gt);/g,
          (_, x) =>
            ({ nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" })[
              x
            ],
        )
        .trim()
    : "";
const bi = (en, ar) => {
  en = clean(en);
  ar = clean(ar);
  return en || ar
    ? { en: (en || ar).slice(0, 240), ar: (ar || en).slice(0, 240) }
    : undefined;
};
const url = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
};
const links = (v) =>
  [...new Set((Array.isArray(v) ? v : []).map(url).filter(Boolean))].slice(
    0,
    30,
  );
const integer = (v, min, max) =>
  v !== null &&
  v !== undefined &&
  v !== "" &&
  Number.isInteger(Number(v)) &&
  Number(v) >= min &&
  Number(v) <= max
    ? Number(v)
    : undefined;
const finite = (v, min, max) =>
  v !== null &&
  v !== undefined &&
  v !== "" &&
  Number.isFinite(Number(v)) &&
  Number(v) >= min &&
  Number(v) <= max
    ? Number(v)
    : undefined;
export function minor(v) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  if (!/^\d+(?:\.\d{1,2})?$/.test(s))
    throw Error("Invalid exact monetary amount");
  const [whole, fraction = ""] = s.split(".");
  const result = (
    BigInt(whole) * 100n +
    BigInt(fraction.padEnd(2, "0"))
  ).toString();
  if (result.length > 18) throw Error("Monetary amount exceeds catalog limit");
  return result;
}
function unique(rows, kind) {
  const map = new Map();
  let duplicates = 0;
  for (const r of rows) {
    if (r?.id === null || r?.id === undefined)
      throw Error(kind + ": missing source ID");
    const id = String(r.id),
      old = map.get(id);
    if (old) {
      if (digest(old) !== digest(r))
        throw Error(kind + ": conflicting duplicate source ID " + id);
      duplicates++;
    } else map.set(id, r);
  }
  return { map, duplicates };
}
const finishing = {
  fully_finished: ["Fully finished", "تشطيب كامل"],
  core_shell: ["Core and shell", "بدون تشطيب"],
  semi_finished: ["Semi finished", "نصف تشطيب"],
  furnished: ["Furnished", "مفروش"],
};
function plans(r) {
  const rows = r.payment_plans ?? [];
  const result = [];
  for (const [i, p] of rows.entries()) {
    const currency = { EGP: "EGP", Euro: "EUR", EUR: "EUR" }[p.currency];
    if (!currency) throw Error("Unknown payment currency for property " + r.id);
    const years = finite(p.years, 0, 30),
      down = finite(p.down_payment_percent, 0, 100);
    if (years === undefined || down === undefined)
      throw Error("Invalid payment plan for property " + r.id);
    const frequency = [
      "monthly",
      "quarterly",
      "annually",
      "semi-annually",
      "one-time",
    ].includes(p.frequency)
      ? p.frequency
      : "other";
    result.push({
      name: {
        en: p.is_cash ? "Cash" : `Plan ${i + 1}`,
        ar: p.is_cash ? "نقدًا" : `خطة ${i + 1}`,
      },
      years,
      downPercent: down,
      currency,
      frequency,
      isCash: !!p.is_cash,
      ...(p.unit_price != null ? { priceMinor: minor(p.unit_price) } : {}),
      ...(p.installment_amount != null
        ? { installmentMinor: minor(p.installment_amount) }
        : {}),
      ...(p.down_payment != null
        ? { downPaymentMinor: minor(p.down_payment) }
        : {}),
    });
  }
  if (!result.length) {
    const e = r.effective ?? {};
    const y = finite(r.installment_years ?? e.installment_years, 0, 30),
      down = finite(r.down_payment_percent ?? e.down_payment_percent, 0, 100);
    if (y !== undefined && down !== undefined)
      result.push({
        name: { en: "Payment plan", ar: "خطة السداد" },
        years: y,
        downPercent: down,
        currency: "EGP",
        frequency: "other",
      });
  }
  return result.slice(0, 20);
}
function metadata(r) {
  const d = {};
  const descEn = clean(r.desc_en ?? r.content_en),
    descAr = clean(r.desc_ar ?? r.content_ar);
  if (descEn || descAr)
    d.description = {
      en: (descEn || descAr).slice(0, 12000),
      ar: (descAr || descEn).slice(0, 12000),
    };
  for (const [target, k] of [
    ["logo", "logo"],
    ["cover", "cover_image"],
    ["website", "website"],
    ["brochure", "brochure_url"],
    ["masterPlan", "master_plan"],
    ["video", "video_url"],
  ]) {
    const value = url(r[k]);
    if (value) d[target] = value;
  }
  const phone = clean(r.phone);
  if (phone && /^[+0-9 ()-]{1,40}$/.test(phone)) d.phone = phone;
  const email = clean(r.email);
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) d.email = email;
  return d;
}
/** Pure mapping: no database mutation or trust in instructions embedded in source text. */
export function buildCatalog(input, files = {}) {
  for (const n of ["developers", "compounds", "properties"])
    if (input[n]?.success !== true || !Array.isArray(input[n]?.data))
      throw Error("Invalid " + n + " export envelope");
  const developers = unique(input.developers.data, "developers"),
    compounds = unique(input.compounds.data, "compounds"),
    units = unique(input.properties.data, "properties");
  if (input.projects) {
    const projects = unique(input.projects.data, "projects");
    if (projects.map.size !== compounds.map.size)
      throw Error("Projects and compounds do not match");
    for (const [id, p] of projects.map) {
      const c = compounds.map.get(id);
      if (
        !c ||
        p.developer_id !== c.developer_id ||
        p.name_en !== c.name_en ||
        p.name_ar !== c.name_ar
      )
        throw Error("Conflicting project/compound identity " + id);
    }
  }
  const records = [];
  const unavailableDev = new Set(),
    unavailableCompound = new Set();
  const add = (kind, r, parentExternalId, name, status, data, extra = {}) => {
    if (!name) throw Error(kind + ": missing name " + r.id);
    const { published = true, ...values } = extra;
    const base = {
      kind,
      externalId: String(r.id),
      parentExternalId:
        parentExternalId === null ? null : String(parentExternalId),
      name,
      status,
      priceMinor: null,
      area: null,
      bedrooms: null,
      data: {
        ...data,
        reference: {
          ...data.reference,
          source: SOURCE,
          externalId: String(r.id),
        },
      },
      published,
      ...values,
    };
    // Same validator used for catalog writes, with a fixed dummy request/parent UUID.
    itemSchema.parse({
      requestId: "a1000000-0000-4000-8000-000000000001",
      parentId:
        kind === "developers" ? null : "a1000000-0000-4000-8000-000000000002",
      name: base.name,
      status: base.status,
      priceMinor: base.priceMinor,
      area: base.area === null ? null : Number(base.area),
      bedrooms: base.bedrooms,
      data: base.data,
    });
    records.push({ ...base, sourceHash: digest(base) });
  };
  for (const [id, r] of developers.map) {
    if (!r.is_active) unavailableDev.add(id);
    const data = { ...metadata(r), top: !!r.is_top, verified: !!r.is_verified };
    const founded = integer(r.founded_year, 1800, 2200),
      delivered = integer(r.delivered_units, 0, 2147483647);
    if (founded !== undefined) data.founded = founded;
    if (delivered !== undefined) data.delivered = delivered;
    const address = bi(r.address, r.address);
    if (address) data.location = address;
    add("developers", r, null, bi(r.name_en, r.name_ar), "selling", data, {
      published: !!r.is_active,
    });
  }
  for (const [id, r] of compounds.map) {
    const parent = String(r.developer_id);
    if (!developers.map.has(parent))
      throw Error("Compound " + id + " has unknown developer " + parent);
    const published = !!r.is_active && !unavailableDev.has(parent);
    if (!published) unavailableCompound.add(id);
    const data = metadata(r);
    data.cover = url(r.main_image);
    data.photos = links(r.gallery);
    const location = bi(
      r.area?.name_en ?? r.additional_info?.location?.area_en,
      r.area?.name_ar,
    );
    if (location) data.location = location;
    const lat = finite(r.latitude, -90, 90),
      lng = finite(r.longitude, -180, 180);
    if (lat !== undefined && lng !== undefined)
      data.map = `https://www.google.com/maps?q=${lat},${lng}`;
    if (r.faqs?.length)
      data.faqs = r.faqs
        .map((f) => ({
          question: bi(f.question_en, f.question_ar),
          answer: bi(f.answer_en, f.answer_ar),
        }))
        .filter((f) => f.question && f.answer)
        .slice(0, 50);
    const asOf = clean(r.additional_info?.source?.scraped_at);
    data.reference = {
      ...(asOf ? { asOf } : {}),
      ...(url(r.additional_info?.source?.url)
        ? { sourceUrl: url(r.additional_info.source.url) }
        : {}),
    };
    add(
      "compounds",
      r,
      parent,
      bi(r.name_en, r.name_ar),
      {
        new_launch: "launch",
        resale_only: "resale",
        selling: "selling",
        offer: "offer",
        sold: "sold",
        soon: "soon",
      }[r.status] ?? "not_set",
      data,
      { published },
    );
  }
  const types = {
    apartment: "apt",
    shop: "retail",
    family_house: "family_house",
  };
  for (const [id, r] of units.map) {
    const parent = String(r.compound_id);
    if (!compounds.map.has(parent))
      throw Error("Unit " + id + " has unknown compound " + parent);
    const co = compounds.map.get(parent),
      data = metadata(r);
    const e = r.effective ?? {};
    data.type = types[r.property_type] ?? r.property_type;
    data.listing = r.property_status === "for_rent" ? "rental" : r.listing_type;
    data.photos = links(r.images);
    if (data.photos.length) data.cover = data.photos[0];
    data.floorPlan = url(r.floor_plan) ?? links(r.floor_plans)[0];
    const loc = bi(co.area?.name_en ?? r.source?.area, co.area?.name_ar);
    if (loc) data.location = loc;
    const bathrooms = integer(r.bathrooms, 0, 100);
    if (bathrooms !== undefined) data.bathrooms = bathrooms;
    const year = integer(
      String(r.delivery_date ?? e.delivery_date ?? "").slice(0, 4),
      1900,
      2200,
    );
    if (year !== undefined) data.deliveryYear = year;
    const f = finishing[r.finishing ?? e.finishing];
    if (f) data.finishing = bi(...f);
    const floor = clean(r.level_en);
    if (/^\d+$/.test(floor)) data.floor = integer(floor, -20, 300);
    if (r.level_en || r.level_ar) data.floorLabel = bi(r.level_en, r.level_ar);
    const paymentPlans = plans(r);
    if (paymentPlans.length) data.paymentPlans = paymentPlans;
    const amenities = e.amenities ?? r.source?.amenities ?? [];
    if (Array.isArray(amenities) && amenities.length)
      data.facilities = [
        ...new Set(amenities.filter((v) => typeof v === "string")),
      ]
        .map((v) => bi(v, v))
        .filter(Boolean)
        .slice(0, 100);
    const seller = clean(r.agent_name),
      phone = clean(r.agent_mobile ?? r.agent_whatsapp);
    if (seller && /^[+0-9 ()-]{1,40}$/.test(phone))
      data.seller = { name: seller.slice(0, 200), phone };
    data.reference = {
      code:
        clean(r.reference_code ?? r.legacy_code ?? "").slice(0, 200) ||
        undefined,
      asOf: clean(r.source?.scraped_at) || undefined,
      sourceUrl: url(r.source?.url),
      aiCover: !!r.cover_is_ai,
      originalType: r.property_type,
      isLaunch: !!r.is_launch,
      hasOffer: !!r.has_offer,
    };
    const area = finite(r.size, 0.01, 999999999999);
    if (area === undefined) throw Error("Invalid unit area " + id);
    add(
      "units",
      r,
      parent,
      bi(r.title_en, r.title_ar),
      r.sold_at ? "sold" : "available",
      data,
      {
        priceMinor: minor(r.price),
        area: Number(r.size).toFixed(2),
        bedrooms: integer(r.bedrooms, 0, 100) ?? null,
        published:
          !!r.is_active && !!r.is_approved && !unavailableCompound.has(parent),
      },
    );
  }
  const counts = Object.fromEntries(
    ["developers", "compounds", "units"].map((k) => [
      k,
      {
        total: records.filter((r) => r.kind === k).length,
        published: records.filter((r) => r.kind === k && r.published).length,
      },
    ]),
  );
  return {
    format: 1,
    source: SOURCE,
    manifest: {
      files,
      counts,
      unitDuplicateRows: units.duplicates,
      projectRowsAreCompoundAliases: input.projects?.data?.length ?? 0,
    },
    records,
  };
}
export async function loadExports(dir) {
  const input = {},
    files = {};
  for (const n of ["developers", "projects", "compounds", "properties"]) {
    const raw = await readFile(resolve(dir, n + ".json"), "utf8");
    files[n + ".json"] = digest(raw);
    input[n] = JSON.parse(raw);
  }
  return buildCatalog(input, files);
}
export async function importCatalog(
  c,
  bundle,
  { apply = false, actorId = null } = {},
) {
  if (bundle.format !== 1 || bundle.source !== SOURCE)
    throw Error("Unsupported import bundle");
  const result = {
    created: 0,
    updated: 0,
    unchanged: 0,
    unpublished: 0,
    counts: bundle.manifest.counts,
  };
  await c.query("BEGIN");
  try {
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('jeeran-catalog-import',0))",
    );
    const existing = (
      await c.query(
        "SELECT l.*,i.version,i.archived_at FROM platform.catalog_import_links l JOIN platform.catalog_items i ON i.id=l.item_id WHERE l.source=$1",
        [SOURCE],
      )
    ).rows;
    const maps = new Map(
      existing.map((r) => [r.kind + ":" + r.external_id, r]),
    );
    const ids = new Map(
      existing.map((r) => [r.kind + ":" + r.external_id, r.item_id]),
    );
    for (const r of bundle.records) {
      if (
        digest(
          Object.fromEntries(
            Object.entries(r).filter(([k]) => k !== "sourceHash"),
          ),
        ) !== r.sourceHash
      )
        throw Error("Import record checksum mismatch");
      const key = r.kind + ":" + r.externalId,
        old = maps.get(key);
      if (
        old &&
        old.source_hash !== r.sourceHash &&
        old.version !== old.imported_version
      )
        throw Error("Catalog was manually edited since import: " + key);
      if (old && old.source_hash === r.sourceHash) {
        result.unchanged++;
        continue;
      }
      const id = old?.item_id ?? randomUUID();
      ids.set(key, id);
      const parentKey =
        (r.kind === "units" ? "compounds" : "developers") +
        ":" +
        r.parentExternalId;
      const parent = r.parentExternalId === null ? null : ids.get(parentKey);
      if (r.kind !== "developers" && !parent)
        throw Error("Missing mapped catalog parent " + parentKey);
      if (!r.published) result.unpublished++;
      if (old) result.updated++;
      else result.created++;
      if (!apply) continue;
      const after = (
        await c.query(
          `INSERT INTO platform.catalog_items(id,kind,parent_id,name,status,price_minor,area,bedrooms,data,archived_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $10 THEN NULL ELSE now() END) ON CONFLICT(id) DO UPDATE SET parent_id=EXCLUDED.parent_id,name=EXCLUDED.name,status=EXCLUDED.status,price_minor=EXCLUDED.price_minor,area=EXCLUDED.area,bedrooms=EXCLUDED.bedrooms,data=EXCLUDED.data,archived_at=EXCLUDED.archived_at,version=platform.catalog_items.version+1,updated_at=now() RETURNING version`,
          [
            id,
            r.kind,
            parent,
            r.name,
            r.status,
            r.priceMinor,
            r.area,
            r.bedrooms,
            r.data,
            r.published,
          ],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO platform.catalog_import_links(source,kind,external_id,item_id,source_hash,imported_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source,kind,external_id) DO UPDATE SET source_hash=EXCLUDED.source_hash,imported_version=EXCLUDED.imported_version,imported_at=now()",
        [SOURCE, r.kind, r.externalId, id, r.sourceHash, after.version],
      );
    }
    if (apply) {
      const id = randomUUID();
      await c.query(
        "INSERT INTO platform.catalog_import_runs(id,source,manifest,result) VALUES($1,$2,$3,$4)",
        [id, SOURCE, bundle.manifest, result],
      );
      await recordPlatformEvent(c, {
        actorId,
        action: "catalog.imported",
        resourceType: "catalog_import",
        resourceId: id,
        after: result,
        payload: { source: SOURCE, ...result },
      });
    }
    await c.query(apply ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}
async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i < 0 ? null : args[i + 1];
  };
  let bundle;
  if (opt("--source-dir")) bundle = await loadExports(opt("--source-dir"));
  else if (opt("--bundle"))
    bundle = JSON.parse(await readFile(opt("--bundle"), "utf8"));
  else throw Error("Pass --source-dir or --bundle");
  if (opt("--normalize")) {
    await writeFile(opt("--normalize"), JSON.stringify(bundle), {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        normalized: opt("--normalize"),
        manifest: bundle.manifest,
      }),
    );
    return;
  }
  if (!process.env.PLATFORM_DATABASE_URL) {
    if (args.includes("--apply")) throw Error("PLATFORM_DATABASE_URL required");
    console.log(JSON.stringify({ dryRun: true, manifest: bundle.manifest }));
    return;
  }
  const c = new pg.Client({
    connectionString: process.env.PLATFORM_DATABASE_URL,
  });
  await c.connect();
  try {
    const role = (await c.query("SELECT current_user AS name")).rows[0].name;
    if (role !== "mujez_platform")
      throw Error("Use the restricted platform runtime database role");
    let actorId = null;
    if (opt("--actor-email")) {
      actorId = (
        await c.query(
          "SELECT u.id FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE lower(u.email)=lower($1) AND u.status='active' AND r.key='super_admin'",
          [opt("--actor-email")],
        )
      ).rows[0]?.id;
      if (!actorId) throw Error("Active super admin audit actor not found");
    }
    if (args.includes("--apply") && !actorId)
      throw Error("Pass --actor-email for the audit trail");
    console.log(
      JSON.stringify({
        dryRun: !args.includes("--apply"),
        ...(await importCatalog(c, bundle, {
          apply: args.includes("--apply"),
          actorId,
        })),
      }),
    );
  } finally {
    await c.end();
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
