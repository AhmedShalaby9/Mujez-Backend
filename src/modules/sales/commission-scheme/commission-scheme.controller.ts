import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { CommissionSchemeService } from "./commission-scheme.service.js";
import { CommissionSchemeInput } from "./commission-scheme.dto.js";

@RequireAccess(["company_admin", "company_user"], "commissions.read")
@Controller("api/v1/brokerage/commission-scheme")
export class CommissionSchemeController {
  constructor(private readonly service: CommissionSchemeService) {}
  @Get() get(@Req() r: AuthRequest) {
    return this.service.get(r.principal);
  }
  @Post()
  @RequireAccess(["company_admin"], "commissions.read")
  save(@Req() r: AuthRequest, @Body() b: CommissionSchemeInput) {
    return this.service.save(r.principal, b);
  }
}
