import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../leads/leads.module.js";
import { DealCommissionsController } from "./deal-commissions.controller.js";
import { DealCommissionsService } from "./deal-commissions.service.js";
@Module({
  imports: [SalesLeadsModule],
  controllers: [DealCommissionsController],
  providers: [DealCommissionsService],
})
export class DealCommissionsModule {}
