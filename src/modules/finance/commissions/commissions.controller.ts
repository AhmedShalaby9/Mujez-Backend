import {
  Controller,
  Get,
  Post,
  Req,
  Body,
  Query,
  Param,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { CommissionsService } from "./commissions.service.js";
import {
  CommissionQuery,
  CommissionInput,
  CommissionUpdate,
  CommissionAction,
} from "./commissions.dto.js";
@RequireAccess(["company_admin"], "commissions.read")
@Controller("api/v1/commissions")
export class CommissionsController {
  constructor(private readonly s: CommissionsService) {}
  @Get() list(@Req() r: AuthRequest, @Query() q: CommissionQuery) {
    return this.s.list(r.principal, q);
  }
  @Get("options") options(@Req() r: AuthRequest) {
    return this.s.options(r.principal);
  }
  @Get(":id") detail(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.detail(r.principal, id);
  }
  @Post() @RequireAccess(["company_admin"], "commissions.manage") create(
    @Req() r: AuthRequest,
    @Body() b: CommissionInput,
  ) {
    return this.s.calculate(r.principal, b);
  }
  @Post(":id/recalculate")
  @RequireAccess(["company_admin"], "commissions.manage")
  recalculate(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: CommissionUpdate,
  ) {
    return this.s.calculate(r.principal, b, id);
  }
  @Post(":id/action")
  @RequireAccess(["company_admin"], "commissions.manage")
  action(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: CommissionAction,
  ) {
    return this.s.action(r.principal, id, b);
  }
}
