import { EgyptHolidaysService } from "./leave/egypt-holidays.service.js";
import { LeaveService } from "./leave/leave.service.js";
import { LeaveController } from "./leave/leave.controller.js";
import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../sales/leads/leads.module.js";
import { HrService } from "./hr.service.js";
import { HrController } from "./hr.controller.js";
@Module({
  imports: [SalesLeadsModule],
  providers: [HrService, LeaveService, EgyptHolidaysService],
  controllers: [HrController, LeaveController],
})
export class HrModule {}
