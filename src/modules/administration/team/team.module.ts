import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../../sales/leads/leads.module.js";
import { TeamService } from "./team.service.js";
import { TeamController, TeamActivationController } from "./team.controller.js";
@Module({
  imports: [SalesLeadsModule],
  providers: [TeamService],
  controllers: [TeamController, TeamActivationController],
})
export class AdministrationTeamModule {}
