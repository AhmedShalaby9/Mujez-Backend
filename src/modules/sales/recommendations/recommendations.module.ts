import {
  Module,
  Controller,
  Get,
  Post,
  Req,
  Param,
  Body,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { SalesLeadsModule } from "../leads/leads.module.js";
import { CatalogModule } from "../../inventory/catalog/catalog.module.js";
import { KimiRecommendationGateway } from "./kimi-recommendation.gateway.js";
import { UnitRecommendationsService } from "./recommendations.service.js";
@Controller("api/v1/leads/:leadId/unit-recommendations")
@RequireAccess(["company_admin", "company_user"], "leads.read")
export class UnitRecommendationsController {
  constructor(private readonly service: UnitRecommendationsService) {}
  @Get() latest(
    @Req() r: AuthRequest,
    @Param("leadId", ParseUUIDPipe) id: string,
  ) {
    return this.service.latest(r.principal, id);
  }
  @Get("options") options(
    @Req() r: AuthRequest,
    @Param("leadId", ParseUUIDPipe) id: string,
  ) {
    return this.service.options(r.principal, id);
  }
  @Get(":runId") get(
    @Req() r: AuthRequest,
    @Param("leadId", ParseUUIDPipe) id: string,
    @Param("runId", ParseUUIDPipe) runId: string,
  ) {
    return this.service.latest(r.principal, id, runId);
  }
  @Post() start(
    @Req() r: AuthRequest,
    @Param("leadId", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.service.start(r.principal, id, b);
  }
}
@Module({
  imports: [SalesLeadsModule, CatalogModule],
  providers: [KimiRecommendationGateway, UnitRecommendationsService],
  controllers: [UnitRecommendationsController],
})
export class UnitRecommendationsModule {}
