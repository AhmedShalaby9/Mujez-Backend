import {
  Controller,
  Get,
  Post,
  Req,
  Body,
  Param,
  Query,
  BadRequestException,
  ParseUUIDPipe,
} from "@nestjs/common";
import { IsUUID, IsArray, ArrayMaxSize, IsObject } from "class-validator";
import { RequireAccess } from "../../../common/auth/access.js";
import type { Principal } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
class NotificationPreferences {
  @IsObject() value!: Record<string, boolean>;
}
class ReadNotifications {
  @IsArray() @ArrayMaxSize(100) @IsUUID("4", { each: true }) ids!: string[];
}
@RequireAccess(["platform", "company_admin", "company_user"])
@Controller(["admin/api/v1/notifications", "api/v1/notifications"])
export class NotificationsController {
  constructor(private readonly db: DatabaseService) {}
  private query<T>(
    p: Principal,
    work: (c: any, table: string, filter: string, args: any[]) => Promise<T>,
  ) {
    if (p.pool === "platform")
      return this.db.platform((c) =>
        work(
          c,
          "platform.notifications",
          "user_id=$1 AND required_permission=ANY($2::text[])",
          [p.id, p.permissions],
        ),
      );
    if (!p.companyId) throw new BadRequestException();
    return this.db.tenant(p.companyId, (c) =>
      work(
        c,
        "tenant.notifications",
        "company_id=$1 AND user_id=$2 AND required_permission=ANY($3::text[])",
        [p.companyId, p.id, p.permissions],
      ),
    );
  }
  private principal(req: AuthRequest) {
    if (req.path.startsWith("/admin/") && req.principal.pool !== "platform")
      throw new BadRequestException();
    return req.principal;
  }
  @Get() list(@Req() req: AuthRequest, @Query("page") raw = "1") {
    const page = Number(raw);
    if (!Number.isInteger(page) || page < 1 || page > 100000)
      throw new BadRequestException();
    return this.query(this.principal(req), async (c, t, w, args) => ({
      items: (
        await c.query(
          `SELECT id,kind,title,route,created_at AS "createdAt",read_at AS "readAt" FROM ${t} WHERE ${w} ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET $${args.length + 1}`,
          [...args, (page - 1) * 50],
        )
      ).rows,
      ...(
        await c.query(
          `SELECT count(*)::int AS total,count(*) FILTER(WHERE read_at IS NULL)::int AS unread FROM ${t} WHERE ${w}`,
          args,
        )
      ).rows[0],
      page,
      limit: 50,
    }));
  }
  @Post(":id/unread") unread(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.query(this.principal(req), async (c, t, w, args) => {
      await c.query(
        `UPDATE ${t} SET read_at=NULL WHERE ${w} AND id=$${args.length + 1}`,
        [...args, id],
      );
      return { status: "unread" };
    });
  }
  @Post("read-all") all(@Req() req: AuthRequest) {
    return this.query(this.principal(req), async (c, t, w, args) => {
      await c.query(
        `UPDATE ${t} SET read_at=coalesce(read_at,now()) WHERE ${w}`,
        args,
      );
      return { status: "read" };
    });
  }
  @Post("read") some(@Req() req: AuthRequest, @Body() b: ReadNotifications) {
    return this.query(this.principal(req), async (c, t, w, args) => {
      await c.query(
        `UPDATE ${t} SET read_at=coalesce(read_at,now()) WHERE ${w} AND id=ANY($${args.length + 1}::uuid[])`,
        [...args, b.ids],
      );
      return { status: "read" };
    });
  }
  @Post(":id/read") read(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.some(req, { ids: [id] });
  }
}

@RequireAccess(["platform"])
@Controller("admin/api/v1/me/notification-preferences")
export class NotificationPreferencesController {
  constructor(private readonly db: DatabaseService) {}
  @Get() get(@Req() req: AuthRequest) {
    return this.db.platform(async (c) => ({
      value:
        (
          await c.query(
            "SELECT value FROM platform.notification_preferences WHERE user_id=$1",
            [req.principal.id],
          )
        ).rows[0]?.value ?? {},
      capabilities: { app: true, email: false, sms: false },
    }));
  }
  @Post() save(@Req() req: AuthRequest, @Body() b: NotificationPreferences) {
    const categories = [
      "pay",
      "newco",
      "trial",
      "ticket",
      "limit",
      "incident",
      "expiry",
      "announcement",
    ];
    for (const [key, v] of Object.entries(b.value))
      if (
        typeof v !== "boolean" ||
        !categories.some(
          (k) =>
            key === k + ":app" || key === k + ":email" || key === k + ":sms",
        ) ||
        ((key.endsWith(":email") || key.endsWith(":sms")) && v)
      )
        throw new BadRequestException(
          "Only in-app notification delivery is enabled",
        );
    return this.db.platform(async (c) => {
      await c.query(
        "INSERT INTO platform.notification_preferences(user_id,value) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value,updated_at=now()",
        [req.principal.id, b.value],
      );
      return { value: b.value };
    });
  }
}
