import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../../sales/leads/leads.module.js";
import { CommissionsController } from "./commissions.controller.js";
import { CommissionsService } from "./commissions.service.js";
@Module({
  imports: [SalesLeadsModule],
  providers: [CommissionsService],
  controllers: [CommissionsController],
})
export class FinanceCommissionsModule {}
