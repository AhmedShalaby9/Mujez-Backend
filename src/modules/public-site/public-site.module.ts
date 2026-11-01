import {
  Module,
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  ParseUUIDPipe,
  BadRequestException,
  HttpCode,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public, RequireAccess } from "../../common/auth/access.js";
import type { AuthRequest } from "../../common/auth/access.guard.js";
import { PublicSiteService } from "./public-site.service.js";
import { DemoRequestInput, DemoRequestStatus } from "./public-site.dto.js";
@Controller("api/v1/public")
class PublicSiteController {
  constructor(private readonly s: PublicSiteService) {}
  @Get("site") @Public() site() {
    return this.s.site();
  }
  @Post("demo-requests")
  @Public()
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  request(@Body() b: DemoRequestInput) {
    return this.s.request(b);
  }
}
@Controller("admin/api/v1/demo-requests")
@RequireAccess(["platform"], "co.view")
class DemoRequestsController {
  constructor(private readonly s: PublicSiteService) {}
  @Get() list(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    if (page < 1 || page > 100000 || limit < 1 || limit > 100)
      throw new BadRequestException();
    return this.s.list(page, limit);
  }
  @Post(":id/status") @RequireAccess(["platform"], "co.create") update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: DemoRequestStatus,
    @Req() r: AuthRequest,
  ) {
    return this.s.update(id, b, r.principal.id);
  }
}
@Module({
  controllers: [PublicSiteController, DemoRequestsController],
  providers: [PublicSiteService],
})
export class PublicSiteModule {}
