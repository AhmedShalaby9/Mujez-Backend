import { ColdCallsService } from "../cold-calls/cold-calls.service.js";
import { ColdCallsController } from "../cold-calls/cold-calls.controller.js";
import { Module } from "@nestjs/common";
import { SalesService } from "./sales.service.js";
import { LeadsController } from "./leads.controller.js";
@Module({
  providers: [SalesService, ColdCallsService],
  controllers: [LeadsController, ColdCallsController],
  exports: [SalesService],
})
export class SalesLeadsModule {}
