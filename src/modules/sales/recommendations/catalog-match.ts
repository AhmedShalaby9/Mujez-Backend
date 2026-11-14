import type { PoolClient } from "pg";
import { locationKey, type Needs } from "./recommendations.schema.js";
const COMMERCIAL = ["office", "retail", "clinic"];
const RESIDENTIAL = [
  "apt",
  "villa",
  "chalet",
  "townhouse",
  "twinhouse",
  "studio",
  "duplex",
  "penthouse",
  "loft",
  "cabin",
  "family_house",
];
export async function catalogRevision(c: PoolClient) {
  return (
    await c.query(
      "SELECT extract(epoch FROM max(updated_at))::text AS stamp,count(*)::int AS total,coalesce(sum(version),0)::text AS versions FROM platform.catalog_items",
    )
  ).rows[0];
}
export async function catalogLocations(c: PoolClient) {
  return (
    await c.query(
      "SELECT DISTINCT data->'location'->>'en' AS en,data->'location'->>'ar' AS ar FROM platform.catalog_items WHERE kind='units' AND archived_at IS NULL AND data->>'listing'='primary' AND data->'location' IS NOT NULL ORDER BY en LIMIT 100",
    )
  ).rows;
}
export async function shortlist(
  c: PoolClient,
  needs: Needs,
  segment: string,
  budgetMinor: string | null,
) {
  const args: any[] = [segment === "com" ? COMMERCIAL : RESIDENTIAL];
  const where = [
    "u.kind='units'",
    "u.archived_at IS NULL",
    "c.archived_at IS NULL",
    "d.archived_at IS NULL",
    "c.kind='compounds'",
    "d.kind='developers'",
    "u.status='available'",
    "u.data->>'listing'='primary'",
    "u.price_minor IS NOT NULL",
    "u.data->>'type'=ANY($1::text[])",
  ];
  const add = (sql: string, v: any) => {
    args.push(v);
    where.push(sql.replace("?", "$" + args.length));
  };
  const ceiling =
    budgetMinor === null
      ? null
      : ((BigInt(budgetMinor) * 110n) / 100n).toString();
  if (ceiling !== null) add("u.price_minor<=?::bigint", ceiling);
  if (needs.types.length) add("u.data->>'type'=ANY(?::text[])", needs.types);
  if (needs.locations.length) {
    const sql =
      "regexp_replace(translate(lower(concat_ws(' ',u.data->'location'->>'en',u.data->'location'->>'ar',c.name->>'en',c.name->>'ar')),'أإآىة','ااايه'),'[[:space:][:punct:]ـًٌٍَُِّْ]','','g')";
    const terms = needs.locations.map((v) => {
      args.push(locationKey(v));
      return `strpos(${sql},$${args.length})>0`;
    });
    where.push("(" + terms.join(" OR ") + ")");
  }
  if (needs.minBedrooms !== null) add("u.bedrooms>=?", needs.minBedrooms);
  if (needs.maxBedrooms !== null) add("u.bedrooms<=?", needs.maxBedrooms);
  if (needs.minArea !== null) add("u.area>=?::numeric", needs.minArea);
  if (needs.maxArea !== null) add("u.area<=?::numeric", needs.maxArea);
  if (needs.maxDeliveryYear !== null)
    add("nullif(u.data->>'deliveryYear','')::int<=?", needs.maxDeliveryYear);
  const from = `FROM platform.catalog_items u JOIN platform.catalog_items c ON c.id=u.parent_id JOIN platform.catalog_items d ON d.id=c.parent_id WHERE ${where.join(" AND ")}`;
  const columns =
    "SELECT u.id,u.name,u.price_minor::text AS price_minor,u.area::text AS area,u.bedrooms,u.data->>'type' AS type,u.data->'location' AS location,u.data->>'deliveryYear' AS delivery_year,u.data->>'cover' AS cover,u.data->'reference' AS reference,u.data->'facilities' AS facilities,c.id AS compound_id,c.name AS compound_name,d.id AS developer_id,d.name AS developer_name ";
  const total = Number(
    (await c.query("SELECT count(*)::int AS n " + from, args)).rows[0].n,
  );
  let rows: any[];
  if (budgetMinor !== null) {
    const value = args.length + 1;
    const near = `abs(u.price_minor-$${value}::bigint),u.id`;
    const within = (
      await c.query(
        columns +
          from +
          ` AND u.price_minor<=$${value}::bigint ORDER BY ${near} LIMIT 30`,
        [...args, budgetMinor],
      )
    ).rows;
    const over = (
      await c.query(
        columns +
          from +
          ` AND u.price_minor>$${value}::bigint ORDER BY ${near} LIMIT 10`,
        [...args, budgetMinor],
      )
    ).rows;
    const valuePicks = (
      await c.query(
        columns +
          from +
          ` AND u.price_minor<=$${value}::bigint ORDER BY u.price_minor,u.id LIMIT 5`,
        [...args, budgetMinor],
      )
    ).rows;
    rows = [
      ...new Map(
        [
          ...within.slice(0, 15),
          ...over,
          ...valuePicks,
          ...within.slice(15),
        ].map((r) => [r.id, r]),
      ).values(),
    ].slice(0, 30);
  } else
    rows = (
      await c.query(
        columns + from + " ORDER BY u.price_minor,u.id LIMIT 30",
        args,
      )
    ).rows;
  return {
    total,
    ceilingMinor: ceiling,
    units: rows.map((r) => ({
      id: r.id,
      name: r.name,
      priceMinor: r.price_minor,
      currency: "EGP",
      area: r.area,
      bedrooms: r.bedrooms,
      type: r.type,
      location: r.location,
      deliveryYear: r.delivery_year === null ? null : Number(r.delivery_year),
      cover: r.cover ?? null,
      reference: {
        asOf: r.reference?.asOf ?? null,
        aiCover: r.reference?.aiCover ?? false,
      },
      facilities: r.facilities ?? [],
      compound: { id: r.compound_id, name: r.compound_name },
      developer: { id: r.developer_id, name: r.developer_name },
    })),
  };
}
const typeNames: Record<string, [string, string]> = {
  apt: ["Apartment", "شقة"],
  villa: ["Villa", "فيلا"],
  chalet: ["Chalet", "شاليه"],
  townhouse: ["Townhouse", "تاون هاوس"],
  twinhouse: ["Twin house", "توين هاوس"],
  studio: ["Studio", "استوديو"],
  duplex: ["Duplex", "دوبلكس"],
  penthouse: ["Penthouse", "بنتهاوس"],
  office: ["Office", "مكتب"],
  retail: ["Retail", "محل"],
  clinic: ["Clinic", "عيادة"],
  loft: ["Loft", "لوفت"],
  cabin: ["Cabin", "كابينة"],
  family_house: ["Family house", "منزل عائلي"],
};
const bi = (en: string, ar: string) => ({ en, ar });
function money(v: bigint) {
  return (
    "EGP " +
    (v / 100n).toLocaleString("en-US") +
    "." +
    String(v % 100n).padStart(2, "0")
  );
}
export function factReasons(
  unit: any,
  needs: Needs,
  budgetMinor: string | null,
) {
  const reasons: any[] = [],
    warnings: any[] = [];
  const type = typeNames[unit.type];
  if (type)
    reasons.push(bi("Property type: " + type[0], "نوع الوحدة: " + type[1]));
  if (unit.location?.en || unit.location?.ar)
    reasons.push(
      bi(
        "Location: " + (unit.location.en || unit.location.ar),
        "الموقع: " + (unit.location.ar || unit.location.en),
      ),
    );
  if (unit.bedrooms !== null)
    reasons.push(bi(`${unit.bedrooms} bedrooms`, `${unit.bedrooms} غرف نوم`));
  if (unit.area !== null)
    reasons.push(bi(`Area: ${unit.area} m²`, `المساحة: ${unit.area} م²`));
  let overBudgetMinor = "0";
  if (budgetMinor !== null) {
    const delta = BigInt(unit.priceMinor) - BigInt(budgetMinor);
    if (delta > 0n) {
      overBudgetMinor = delta.toString();
      const pc =
        BigInt(budgetMinor) > 0n
          ? (delta * 10000n + BigInt(budgetMinor) - 1n) / BigInt(budgetMinor)
          : 0n;
      const percent =
        String(pc / 100n) + "." + String(pc % 100n).padStart(2, "0");
      warnings.push(
        bi(
          `Above budget by ${money(delta)} (${percent}%).`,
          `أعلى من الميزانية بمقدار ${money(delta)} (${percent}٪).`,
        ),
      );
    } else
      reasons.unshift(
        bi("Within the saved lead budget.", "ضمن ميزانية العميل المحفوظة."),
      );
  } else
    warnings.push(
      bi(
        "Lead budget is not set; budget fit was not checked.",
        "ميزانية العميل غير محددة؛ لم تتم مطابقة السعر مع الميزانية.",
      ),
    );
  if (unit.deliveryYear === null)
    warnings.push(bi("Delivery year is not set.", "سنة التسليم غير محددة."));
  else
    reasons.push(
      bi(
        "Delivery year: " + unit.deliveryYear,
        "سنة التسليم: " + unit.deliveryYear,
      ),
    );
  return { reasons, warnings, overBudgetMinor };
}
