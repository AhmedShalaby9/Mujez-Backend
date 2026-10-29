import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Param,
  Query,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { SalesService } from "../leads/sales.service.js";
import {
  SalesQuery,
  DealInput,
  DealUpdate,
  StageChange,
} from "../leads/leads.dto.js";
@RequireAccess(["company_admin"], "pipeline.read")
@Controller("api/v1/pipeline")
export class PipelineController {
  constructor(private readonly service: SalesService) {}
  @Get() list(@Req() req: AuthRequest, @Query() q: SalesQuery) {
    return this.service.pipeline(req.principal, q);
  }
  @Get("lead-options") options(
    @Req() req: AuthRequest,
    @Query() q: SalesQuery,
  ) {
    return this.service.leadOptions(req.principal, q);
  }
  @Post() @RequireAccess(["company_admin"], "pipeline.manage") create(
    @Req() req: AuthRequest,
    @Body() b: DealInput,
  ) {
    return this.service.createDeal(req.principal, b);
  }
  @Post(":id/update")
  @RequireAccess(["company_admin"], "pipeline.manage")
  update(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: DealUpdate,
  ) {
    return this.service.updateDeal(req.principal, id, b);
  }
  @Post(":id/stage") @RequireAccess(["company_admin"], "pipeline.manage") stage(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: StageChange,
  ) {
    return this.service.stage(req.principal, id, b, true);
  }
}
