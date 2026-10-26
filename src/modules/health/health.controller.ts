import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Public } from "../../common/auth/access.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { CacheService } from "../../infrastructure/cache/cache.module.js";
@ApiTags("Health")
@Public()
@Controller("health")
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly cache: CacheService,
  ) {}
  @Get("live")
  @ApiOperation({ summary: "Process liveness" })
  @ApiResponse({
    status: 200,
    schema: {
      type: "object",
      required: ["status"],
      properties: { status: { type: "string", enum: ["ok"] } },
    },
  })
  live() {
    return { status: "ok" };
  }
  @Get("ready")
  @ApiOperation({
    summary: "Restricted database connections and Redis readiness",
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: "object",
      required: ["status"],
      properties: { status: { type: "string", enum: ["ready"] } },
    },
  })
  @ApiResponse({
    status: 503,
    description: "Database or Redis unavailable; details are never exposed",
  })
  async ready() {
    const checks = await Promise.allSettled([
      this.db.ready(),
      this.cache.ready(),
    ]);
    if (checks.some((c) => c.status === "rejected"))
      throw new ServiceUnavailableException();
    return { status: "ready" };
  }
}
