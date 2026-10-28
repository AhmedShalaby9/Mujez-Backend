import { Controller, Get, Req } from "@nestjs/common";
import { ApiCookieAuth, ApiResponse, ApiTags } from "@nestjs/swagger";
import { RequireAccess } from "../../common/auth/access.js";
import {
  ProfileDto,
  PermissionsDto,
  TenantPermissionsDto,
} from "./identity.dto.js";
import type { AuthRequest } from "../../common/auth/access.guard.js";
@ApiTags("Tenant identity")
@ApiCookieAuth("tenant")
@ApiResponse({
  status: 401,
  description: "Missing or invalid tenant access token",
})
@ApiResponse({ status: 403, description: "Company or access is unavailable" })
@RequireAccess(["company_admin", "company_user"])
@Controller("api/v1/me")
export class TenantMeController {
  @Get()
  @ApiResponse({ status: 200, type: ProfileDto })
  me(@Req() req: AuthRequest) {
    const { subject: _, permissions: __, ...profile } = req.principal;
    return profile;
  }
  @Get("permissions")
  @ApiResponse({ status: 200, type: TenantPermissionsDto })
  permissions(@Req() req: AuthRequest) {
    const { permissions, scope, teamId } = req.principal;
    return { permissions, scope, teamId: teamId ?? null };
  }
}
@ApiTags("Platform identity")
@ApiCookieAuth("platform")
@ApiResponse({
  status: 401,
  description: "Missing or invalid platform access token",
})
@ApiResponse({ status: 403, description: "MFA or IP policy denied access" })
@RequireAccess(["platform"])
@Controller("admin/api/v1/me")
export class PlatformMeController {
  @Get()
  @ApiResponse({ status: 200, type: ProfileDto })
  me(@Req() req: AuthRequest) {
    const { subject: _, permissions: __, ...profile } = req.principal;
    return profile;
  }
  @Get("permissions")
  @ApiResponse({ status: 200, type: PermissionsDto })
  permissions(@Req() req: AuthRequest) {
    return { permissions: req.principal.permissions };
  }
}
