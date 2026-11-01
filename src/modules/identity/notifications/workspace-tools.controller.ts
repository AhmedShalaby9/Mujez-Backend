import {
  Controller,
  Get,
  Post,
  Req,
  Body,
  Param,
  Query,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  ParseUUIDPipe,
} from "@nestjs/common";
import { IsString, Length, IsObject, IsInt, Min } from "class-validator";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
class SavedViewInput {
  @IsString() @Length(2, 80) name!: string;
  @IsObject() filters!: Record<string, string>;
}
class ViewVersion {
  @IsInt() @Min(0) version!: number;
}
@RequireAccess(["company_admin", "company_user"])
@Controller("api/v1")
export class WorkspaceToolsController {
  constructor(private readonly db: DatabaseService) {}
  private async principal(req: AuthRequest) {
    const p = req.principal;
    if (!p.companyId) throw new ForbiddenException();
    const row = await this.db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT 1 FROM platform.companies c WHERE c.id=$1 AND c.status IN ('trial','active') AND EXISTS(SELECT 1 FROM platform.subscriptions s WHERE s.company_id=c.id AND s.status IN ('active','trialing') AND s.period_end>now())",
            [p.companyId],
          )
        ).rowCount,
    );
    if (!row)
      throw new ForbiddenException("A current subscription is required");
    return p;
  }
  @Get("search") async search(@Req() req: AuthRequest, @Query("q") raw = "") {
    const p = await this.principal(req),
      q = raw.trim();
    if (q.length < 2 || q.length > 100)
      throw new BadRequestException("Search must be 2–100 characters");
    return this.db.tenant(p.companyId!, async (c) => {
      const items: any[] = [];
      const pattern = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
      for (const [table, permission, name, owner, route, key] of [
        [
          "leads",
          "leads.read",
          "name->>'en'",
          "owner_user_id",
          "/company/leads",
          "leadId",
        ],
        [
          "contacts",
          "contacts.read",
          "name->>'en'",
          "owner_user_id",
          "/company/contacts",
          "contactId",
        ],
        ["units", "units.read", "code", null, "/company/units", "unitId"],
        [
          "contracts",
          "contracts.read",
          "title->>'en'",
          "owner_id",
          "/company/contracts",
          "contractId",
        ],
      ] as const) {
        if (!p.permissions.includes(permission)) continue;
        const rows = (
          await c.query(
            `SELECT id,${name} AS name FROM tenant.${table} WHERE company_id=$1 AND ${table === "contracts" ? "status<>'void'" : "archived_at IS NULL"} AND ${name} ILIKE $2${p.scope === "own" && owner ? " AND " + owner + "=$3" : ""} ORDER BY updated_at DESC,id LIMIT 10`,
            p.scope === "own" && owner
              ? [p.companyId, pattern, p.id]
              : [p.companyId, pattern],
          )
        ).rows;
        items.push(
          ...rows.map((r) => ({
            id: r.id,
            type: table,
            name: r.name,
            route: route + "?" + key + "=" + r.id,
          })),
        );
      }
      return { items };
    });
  }
  @Get("navigation-counts") async counts(@Req() req: AuthRequest) {
    const p = await this.principal(req);
    return this.db.tenant(p.companyId!, async (c) => {
      const counts: Record<string, number> = {};
      for (const [table, permission, owner] of [
        ["leads", "leads.read", "owner_user_id"],
        ["contacts", "contacts.read", "owner_user_id"],
        ["tasks", "tasks.read", "assignee_id"],
        ["units", "units.read", null],
        ["contracts", "contracts.read", "owner_id"],
      ] as const) {
        if (!p.permissions.includes(permission)) continue;
        const archived =
          table === "tasks"
            ? "status='open'"
            : table === "contracts"
              ? "status<>'void'"
              : "archived_at IS NULL";
        const args =
          p.scope === "own" && owner ? [p.companyId, p.id] : [p.companyId];
        counts[table] = (
          await c.query(
            `SELECT count(*)::int AS n FROM tenant.${table} WHERE company_id=$1 AND ${archived}${p.scope === "own" && owner ? " AND " + owner + "=$2" : ""}`,
            args,
          )
        ).rows[0].n;
      }
      return counts;
    });
  }
  @Get("saved-views") async views(@Req() req: AuthRequest) {
    const p = await this.principal(req);
    if (!p.permissions.includes("leads.read")) return { items: [] };
    return this.db.tenant(p.companyId!, async (c) => ({
      items: (
        await c.query(
          "SELECT id,name,resource,filters,version FROM tenant.saved_views WHERE company_id=$1 AND user_id=$2 AND deleted_at IS NULL ORDER BY name,id LIMIT 100",
          [p.companyId, p.id],
        )
      ).rows,
    }));
  }
  @Post("saved-views") async save(
    @Req() req: AuthRequest,
    @Body() b: SavedViewInput,
  ) {
    const p = await this.principal(req);
    if (!p.permissions.includes("leads.read") || p.workspace)
      throw new ForbiddenException();
    for (const [key, value] of Object.entries(b.filters))
      if (
        ![
          "q",
          "stage",
          "segment",
          "ownerId",
          "budgetMinMinor",
          "budgetMaxMinor",
        ].includes(key) ||
        typeof value !== "string" ||
        value.length > 100
      )
        throw new BadRequestException("Invalid saved filter");
    return this.db.tenant(p.companyId!, async (c) => {
      if (
        (
          await c.query(
            "SELECT 1 FROM tenant.saved_views WHERE company_id=$1 AND user_id=$2 AND deleted_at IS NULL AND name=$3",
            [p.companyId, p.id, b.name],
          )
        ).rowCount
      )
        throw new ConflictException("A view with this name exists");
      const row = (
        await c.query(
          "INSERT INTO tenant.saved_views(company_id,user_id,name,filters) VALUES($1,$2,$3,$4) RETURNING id,name,filters,version",
          [p.companyId, p.id, b.name, b.filters],
        )
      ).rows[0];
      await recordTenantEvent(c, {
        companyId: p.companyId!,
        actorId: p.id,
        action: "saved_view.created",
        resourceType: "saved_view",
        resourceId: row.id,
        after: { name: b.name },
        payload: {},
      });
      return row;
    });
  }
  @Post("saved-views/:id/delete") async remove(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: ViewVersion,
  ) {
    const p = await this.principal(req);
    return this.db.tenant(p.companyId!, async (c) => {
      const row = (
        await c.query(
          "UPDATE tenant.saved_views SET deleted_at=now(),version=version+1,updated_at=now() WHERE company_id=$1 AND user_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL RETURNING id",
          [p.companyId, p.id, id, b.version],
        )
      ).rows[0];
      if (!row)
        throw new ConflictException("Saved view changed or unavailable");
      await recordTenantEvent(c, {
        companyId: p.companyId!,
        actorId: p.id,
        action: "saved_view.deleted",
        resourceType: "saved_view",
        resourceId: id,
        after: { deleted: true },
        payload: {},
      });
      return { status: "deleted" };
    });
  }
}
