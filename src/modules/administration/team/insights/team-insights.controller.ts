import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Body,
  Param,
  ParseUUIDPipe,
  BadRequestException,
} from "@nestjs/common";
import { RequireAccess } from "../../../../common/auth/access.js";
import type { AuthRequest } from "../../../../common/auth/access.guard.js";
import { TeamPerformanceQuery } from "../team-work.dto.js";
import { TeamInsightsService } from "./team-insights.service.js";
import { insightQuery } from "./team-insights.schema.js";
@Controller("api/v1/team/my-team/ai-insights")
@RequireAccess(["company_user"], "team.self.read")
export class TeamInsightsController {
  constructor(private readonly service: TeamInsightsService) {}
  @Get("snapshot") snapshot(
    @Req() r: AuthRequest,
    @Query() q: TeamPerformanceQuery,
  ) {
    return this.service.snapshot(r.principal, q.days);
  }
  @Get() latest(@Req() r: AuthRequest, @Query() q: Record<string, string>) {
    const b = insightQuery.safeParse({
      ...q,
      ...(q.days ? { days: Number(q.days) } : {}),
    });
    if (!b.success)
      throw new BadRequestException("Invalid analysis period or language");
    return this.service.latest(r.principal, b.data.days, b.data.language);
  }
  @Get(":id") get(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.get(r.principal, id);
  }
  @Post() start(@Req() r: AuthRequest, @Body() b: Record<string, unknown>) {
    return this.service.start(r.principal, b);
  }
}
