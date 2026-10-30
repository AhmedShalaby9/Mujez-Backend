import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../../sales/leads/leads.module.js";
import { RoutingService } from "./routing.service.js";
import { RoutingController } from "./routing.controller.js";
@Module({
  imports: [SalesLeadsModule],
  providers: [RoutingService],
  controllers: [RoutingController],
})
export class AdministrationRoutingModule {}
