import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from "@nestjs/common";
import type { Response } from "express";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { BrokerageDealsService } from "./brokerage-deals.service.js";
import {
  DealDecision,
  DealInput,
  DealListQuery,
  DealUpdate,
  DeveloperInput,
  DeveloperUpdate,
  DeveloperArchive,
  BrokerageProjectInput,
} from "./brokerage-deals.dto.js";

@RequireAccess(["company_admin", "company_user"], "leads.read")
@Controller("api/v1/brokerage")
export class BrokerageDealsController {
  constructor(private readonly service: BrokerageDealsService) {}
  @Get("deals/options") options(@Req() r: AuthRequest) {
    return this.service.options(r.principal);
  }
  @Get("deals/leads") leads(
    @Req() r: AuthRequest,
    @Query("search") search?: string,
  ) {
    return this.service.leads(r.principal, search);
  }
  @Get("deals") list(@Req() r: AuthRequest, @Query() q: DealListQuery) {
    return this.service.list(r.principal, q);
  }
  @Get("deals/:id") detail(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.detail(r.principal, id);
  }
  @Post("deals")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  create(@Req() r: AuthRequest, @Body() b: DealInput) {
    return this.service.create(r.principal, b);
  }
  @Post("deals/:id/update")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  update(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: DealUpdate,
  ) {
    return this.service.update(r.principal, id, b);
  }
  @Post("deals/:id/decision")
  @RequireAccess(["company_admin"], "leads.manage")
  decide(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: DealDecision,
  ) {
    return this.service.decide(r.principal, id, b);
  }
  @Get("deals/:id/documents/:documentId")
  async document(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("documentId", ParseUUIDPipe) documentId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const d = await this.service.document(r.principal, id, documentId);
    res.setHeader("Content-Type", d.mime_type);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${d.file_name.replace(/[^\x20-\x7E]|["\\]/g, "_")}"`,
    );
    return new StreamableFile(d.content);
  }
  @Get("developers") developers(@Req() r: AuthRequest) {
    return this.service.developers(r.principal);
  }
  @Post("developers")
  @RequireAccess(["company_admin"], "projects.manage")
  createDeveloper(@Req() r: AuthRequest, @Body() b: DeveloperInput) {
    return this.service.createDeveloper(r.principal, b);
  }
  @Post("developers/:id/update")
  @RequireAccess(["company_admin"], "projects.manage")
  updateDeveloper(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: DeveloperUpdate,
  ) {
    return this.service.updateDeveloper(r.principal, id, b);
  }
  @Post("developers/:id/archive")
  @RequireAccess(["company_admin"], "projects.manage")
  archiveDeveloper(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: DeveloperArchive,
  ) {
    return this.service.archiveDeveloper(r.principal, id, b);
  }
  @Post("projects")
  @RequireAccess(["company_admin"], "projects.manage")
  createProject(@Req() r: AuthRequest, @Body() b: BrokerageProjectInput) {
    return this.service.createProject(r.principal, b);
  }
}
