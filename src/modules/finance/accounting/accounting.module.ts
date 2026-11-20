import { AccountingPerformanceService } from "./accounting-performance.service.js";
import { AccountingInstallmentsService } from "./accounting-installments.service.js";
import { AccountingFilesService } from "./accounting-files.service.js";
import { AccountingFilesController } from "./accounting-files.controller.js";
import { AccountingReportsService } from "./accounting-reports.service.js";
import { AccountingDealsService } from "./accounting-deals.service.js";
import { AccountingEmployeesService } from "./accounting-employees.service.js";
import { Module } from "@nestjs/common";
import { AccountingCore } from "./accounting.core.js";
import { AccountingSetupService } from "./accounting-setup.service.js";
import { AccountingObligationsService } from "./accounting-obligations.service.js";
import { AccountingTreasuryService } from "./accounting-treasury.service.js";
import { AccountingController } from "./accounting.controller.js";
@Module({
  providers: [
    AccountingPerformanceService,
    AccountingInstallmentsService,
    AccountingFilesService,
    AccountingReportsService,
    AccountingDealsService,
    AccountingEmployeesService,
    AccountingCore,
    AccountingSetupService,
    AccountingObligationsService,
    AccountingTreasuryService,
  ],
  controllers: [AccountingController, AccountingFilesController],
})
export class AccountingModule {}
