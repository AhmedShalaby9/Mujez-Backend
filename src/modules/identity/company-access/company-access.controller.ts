import { Controller, Get, Post, Param, Body, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public, RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { CompanyAccessService } from "./company-access.service.js";
import {
  OwnerInvite,
  OwnerRevoke,
  OwnerActivate,
} from "./company-access.dto.js";
@Controller("admin/api/v1/companies/:id/owner")
export class CompanyAccessController {
  constructor(private readonly service: CompanyAccessService) {}
  @Get() @RequireAccess(["platform"], "co.view") owner(
    @Param("id") id: string,
  ) {
    return this.service.owner(id);
  }
  @Post("invite") @RequireAccess(["platform"], "co.create") invite(
    @Param("id") id: string,
    @Body() input: OwnerInvite,
    @Req() req: AuthRequest,
  ) {
    return this.service.mutate(id, input, req.principal.id);
  }
  @Post("revoke") @RequireAccess(["platform"], "co.create") revoke(
    @Param("id") id: string,
    @Body() input: OwnerRevoke,
    @Req() req: AuthRequest,
  ) {
    return this.service.mutate(id, input, req.principal.id, true);
  }
}
@Controller("api/v1/auth")
export class OwnerActivationController {
  constructor(private readonly service: CompanyAccessService) {}
  @Post("activate")
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  activate(@Body() input: OwnerActivate, @Req() req: AuthRequest) {
    return this.service.activate(input, req.ip ?? "unknown");
  }
}
