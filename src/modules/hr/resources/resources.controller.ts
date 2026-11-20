import {
  Controller,
  Get,
  Post,
  Req,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { HrResourcesService } from "./resources.service.js";
@Controller("api/v1/hr-resources")
@RequireAccess(["company_admin", "company_user"])
export class HrResourcesController {
  constructor(private readonly s: HrResourcesService) {}
  @Get("context") context(@Req() r: AuthRequest) {
    return this.s.context(r.principal);
  }
  @Get("options") options(@Req() r: AuthRequest) {
    return this.s.options(r.principal);
  }
  @Get("assets") assets(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.assets(r.principal, q);
  }
  @Get("assets/:id") asset(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.assetDetail(r.principal, id);
  }
  @Post("assets") createAsset(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveAsset(r.principal, b);
  }
  @Post("assets/:id") saveAsset(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveAsset(r.principal, b, id);
  }
  @Post("assets/:id/action") actAsset(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.actAsset(r.principal, id, b);
  }
  @Get("advances") advances(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.advances(r.principal, q);
  }
  @Get("advances/:id") advance(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.advanceDetail(r.principal, id);
  }
  @Post("advances") request(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.requestAdvance(r.principal, b);
  }
  @Post("advances/:id/action") actAdvance(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.actAdvance(r.principal, id, b);
  }
}
