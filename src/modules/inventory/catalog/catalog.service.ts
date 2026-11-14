import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
import {
  kindSchema,
  itemSchema,
  querySchema,
  prefSchema,
  archiveSchema,
} from "./catalog.schema.js";
const PREF = `coalesce(p.followed,false) AS followed,coalesce(p.favorite,false) AS favorite,coalesce(p.muted,false) AS muted,coalesce(p.alerts,'{"units":true,"price":true,"launch":true,"news":false}'::jsonb) AS alerts`;
const dto = (r: any) => ({
  id: r.id,
  kind: r.kind,
  parentId: r.parent_id,
  name: r.name,
  status: r.status,
  priceMinor: r.price_minor,
  area: r.area,
  bedrooms: r.bedrooms,
  data: r.data,
  version: r.version,
  createdAt: r.created_at,
  followers: Number(r.followers ?? 0),
  children: Number(r.children ?? 0),
  available: Number(r.available ?? 0),
  fromPriceMinor: r.from_price ?? null,
  preference: {
    followed: r.followed ?? false,
    favorite: r.favorite ?? false,
    muted: r.muted ?? false,
    alerts: r.alerts ?? { units: true, price: true, launch: true, news: false },
  },
});
@Injectable()
export class CatalogService {
  constructor(private readonly db: DatabaseService) {}
  parse<T>(schema: { safeParse: (v: unknown) => any }, v: unknown): T {
    const p = schema.safeParse(v);
    if (!p.success)
      throw new BadRequestException(
        p.error.issues.map((i: any) => i.path.join(".") + ": " + i.message),
      );
    return p.data;
  }
  kind(v: string) {
    return this.parse<"developers" | "compounds" | "units">(kindSchema, v);
  }
  async access(p: Principal, kind: string) {
    if (p.pool === "platform") {
      if (!p.permissions.includes("co.view")) throw new ForbiddenException();
      return;
    }
    if (
      !p.companyId ||
      !p.permissions.includes(kind === "units" ? "units.read" : "projects.read")
    )
      throw new ForbiddenException();
    await this.db.platform(async (c) => {
      const r = await c.query(
        "SELECT 1 FROM platform.companies c JOIN platform.subscriptions s ON s.company_id=c.id WHERE c.id=$1 AND c.status='active' AND s.status='active' AND s.period_end>now() LIMIT 1",
        [p.companyId],
      );
      if (!r.rows.length)
        throw new ForbiddenException(
          "A current active subscription is required for catalog access",
        );
    });
  }
  async list(p: Principal, k: string, raw: unknown) {
    const kind = this.kind(k);
    await this.access(p, kind);
    const q = this.parse<ReturnType<typeof querySchema.parse>>(
      querySchema,
      raw,
    );
    return this.db.platform(async (c) => {
      const args: any[] = [p.id, p.pool, kind];
      const where = ["i.kind=$3", "i.archived_at IS NULL"];
      const add = (s: string, v: any) => {
        args.push(v);
        where.push(s.replace("?", "$" + args.length));
      };
      if (q.q)
        add(
          "strpos(lower(concat_ws(' ',i.name->>'en',i.name->>'ar',i.data->'location'->>'en',i.data->'location'->>'ar')),lower(?))>0",
          q.q,
        );
      if (q.parentId) add("i.parent_id=?", q.parentId);
      if (q.status) add("i.status=?", q.status);
      if (q.type) add("i.data->>'type'=?", q.type);
      if (q.listing) add("i.data->>'listing'=?", q.listing);
      if (q.bedrooms !== undefined) add("i.bedrooms=?", q.bedrooms);
      if (q.filter === "top" || q.filter === "verified")
        add("i.data->>?='true'", q.filter);
      if (q.filter === "favorites") where.push("p.favorite=true");
      if (q.filter === "following") where.push("p.followed=true");
      const from = `FROM platform.catalog_items i LEFT JOIN platform.catalog_preferences p ON p.item_id=i.id AND p.user_id=$1 AND p.pool=$2 WHERE ${where.join(" AND ")}`;
      const total = Number(
        (await c.query("SELECT count(*)::int AS n " + from, args)).rows[0].n,
      );
      const order = {
        new: "i.created_at DESC,i.id",
        name: "i.name->>'en',i.id",
        price_asc: "i.price_minor ASC NULLS LAST,i.id",
        price_desc: "i.price_minor DESC NULLS LAST,i.id",
        area: "i.area DESC NULLS LAST,i.id",
        followers: "followers DESC,i.id",
      }[q.sort];
      const rows = (
        await c.query(
          `SELECT i.*,i.price_minor::text,i.area::text,${PREF},(SELECT count(*) FROM platform.catalog_preferences f WHERE f.item_id=i.id AND f.followed) AS followers,(SELECT count(*) FROM platform.catalog_items ch WHERE ch.parent_id=i.id AND ch.archived_at IS NULL) AS children,(SELECT count(*) FROM platform.catalog_items ch WHERE ch.parent_id=i.id AND ch.archived_at IS NULL AND ch.status='available') AS available,(SELECT min(ch.price_minor)::text FROM platform.catalog_items ch WHERE ch.parent_id=i.id AND ch.archived_at IS NULL AND ch.status='available' AND (ch.data->>'listing') IS DISTINCT FROM 'rental') AS from_price ${from} ORDER BY ${order} LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
          [...args, q.limit, (q.page - 1) * q.limit],
        )
      ).rows;
      return { items: rows.map(dto), total, page: q.page, limit: q.limit };
    });
  }
  async detail(p: Principal, k: string, id: string) {
    const kind = this.kind(k);
    await this.access(p, kind);
    return this.db.platform(async (c) => {
      const r = (
        await c.query(
          `SELECT i.*,i.price_minor::text,i.area::text,${PREF},(SELECT count(*) FROM platform.catalog_preferences f WHERE f.item_id=i.id AND f.followed) AS followers,(SELECT count(*) FROM platform.catalog_items ch WHERE ch.parent_id=i.id AND ch.archived_at IS NULL) AS children,(SELECT count(*) FROM platform.catalog_items ch WHERE ch.parent_id=i.id AND ch.archived_at IS NULL AND ch.status='available') AS available,(SELECT min(ch.price_minor)::text FROM platform.catalog_items ch WHERE ch.parent_id=i.id AND ch.archived_at IS NULL AND ch.status='available' AND (ch.data->>'listing') IS DISTINCT FROM 'rental') AS from_price FROM platform.catalog_items i LEFT JOIN platform.catalog_preferences p ON p.item_id=i.id AND p.user_id=$1 AND p.pool=$2 WHERE i.id=$3 AND i.kind=$4 AND i.archived_at IS NULL`,
          [p.id, p.pool, id, kind],
        )
      ).rows[0];
      if (!r) throw new NotFoundException("Catalog record not found");
      const parent = r.parent_id
        ? (
            await c.query(
              "SELECT id,kind,name,parent_id FROM platform.catalog_items WHERE id=$1 AND archived_at IS NULL",
              [r.parent_id],
            )
          ).rows[0]
        : null;
      return {
        ...dto(r),
        parent: parent
          ? {
              id: parent.id,
              kind: parent.kind,
              name: parent.name,
              parentId: parent.parent_id,
            }
          : null,
      };
    });
  }
  async save(p: Principal, k: string, raw: unknown, id?: string) {
    const kind = this.kind(k);
    if (p.pool !== "platform" || !p.permissions.includes("co.create"))
      throw new ForbiddenException();
    const b = this.parse<ReturnType<typeof itemSchema.parse>>(itemSchema, raw);
    if (
      (kind === "developers" && b.parentId) ||
      (kind !== "developers" && !b.parentId)
    )
      throw new BadRequestException("Select a valid parent");
    if (
      kind === "units" &&
      ![
        "available",
        "hold",
        "reserved",
        "under_contract",
        "sold",
        "soon",
      ].includes(b.status)
    )
      throw new BadRequestException("Invalid unit status");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ kind, id, b }))
      .digest("hex");
    return this.db.platform(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        p.id + b.requestId,
      ]);
      const old = (
        await c.query(
          "SELECT * FROM platform.catalog_commands WHERE actor_id=$1 AND request_id=$2",
          [p.id, b.requestId],
        )
      ).rows[0];
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new ConflictException("Request ID already used");
        return old.result;
      }
      if (b.parentId) {
        const parent = (
          await c.query(
            "SELECT kind FROM platform.catalog_items WHERE id=$1 AND archived_at IS NULL FOR SHARE",
            [b.parentId],
          )
        ).rows[0];
        if (
          !parent ||
          parent.kind !== (kind === "compounds" ? "developers" : "compounds")
        )
          throw new BadRequestException("Invalid catalog parent");
      }
      const before = id
        ? (
            await c.query(
              "SELECT * FROM platform.catalog_items WHERE id=$1 AND kind=$2 AND archived_at IS NULL FOR UPDATE",
              [id, kind],
            )
          ).rows[0]
        : null;
      if (id && !before) throw new NotFoundException();
      if (id && before.version !== b.version)
        throw new ConflictException("Record changed. Refresh before saving.");
      const vals = [
        b.parentId ?? null,
        b.name,
        b.status,
        b.priceMinor ?? null,
        b.area ?? null,
        b.bedrooms ?? null,
        b.data,
      ];
      const r = (
        id
          ? await c.query(
              "UPDATE platform.catalog_items SET parent_id=$1,name=$2,status=$3,price_minor=$4,area=$5,bedrooms=$6,data=$7,version=version+1,updated_at=now() WHERE id=$8 RETURNING *,price_minor::text,area::text",
              [...vals, id],
            )
          : await c.query(
              "INSERT INTO platform.catalog_items(parent_id,name,status,price_minor,area,bedrooms,data,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *,price_minor::text,area::text",
              [...vals, kind],
            )
      ).rows[0];
      await recordPlatformEvent(c, {
        actorId: p.id,
        action: "catalog." + (id ? "updated" : "created"),
        resourceType: "catalog_" + kind,
        resourceId: r.id,
        before: before ?? undefined,
        after: r,
        payload: { kind, id: r.id },
      });
      const result = dto(r);
      await c.query(
        "INSERT INTO platform.catalog_commands(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4)",
        [p.id, b.requestId, fingerprint, result],
      );
      return result;
    });
  }
  async archive(p: Principal, k: string, id: string, raw: unknown) {
    const kind = this.kind(k);
    if (p.pool !== "platform" || !p.permissions.includes("co.create"))
      throw new ForbiddenException();
    const b = this.parse<ReturnType<typeof archiveSchema.parse>>(
      archiveSchema,
      raw,
    );
    return this.db.platform(async (c) => {
      const before = (
        await c.query(
          "SELECT * FROM platform.catalog_items WHERE id=$1 AND kind=$2 FOR UPDATE",
          [id, kind],
        )
      ).rows[0];
      if (!before) throw new NotFoundException();
      if (before.archived_at) return { id, archived: true };
      if (before.version !== b.version)
        throw new ConflictException(
          "Record changed. Refresh before archiving.",
        );
      if (
        (
          await c.query(
            "SELECT 1 FROM platform.catalog_items WHERE parent_id=$1 AND archived_at IS NULL LIMIT 1",
            [id],
          )
        ).rows.length
      )
        throw new ConflictException("Archive the child records first.");
      await c.query(
        "UPDATE platform.catalog_items SET archived_at=now(),version=version+1,updated_at=now() WHERE id=$1",
        [id],
      );
      await recordPlatformEvent(c, {
        actorId: p.id,
        action: "catalog.archived",
        resourceType: "catalog_" + kind,
        resourceId: id,
        before,
        payload: { kind, id },
      });
      return { id, archived: true };
    });
  }
  async preference(p: Principal, k: string, id: string, raw: unknown) {
    await this.detail(p, k, id);
    const b = this.parse<ReturnType<typeof prefSchema.parse>>(prefSchema, raw);
    return this.db.platform(async (c) => {
      await c.query(
        "INSERT INTO platform.catalog_preferences(user_id,pool,item_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [p.id, p.pool, id],
      );
      const r = (
        await c.query(
          "UPDATE platform.catalog_preferences SET followed=coalesce($4,followed),favorite=coalesce($5,favorite),muted=coalesce($6,muted),alerts=coalesce($7,alerts) WHERE user_id=$1 AND pool=$2 AND item_id=$3 RETURNING followed,favorite,muted,alerts",
          [
            p.id,
            p.pool,
            id,
            b.followed ?? null,
            b.favorite ?? null,
            b.muted ?? null,
            b.alerts ?? null,
          ],
        )
      ).rows[0];
      return r;
    });
  }
}
