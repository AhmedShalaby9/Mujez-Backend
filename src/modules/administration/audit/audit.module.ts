import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../../sales/leads/leads.module.js";
import { CompanyAuditService } from "./audit.service.js";
import { CompanyAuditController } from "./audit.controller.js";
@Module({
  imports: [SalesLeadsModule],
  providers: [CompanyAuditService],
  controllers: [CompanyAuditController],
})
export class AdministrationAuditModule {}
