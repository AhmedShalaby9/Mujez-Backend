import { Module } from "@nestjs/common";
import { SalesService } from "./sales.service.js";
import { LeadsController } from "./leads.controller.js";
@Module({
  providers: [SalesService],
  controllers: [LeadsController],
  exports: [SalesService],
})
export class SalesLeadsModule {}
