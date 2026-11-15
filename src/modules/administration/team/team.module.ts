import { CompanySnapshotService } from "./company-insights/company-snapshot.service.js";
import { CompanyInsightsService } from "./company-insights/company-insights.service.js";
import { CompanyInsightsController } from "./company-insights/company-insights.controller.js";
import { KimiCompanyInsightsGateway } from "./company-insights/kimi-company-insights.gateway.js";
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
    CompanySnapshotService,
    CompanyInsightsService,
    KimiCompanyInsightsGateway,
    TeamInsightsService,
    KimiTeamInsightsGateway,
    TeamService,
    TeamWorkService,
  ],
  controllers: [
    CompanyInsightsController,
    TeamInsightsController,
    TeamController,
    TeamActivationController,
  ],
})
export class AdministrationTeamModule {}
