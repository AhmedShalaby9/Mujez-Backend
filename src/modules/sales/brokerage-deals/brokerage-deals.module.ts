import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../leads/leads.module.js";
import { BrokerageDealsController } from "./brokerage-deals.controller.js";
import { BrokerageDealsService } from "./brokerage-deals.service.js";
@Module({
  imports: [SalesLeadsModule],
  controllers: [BrokerageDealsController],
  providers: [BrokerageDealsService],
})
export class BrokerageDealsModule {}
