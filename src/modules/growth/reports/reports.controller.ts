import { Controller, Get, Post, Req, Query, Body } from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { CompanyReportsService } from "./reports.service.js";
import { CompanyOverviewService } from "./company-overview.service.js";
import { ReportQuery, ReportExport, OverviewQuery } from "./reports.dto.js";
@RequireAccess(["company_admin"], "reports.read")
@Controller("api/v1/reports")
export class CompanyReportsController {
  constructor(private readonly s: CompanyReportsService) {}
  @Get() report(@Req() r: AuthRequest, @Query() q: ReportQuery) {
    return this.s.report(r.principal, q);
  }
  @Post("export") @RequireAccess(["company_admin"], "reports.export") export(
    @Req() r: AuthRequest,
    @Body() b: ReportExport,
  ) {
    return this.s.export(r.principal, b);
  }
}
@RequireAccess(["company_admin"], "workspace.view")
@Controller("api/v1/company-overview")
export class CompanyOverviewController {
  constructor(private readonly s: CompanyOverviewService) {}
  @Get() overview(@Req() r: AuthRequest, @Query() q: OverviewQuery) {
    return this.s.overview(r.principal, q.segment);
  }
}
