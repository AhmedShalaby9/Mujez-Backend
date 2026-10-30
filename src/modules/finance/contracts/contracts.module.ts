import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../../sales/leads/leads.module.js";
import { ContractsController } from "./contracts.controller.js";
import { ContractsService } from "./contracts.service.js";
@Module({
  imports: [SalesLeadsModule],
  providers: [ContractsService],
  controllers: [ContractsController],
})
export class FinanceContractsModule {}
