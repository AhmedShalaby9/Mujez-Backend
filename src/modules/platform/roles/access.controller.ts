import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Param,
  Query,
  ParseUUIDPipe,
  DefaultValuePipe,
  ParseIntPipe,
  BadRequestException,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RequireAccess, Public } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { PlatformAccessService } from "./access.service.js";
import {
  InviteAdmin,
  AdminVersion,
  AssignRole,
  UserStatus,
  NewRole,
  PermissionChange,
  ActivateAdmin,
} from "./access.dto.js";
@RequireAccess(["platform"], "admins")
@Controller("admin/api/v1")
export class PlatformAccessController {
  constructor(private readonly service: PlatformAccessService) {}
  @Get("platform-users") users(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    if (page < 1 || page > 100000 || limit < 1 || limit > 100)
      throw new BadRequestException();
    return this.service.users(page, limit);
  }
  @Get("roles") roles() {
    return this.service.roles();
  }
  @Post("platform-users") invite(
    @Body() input: InviteAdmin,
    @Req() req: AuthRequest,
  ) {
    return this.service.invite(input, req.principal.id);
  }
  @Post("platform-users/:id/reissue") reissue(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: AdminVersion,
    @Req() req: AuthRequest,
  ) {
    return this.service.reissue(id, input, req.principal.id);
  }
  @Post("platform-users/:id/role") assign(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: AssignRole,
    @Req() req: AuthRequest,
  ) {
    return this.service.assign(id, input, req.principal.id);
  }
  @Post("platform-users/:id/status") status(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: UserStatus,
    @Req() req: AuthRequest,
  ) {
    return this.service.status(id, input, req.principal.id);
  }
  @Post("platform-users/:id/revoke") revoke(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: AdminVersion,
    @Req() req: AuthRequest,
  ) {
    return this.service.revoke(id, input, req.principal.id);
  }
  @Post("roles") create(@Body() input: NewRole, @Req() req: AuthRequest) {
    return this.service.newRole(input, req.principal.id);
  }
  @Post("roles/:key/permission") permission(
    @Param("key") key: string,
    @Body() input: PermissionChange,
    @Req() req: AuthRequest,
  ) {
    return this.service.permission(key, input, req.principal.id);
  }
  @Post("roles/:key/archive") archive(
    @Param("key") key: string,
    @Body() input: AdminVersion,
    @Req() req: AuthRequest,
  ) {
    return this.service.archive(key, input, req.principal.id);
  }
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post("auth/activate")
  activate(@Body() input: ActivateAdmin, @Req() req: AuthRequest) {
    return this.service.activate(input, req.ip ?? "unknown");
  }
}
