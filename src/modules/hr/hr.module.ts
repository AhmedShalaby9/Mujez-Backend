import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../sales/leads/leads.module.js";
import { HrService } from "./hr.service.js";
import { HrController } from "./hr.controller.js";
@Module({
  imports: [SalesLeadsModule],
  providers: [HrService],
  controllers: [HrController],
})
export class HrModule {}
