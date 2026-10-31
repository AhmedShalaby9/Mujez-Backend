import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public, RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { TeamService } from "./team.service.js";
import { TeamInvite, TeamStatus, TeamActivate } from "./team.dto.js";
@Controller("api/v1/team")
export class TeamController {
  constructor(private readonly service: TeamService) {}
  @Get() @RequireAccess(["company_admin"]) list(@Req() req: AuthRequest) {
    return this.service.list(req.principal);
  }
  @Post("invite") @RequireAccess(["company_admin"]) invite(
    @Body() input: TeamInvite,
    @Req() req: AuthRequest,
  ) {
    return this.service.invite(req.principal, input);
  }
  @Post(":id/resend") @RequireAccess(["company_admin"]) resend(
    @Param("id") id: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.resend(req.principal, id);
  }
  @Post(":id/revoke") @RequireAccess(["company_admin"]) revoke(
    @Param("id") id: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.revoke(req.principal, id);
  }
  @Post(":id/status") @RequireAccess(["company_admin"]) status(
    @Param("id") id: string,
    @Body() input: TeamStatus,
    @Req() req: AuthRequest,
  ) {
    return this.service.status(req.principal, id, input);
  }
}
@Controller("api/v1/team")
export class TeamActivationController {
  constructor(private readonly service: TeamService) {}
  @Post("activate")
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  activate(@Body() input: TeamActivate) {
    return this.service.activate(input);
  }
}
