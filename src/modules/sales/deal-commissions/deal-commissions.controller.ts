import { Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { DealCommissionsService } from "./deal-commissions.service.js";
import {
  DealCommissionInput,
  DealCommissionQuery,
} from "./deal-commissions.dto.js";

@RequireAccess(["company_admin", "company_user"], "leads.read")
@Controller("api/v1/brokerage/commissions")
export class DealCommissionsController {
  constructor(private readonly service: DealCommissionsService) {}
  @Get("options") options(@Req() r: AuthRequest) {
    return this.service.options(r.principal);
  }
  @Get() list(@Req() r: AuthRequest, @Query() q: DealCommissionQuery) {
    return this.service.list(r.principal, q);
  }
  @Post()
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  create(@Req() r: AuthRequest, @Body() b: DealCommissionInput) {
    return this.service.create(r.principal, b);
  }
}
