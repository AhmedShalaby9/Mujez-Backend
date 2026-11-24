import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../sales/leads/leads.module.js";
import { OfficeController } from "./office.controller.js";
import { OfficeService } from "./office.service.js";
import { OfficeTeamController } from "./office-team.controller.js";
import { OfficeTeamService } from "./office-team.service.js";
@Module({
  imports: [SalesLeadsModule],
  controllers: [OfficeController, OfficeTeamController],
  providers: [OfficeService, OfficeTeamService],
})
export class OfficeModule {}
