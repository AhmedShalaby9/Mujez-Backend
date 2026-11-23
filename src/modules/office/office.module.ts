import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../sales/leads/leads.module.js";
import { OfficeController } from "./office.controller.js";
import { OfficeService } from "./office.service.js";
@Module({
  imports: [SalesLeadsModule],
  controllers: [OfficeController],
  providers: [OfficeService],
})
export class OfficeModule {}
