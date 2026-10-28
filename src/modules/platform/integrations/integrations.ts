import {
  Injectable,
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { IsBoolean, IsInt, Min, IsString, Length } from "class-validator";
import { Transform } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
export class IntegrationChange {
  @ApiProperty() @IsInt() @Min(0) declare version: number;
  @ApiProperty() @IsBoolean() declare enabled: boolean;
  @ApiProperty()
  @IsString()
  @Length(5, 500)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  declare reason: string;
}
@Injectable()
export class IntegrationsService {
  constructor(private readonly db: DatabaseService) {}
  async catalog() {
    return this.db.platform(async (c) => {
      const rows = (
        await c.query(
          "SELECT * FROM platform.integrations ORDER BY category,key",
        )
      ).rows;
      const events = (
        await c.query(
          "SELECT integration_key,enabled,reason,created_at FROM (SELECT *,row_number() OVER (PARTITION BY integration_key ORDER BY created_at DESC,id DESC) AS n FROM platform.integration_changes) e WHERE n<=20 ORDER BY created_at DESC",
        )
      ).rows;
      return rows.map((r) => ({
        key: r.key,
        nameEn: r.name.en,
        nameAr: r.name.ar,
        category: r.category,
        enabled: r.enabled,
        version: r.version,
        status: r.enabled ? "unconfigured" : "disabled",
        connectorReady: false,
        companies: 0,
        lastSync: null,
        errors24h: null,
        webhookUrl: null,
        credentialConfigured: false,
        log: events
          .filter((e) => e.integration_key === r.key)
          .map((e) => ({
            time: new Date(e.created_at).toISOString(),
            messageEn:
              (e.enabled ? "Requested enabled: " : "Disabled: ") + e.reason,
            messageAr: (e.enabled ? "طلب التفعيل: " : "إيقاف: ") + e.reason,
          })),
      }));
    });
  }
  async update(key: string, input: IntegrationChange, actor: string) {
    return this.db.platform(async (c) => {
      const before = (
        await c.query(
          "SELECT * FROM platform.integrations WHERE key=$1 FOR UPDATE",
          [key],
        )
      ).rows[0];
      if (!before) throw new NotFoundException("Integration not found");
      if (before.version !== input.version)
        throw new ConflictException("Integration changed. Refresh first.");
      await c.query(
        "UPDATE platform.integrations SET enabled=$2,version=version+1,updated_at=now() WHERE key=$1",
        [key, input.enabled],
      );
      await c.query(
        "INSERT INTO platform.integration_changes(integration_key,enabled,reason,actor_id) VALUES ($1,$2,$3,$4)",
        [key, input.enabled, input.reason, actor],
      );
      await recordPlatformEvent(c, {
        actorId: actor,
        action: "integration.settings_changed",
        resourceType: "integration",
        resourceId: before.id,
        before: { enabled: before.enabled },
        after: { key, enabled: input.enabled, reason: input.reason },
        payload: { key, enabled: input.enabled },
      });
      return { status: "saved", operational: false };
    });
  }
}
@Controller("admin/api/v1/integrations")
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}
  @Get() @RequireAccess(["platform"], "integrations") catalog() {
    return this.service.catalog();
  }
  @Post(":key/update") @RequireAccess(["platform"], "integrations") update(
    @Param("key") key: string,
    @Body() input: IntegrationChange,
    @Req() req: AuthRequest,
  ) {
    return this.service.update(key, input, req.principal.id);
  }
}
