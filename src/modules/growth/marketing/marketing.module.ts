import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../../sales/leads/leads.module.js";
import { MarketingService } from "./marketing.service.js";
import { MarketingController } from "./marketing.controller.js";
@Module({
  imports: [SalesLeadsModule],
  providers: [MarketingService],
  controllers: [MarketingController],
})
export class GrowthMarketingModule {}
