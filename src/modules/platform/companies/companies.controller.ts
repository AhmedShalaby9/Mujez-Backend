import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  DefaultValuePipe,
  ParseIntPipe,
  BadRequestException,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { CompaniesService } from "./companies.service.js";
import {
  CompanyInput,
  CompanyUpdate,
  StatusInput,
  StepInput,
} from "./companies.dto.js";
@Controller("admin/api/v1/companies")
export class CompaniesController {
  constructor(private readonly service: CompaniesService) {}
  @RequireAccess(["platform"], "co.view") @Get() list(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query("onboarding") onboarding?: string,
  ) {
    if (page < 1 || page > 100000 || limit < 1 || limit > 100)
      throw new BadRequestException();
    return this.service.list(page, limit, onboarding === "true");
  }
  @RequireAccess(["platform"], "co.view") @Get(":id") detail(
    @Param("id") id: string,
  ) {
    return this.service.detail(id);
  }
  @RequireAccess(["platform"], "co.create") @Post() create(
    @Body() input: CompanyInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.create(input, req.principal.id);
  }
  @RequireAccess(["platform"], "co.create") @Post(":id/update") update(
    @Param("id") id: string,
    @Body() input: CompanyUpdate,
    @Req() req: AuthRequest,
  ) {
    return this.service.update(id, input, req.principal.id);
  }
  @RequireAccess(["platform"], "co.suspend") @Post(":id/status") status(
    @Param("id") id: string,
    @Body() input: StatusInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.status(id, input, req.principal.id);
  }
  @RequireAccess(["platform"], "co.create") @Post(":id/onboarding") step(
    @Param("id") id: string,
    @Body() input: StepInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.step(id, input, req.principal.id);
  }
}
