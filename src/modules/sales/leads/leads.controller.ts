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
  LeadContact,
  ActivityQuery,
} from "./leads.dto.js";
@RequireAccess(["company_admin"], "leads.read")
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
  @Post() @RequireAccess(["company_admin"], "leads.manage") create(
    @Req() req: AuthRequest,
    @Body() b: LeadInput,
  ) {
    return this.service.create(req.principal, b);
  }
  @Post(":id/update") @RequireAccess(["company_admin"], "leads.manage") update(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: LeadUpdate,
  ) {
    return this.service.update(req.principal, id, b);
  }
  @Post(":id/stage") @RequireAccess(["company_admin"], "leads.manage") stage(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: StageChange,
  ) {
    return this.service.stage(req.principal, id, b);
  }
  @Post(":id/archive")
  @RequireAccess(["company_admin"], "leads.manage")
  archive(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: LeadArchive,
  ) {
    return this.service.archive(req.principal, id, b);
  }
  @Post(":id/contact")
  @RequireAccess(["company_admin"], "leads.manage")
  contact(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: LeadContact,
  ) {
    return this.service.contact(r.principal, id, b);
  }
  @Post(":id/notes") @RequireAccess(["company_admin"], "leads.manage") note(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: LeadNote,
  ) {
    return this.service.note(req.principal, id, b);
  }
}
