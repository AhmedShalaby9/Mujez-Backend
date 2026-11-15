import { TeamInsightsController } from "./insights/team-insights.controller.js";
import { TeamInsightsService } from "./insights/team-insights.service.js";
import { KimiTeamInsightsGateway } from "./insights/kimi-team-insights.gateway.js";
import { SalesTasksModule } from "../../sales/tasks/tasks.module.js";
import { Module } from "@nestjs/common";
import { SalesLeadsModule } from "../../sales/leads/leads.module.js";
import { TeamWorkService } from "./team-work.service.js";
import { TeamService } from "./team.service.js";
import { TeamController, TeamActivationController } from "./team.controller.js";
@Module({
  imports: [SalesLeadsModule, SalesTasksModule],
  providers: [
    TeamInsightsService,
    KimiTeamInsightsGateway,
    TeamService,
    TeamWorkService,
  ],
  controllers: [
    TeamInsightsController,
    TeamController,
    TeamActivationController,
  ],
})
export class AdministrationTeamModule {}
