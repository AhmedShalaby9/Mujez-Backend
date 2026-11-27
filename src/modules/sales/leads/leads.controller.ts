import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Param,
  Query,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { SalesService } from "./sales.service.js";
import {
  SalesQuery,
  LeadInput,
  LeadUpdate,
  StageChange,
  LeadArchive,
  LeadNote,
  ActivityQuery,
  BrokerageLeadStatusChange,
  LeadTagsChange,
  BulkAssign,
  BulkStage,
  BulkStatus,
  BulkTags,
} from "./leads.dto.js";
@RequireAccess(["company_admin", "company_user"], "leads.read")
@Controller("api/v1/leads")
export class LeadsController {
  constructor(private readonly service: SalesService) {}
  @Get() list(@Req() req: AuthRequest, @Query() q: SalesQuery) {
    return this.service.list(req.principal, q);
  }
  @Get("options") options(@Req() req: AuthRequest) {
    return this.service.options(req.principal);
  }
  @Get(":id") detail(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.detail(req.principal, id);
  }
  @Get(":id/activities") activities(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() q: ActivityQuery,
  ) {
    return this.service.activities(req.principal, id, q);
  }
  @Post()
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  create(@Req() req: AuthRequest, @Body() b: LeadInput) {
    return this.service.create(req.principal, b);
  }
  // Literal "bulk/..." routes must come before the ":id/..." routes below so
  // they are not shadowed by a dynamic segment matching "bulk" as an id.
  @Post("bulk/assign")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  bulkAssign(@Req() req: AuthRequest, @Body() b: BulkAssign) {
    return this.service.bulkAssign(req.principal, b);
  }
  @Post("bulk/stage")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  bulkStage(@Req() req: AuthRequest, @Body() b: BulkStage) {
    return this.service.bulkStage(req.principal, b);
  }
  @Post("bulk/status")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  bulkStatus(@Req() req: AuthRequest, @Body() b: BulkStatus) {
    return this.service.bulkStatus(req.principal, b);
  }
  @Post("bulk/tags")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  bulkTags(@Req() req: AuthRequest, @Body() b: BulkTags) {
    return this.service.bulkTags(req.principal, b);
  }
  @Post(":id/update")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  update(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: LeadUpdate,
  ) {
    return this.service.update(req.principal, id, b);
  }
  @Post(":id/stage")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  stage(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: StageChange,
  ) {
    return this.service.stage(req.principal, id, b);
  }
  @Post(":id/status")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  status(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: BrokerageLeadStatusChange,
  ) {
    return this.service.brokerageStatus(req.principal, id, b);
  }
  @Post(":id/archive")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  archive(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: LeadArchive,
  ) {
    return this.service.archive(req.principal, id, b);
  }
  @Post(":id/notes")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  note(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: LeadNote,
  ) {
    return this.service.note(req.principal, id, b);
  }
  @Post(":id/tags")
  @RequireAccess(["company_admin", "company_user"], "leads.manage")
  tags(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: LeadTagsChange,
  ) {
    return this.service.tags(req.principal, id, b);
  }
}
