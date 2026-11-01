import {
  Controller,
  Post,
  Body,
  Get,
  Req,
  Query,
  Param,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { CompanyAuditService } from "./audit.service.js";
import { CompanyAuditQuery, CompanyAuditExport } from "./audit.dto.js";
@RequireAccess(["company_admin"], "audit.read")
@Controller("api/v1/company-audit")
export class CompanyAuditController {
  constructor(private readonly s: CompanyAuditService) {}
  @Get() list(@Req() r: AuthRequest, @Query() q: CompanyAuditQuery) {
    return this.s.list(r.principal, q);
  }
  @Get("options") options(@Req() r: AuthRequest) {
    return this.s.options(r.principal);
  }
  @Post("export") @RequireAccess(["company_admin"], "reports.export") export(
    @Req() r: AuthRequest,
    @Body() q: CompanyAuditExport,
  ) {
    return this.s.export(r.principal, q);
  }
  @Get(":id") detail(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.detail(r.principal, id);
  }
}
