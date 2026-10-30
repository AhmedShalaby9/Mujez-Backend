import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../../sales/leads/leads.module.js";
import { CompanyReportsService } from "./reports.service.js";
import { CompanyOverviewService } from "./company-overview.service.js";
import {
  CompanyReportsController,
  CompanyOverviewController,
} from "./reports.controller.js";
@Module({
  imports: [SalesLeadsModule],
  providers: [CompanyReportsService, CompanyOverviewService],
  controllers: [CompanyReportsController, CompanyOverviewController],
})
export class GrowthReportsModule {}
