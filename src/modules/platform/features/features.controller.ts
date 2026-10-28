import { Controller, Get, Post, Param, Body, Req } from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { FeaturesService } from "./features.service.js";
import {
  FeatureChange,
  FeatureOverride,
  ReasonVersion,
  LimitOverride,
} from "./features.dto.js";
@Controller("admin/api/v1")
export class FeaturesController {
  constructor(private readonly service: FeaturesService) {}
  @RequireAccess(["platform"], "features") @Get("features") catalog() {
    return this.service.catalog();
  }
  @RequireAccess(["platform"], "features") @Post("features/:key/update") change(
    @Param("key") key: string,
    @Body() input: FeatureChange,
    @Req() req: AuthRequest,
  ) {
    return this.service.change(key, input, req.principal.id);
  }
  @RequireAccess(["platform"], "features") @Post("feature-overrides") override(
    @Body() input: FeatureOverride,
    @Req() req: AuthRequest,
  ) {
    return this.service.override(input, req.principal.id);
  }
  @RequireAccess(["platform"], "features")
  @Post("feature-overrides/:id/remove")
  remove(
    @Param("id") id: string,
    @Body() input: ReasonVersion,
    @Req() req: AuthRequest,
  ) {
    return this.service.remove(id, input, req.principal.id);
  }
  @RequireAccess(["platform"], "features")
  @Get("features/effective/:company")
  effective(@Param("company") id: string) {
    return this.service.effective(id);
  }
  @RequireAccess(["platform"], "usage") @Get("usage") usage() {
    return this.service.usage();
  }
  @RequireAccess(["platform"], "usage") @Post("usage/:id/override") limit(
    @Param("id") id: string,
    @Body() input: LimitOverride,
    @Req() req: AuthRequest,
  ) {
    return this.service.limit(id, input, req.principal.id);
  }
  @RequireAccess(["platform"], "usage") @Post("usage/:id/remove") removeLimit(
    @Param("id") id: string,
    @Body() input: LimitOverride,
    @Req() req: AuthRequest,
  ) {
    return this.service.removeLimit(id, input, req.principal.id);
  }
}
