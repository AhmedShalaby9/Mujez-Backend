import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
import type { AnnouncementInput } from "./announcements.dto.js";
export function announcementStatus(
  a: {
    published: boolean;
    starts_at: Date | string | null;
    ends_at: Date | string | null;
  },
  now = Date.now(),
) {
  if (!a.published) return "draft";
  if (a.ends_at && new Date(a.ends_at).getTime() <= now) return "expired";
  if (a.starts_at && new Date(a.starts_at).getTime() > now) return "scheduled";
  return "published";
}
function map(a: any) {
  return {
    id: a.public_id,
    titleEn: a.title.en,
    titleAr: a.title.ar,
    bodyEn: a.body.en,
    bodyAr: a.body.ar,
    type: a.type,
    target: a.target,
    lang: a.language,
    from: a.starts_at ? new Date(a.starts_at).toISOString() : null,
    to: a.ends_at ? new Date(a.ends_at).toISOString() : null,
    status: announcementStatus(a),
    published: a.published,
    version: a.version,
  };
}
@Injectable()
export class AnnouncementsService {
  constructor(private readonly db: DatabaseService) {}
  async list(page = 1, limit = 100) {
    return this.db.platform(async (c) => ({
      items: (
        await c.query(
          "SELECT * FROM platform.announcements ORDER BY created_at DESC,id LIMIT $1 OFFSET $2",
          [limit, (page - 1) * limit],
        )
      ).rows.map(map),
      total: (
        await c.query(
          "SELECT count(*)::int AS total FROM platform.announcements",
        )
      ).rows[0].total,
    }));
  }
  async save(
    id: string | null,
    input: AnnouncementInput,
    actor: string,
    seedKey?: string,
  ) {
    const languages = input.lang === "both" ? ["en", "ar"] : [input.lang];
    for (const lang of languages) {
      if ((lang === "en" ? input.titleEn : input.titleAr).trim().length < 3)
        throw new BadRequestException(
          "A title is required in each selected language",
        );
      if (
        input.published &&
        !(lang === "en" ? input.bodyEn : input.bodyAr).trim()
      )
        throw new BadRequestException(
          "A body is required in each selected language before publishing",
        );
    }
    const from = input.from ? new Date(input.from) : null,
      to = input.to ? new Date(input.to) : null;
    if (
      (from && !Number.isFinite(from.getTime())) ||
      (to && !Number.isFinite(to.getTime())) ||
      (to && (!from || to <= from))
    )
      throw new BadRequestException("End must be after start");
    if (input.published && (!from || (to && to.getTime() <= Date.now())))
      throw new BadRequestException(
        "Publishing requires a start and an end in the future (or no end)",
      );
    return this.db.platform(async (c) => {
      if (
        input.target !== "all" &&
        !(
          await c.query(
            "SELECT 1 FROM platform.subscription_plans WHERE key=$1",
            [input.target],
          )
        ).rowCount
      )
        throw new BadRequestException("Target plan is not configured");
      let before: any = null;
      if (id) {
        before = (
          await c.query(
            "SELECT * FROM platform.announcements WHERE public_id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!before) throw new NotFoundException("Announcement not found");
        if (before.version !== input.version)
          throw new ConflictException("Announcement changed. Refresh first.");
      } else if (input.version !== 0)
        throw new BadRequestException(
          "New announcements start at version zero",
        );
      const values = [
        { en: input.titleEn, ar: input.titleAr },
        { en: input.bodyEn, ar: input.bodyAr },
        input.type,
        input.target,
        input.lang,
        input.published,
        from,
        to,
      ];
      const a = (
        id
          ? await c.query(
              "UPDATE platform.announcements SET title=$1,body=$2,type=$3,target=$4,language=$5,published=$6,starts_at=$7,ends_at=$8,version=version+1,updated_at=now() WHERE id=$9 RETURNING *",
              [...values, before.id],
            )
          : await c.query(
              "INSERT INTO platform.announcements(title,body,type,target,language,published,starts_at,ends_at,public_id,created_by,seed_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
              [
                ...values,
                "ANN-" + randomUUID().slice(0, 8).toUpperCase(),
                actor,
                seedKey ?? null,
              ],
            )
      ).rows[0];
      await recordPlatformEvent(c, {
        actorId: actor,
        action: id ? "announcement.updated" : "announcement.created",
        resourceType: "announcement",
        resourceId: a.id,
        before: before
          ? { published: before.published, version: before.version }
          : undefined,
        after: {
          title: a.title,
          target: a.target,
          published: a.published,
          startsAt: a.starts_at,
          endsAt: a.ends_at,
        },
        payload: { announcementId: a.public_id, published: a.published },
      });
      return map(a);
    });
  }
  async visible(companyId: string, lang: "en" | "ar") {
    return this.db.platform(async (c) => {
      const company = (
        await c.query(
          "SELECT c.id,c.status,s.plan_key FROM platform.companies c LEFT JOIN LATERAL (SELECT plan_key FROM platform.subscriptions WHERE company_id=c.id AND status IN ('active','trialing') AND period_end>now() ORDER BY created_at DESC,id LIMIT 1) s ON true WHERE c.id=$1",
          [companyId],
        )
      ).rows[0];
      if (
        !company ||
        !["active", "trial"].includes(company.status) ||
        !company.plan_key
      )
        return [];
      return (
        await c.query(
          "SELECT * FROM platform.announcements WHERE published AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now()) AND target IN ('all',$1) AND language IN ('both',$2) ORDER BY starts_at DESC,id",
          [company.plan_key, lang],
        )
      ).rows.map((a) => ({
        id: a.public_id,
        title: a.title[lang],
        body: a.body[lang],
        type: a.type,
        from: a.starts_at,
        to: a.ends_at,
      }));
    });
  }
}
