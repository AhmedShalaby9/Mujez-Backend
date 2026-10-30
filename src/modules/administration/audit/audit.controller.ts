import {
  Controller,
  Get,
  Req,
  Query,
  Param,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { CompanyAuditService } from "./audit.service.js";
import { CompanyAuditQuery } from "./audit.dto.js";
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
  @Get(":id") detail(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.detail(r.principal, id);
  }
}
