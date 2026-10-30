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
import { MarketingService } from "./marketing.service.js";
import {
  CampaignQuery,
  CampaignInput,
  CampaignUpdate,
  CampaignArchive,
} from "./marketing.dto.js";
@RequireAccess(["company_admin"], "marketing.read")
@Controller("api/v1/marketing")
export class MarketingController {
  constructor(private readonly s: MarketingService) {}
  @Get() list(@Req() r: AuthRequest, @Query() q: CampaignQuery) {
    return this.s.list(r.principal, q);
  }
  @Get(":id") detail(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.detail(r.principal, id);
  }
  @Post() @RequireAccess(["company_admin"], "marketing.manage") create(
    @Req() r: AuthRequest,
    @Body() b: CampaignInput,
  ) {
    return this.s.save(r.principal, b);
  }
  @Post(":id/update")
  @RequireAccess(["company_admin"], "marketing.manage")
  update(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: CampaignUpdate,
  ) {
    return this.s.save(r.principal, b, id);
  }
  @Post(":id/archive")
  @RequireAccess(["company_admin"], "marketing.manage")
  archive(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: CampaignArchive,
  ) {
    return this.s.archive(r.principal, id, b);
  }
}
