import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  BadRequestException,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { AnnouncementsService } from "./announcements.service.js";
import { AnnouncementInput } from "./announcements.dto.js";
@RequireAccess(["platform"], "ann")
@Controller("admin/api/v1/announcements")
export class AnnouncementsController {
  constructor(private readonly service: AnnouncementsService) {}
  @Get() list(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    if (page < 1 || page > 100000 || limit < 1 || limit > 100)
      throw new BadRequestException();
    return this.service.list(page, limit);
  }
  @Post() create(@Body() input: AnnouncementInput, @Req() req: AuthRequest) {
    return this.service.save(null, input, req.principal.id);
  }
  @Post(":id/update") update(
    @Param("id") id: string,
    @Body() input: AnnouncementInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.save(id, input, req.principal.id);
  }
}
@RequireAccess(["company_admin", "company_user"])
@Controller("api/v1/announcements")
export class CompanyAnnouncementsController {
  constructor(private readonly service: AnnouncementsService) {}
  @Get() visible(@Req() req: AuthRequest, @Query("lang") lang = "en") {
    if (!req.principal.companyId || !["en", "ar"].includes(lang))
      throw new BadRequestException();
    return this.service.visible(req.principal.companyId, lang as "en" | "ar");
  }
}
