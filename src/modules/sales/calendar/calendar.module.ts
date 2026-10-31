import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../leads/leads.module.js";
import { CalendarController } from "./calendar.controller.js";
import { CalendarService } from "./calendar.service.js";
@Module({
  imports: [SalesLeadsModule],
  controllers: [CalendarController],
  providers: [CalendarService],
})
export class SalesCalendarModule {}
