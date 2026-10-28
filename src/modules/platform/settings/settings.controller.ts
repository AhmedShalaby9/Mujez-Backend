import { Controller, Get, Post, Body, Req } from "@nestjs/common";
import { RequireAccess, Public } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { SettingsService } from "./settings.service.js";
import { SettingsChange } from "./settings.dto.js";
@Controller("admin/api/v1")
export class SettingsController {
  constructor(private readonly service: SettingsService) {}
  @Get("settings") @RequireAccess(["platform"], "settings") read() {
    return this.service.read();
  }
  @Post("settings") @RequireAccess(["platform"], "settings") save(
    @Body() input: SettingsChange,
    @Req() req: AuthRequest,
  ) {
    return this.service.save(input, req.principal.id);
  }
  @Get("platform-defaults") @RequireAccess(["platform"]) defaults() {
    return this.service.defaults();
  }
  @Get("branding") @Public() branding() {
    return this.service.branding();
  }
}
