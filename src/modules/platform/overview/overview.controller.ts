import { Controller, Get, Query, Req } from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { OverviewService } from "./overview.service.js";
import { OverviewQuery } from "./overview.dto.js";
@RequireAccess(["platform"])
@Controller("admin/api/v1/overview")
export class OverviewController {
  constructor(private readonly service: OverviewService) {}
  @Get() snapshot(@Query() input: OverviewQuery, @Req() req: AuthRequest) {
    return this.service.snapshot(input, req.principal.permissions);
  }
  @Get("alerts") alerts(@Req() req: AuthRequest) {
    return this.service.alerts(req.principal.permissions);
  }
}
