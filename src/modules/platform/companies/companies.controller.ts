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
  CompanyDraftInput,
  ManagerInput,
  CompanyQuoteInput,
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
  @RequireAccess(["platform"], "co.create") @Post("quote") quote(
    @Body() input: CompanyQuoteInput,
  ) {
    return this.service.quote(input);
  }
  @RequireAccess(["platform"], "co.create") @Get("drafts") drafts() {
    return this.service.drafts();
  }
  @RequireAccess(["platform"], "co.create") @Get("drafts/:draftId") draft(
    @Param("draftId") id: string,
  ) {
    return this.service.draft(id);
  }
  @RequireAccess(["platform"], "co.create") @Post("drafts") saveDraft(
    @Body() input: CompanyDraftInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.saveDraft(input, req.principal.id);
  }
  @RequireAccess(["platform"], "co.create")
  @Post("drafts/:draftId")
  updateDraft(
    @Param("draftId") id: string,
    @Body() input: CompanyDraftInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.saveDraft(input, req.principal.id, id);
  }
  @RequireAccess(["platform"], "co.view") @Get("success-managers") managers() {
    return this.service.managers();
  }
  @RequireAccess(["platform"], "co.view") @Get("onboarding-summary") summary() {
    return this.service.onboardingSummary();
  }
  @RequireAccess(["platform"], "co.create")
  @Post(":id/success-manager")
  manager(
    @Param("id") id: string,
    @Body() input: ManagerInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.manager(id, input, req.principal.id);
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
