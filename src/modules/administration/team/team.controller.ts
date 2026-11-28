import {
  Body,
  Controller,
  Get,
  Query,
  HttpCode,
  Param,
  Post,
  ParseUUIDPipe,
  Req,
} from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public, RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { TeamService } from "./team.service.js";
import {
  TeamInvite,
  TeamStatus,
  TeamActivate,
  EmployeeRole,
  EmployeeRoles,
  SalesTeamInput,
  SalesTeamUpdate,
} from "./team.dto.js";
import { TeamWorkService } from "./team-work.service.js";
import {
  TeamLeadQuery,
  TeamTaskQuery,
  TeamPerformanceQuery,
  TeamLeadAssignment,
  TeamTaskCreate,
  TeamTaskAssignment,
} from "./team-work.dto.js";
import { TaskStatus } from "../../sales/tasks/tasks.dto.js";
@Controller("api/v1/team")
export class TeamController {
  constructor(
    private readonly service: TeamService,
    private readonly work: TeamWorkService,
  ) {}
  @Post("my-team/tasks")
  @RequireAccess(["company_user"], "team.self.read")
  createTask(@Req() req: AuthRequest, @Body() input: TeamTaskCreate) {
    return this.work.createTask(req.principal, input);
  }
  @Post("my-team/tasks/:id/assign")
  @RequireAccess(["company_user"], "team.self.read")
  assignTask(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: TeamTaskAssignment,
  ) {
    return this.work.assignTask(req.principal, id, input);
  }
  @Post("my-team/tasks/:id/status")
  @RequireAccess(["company_user"], "team.self.read")
  taskStatus(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: TaskStatus,
  ) {
    return this.work.taskStatus(req.principal, id, input);
  }
  @Get("my-team/leads")
  @RequireAccess(["company_user"], "team.self.read")
  leads(@Req() req: AuthRequest, @Query() q: TeamLeadQuery) {
    return this.work.leads(req.principal, q);
  }
  @Get("my-team/tasks")
  @RequireAccess(["company_user"], "team.self.read")
  tasks(@Req() req: AuthRequest, @Query() q: TeamTaskQuery) {
    return this.work.tasks(req.principal, q);
  }
  @Get("my-team/performance")
  @ApiOperation({
    summary: "Current team CRM and cold-call performance",
    description:
      "Includes coldCalls.items and coldCalls.summary: calls, all six outcome counts and convertedToLeads credited to the recorded actor in the selected 7/30/90 Cairo calendar days through asOf; overdueCallbacks is the current unconverted workload by current owner, independent of the period. Restricted to the current team lead and current roster.",
  })
  @RequireAccess(["company_user"], "team.self.read")
  performance(@Req() req: AuthRequest, @Query() q: TeamPerformanceQuery) {
    return this.work.performance(req.principal, q);
  }
  @Post("my-team/leads/:id/assign")
  @RequireAccess(["company_user"], "team.self.read")
  assign(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: TeamLeadAssignment,
  ) {
    return this.work.assign(req.principal, id, input);
  }
  @Get("groups") @RequireAccess(["company_admin", "company_user"]) groups(
    @Req() req: AuthRequest,
  ) {
    return this.service.groups(req.principal);
  }
  @Get("my-team") @RequireAccess(["company_user"], "team.self.read") myTeam(
    @Req() req: AuthRequest,
  ) {
    return this.service.myTeam(req.principal);
  }
  @Post("groups") @RequireAccess(["company_admin", "company_user"]) createGroup(
    @Body() input: SalesTeamInput,
    @Req() req: AuthRequest,
  ) {
    return this.service.saveGroup(req.principal, input);
  }
  @Post("groups/:id")
  @RequireAccess(["company_admin", "company_user"])
  updateGroup(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: SalesTeamUpdate,
    @Req() req: AuthRequest,
  ) {
    return this.service.saveGroup(req.principal, input, id);
  }
  @Post(":id/role") @RequireAccess(["company_admin", "company_user"]) role(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: EmployeeRole,
    @Req() req: AuthRequest,
  ) {
    return this.service.changeRole(req.principal, id, input.role);
  }
  @Post(":id/roles") @RequireAccess(["company_admin", "company_user"]) roles(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: EmployeeRoles,
    @Req() req: AuthRequest,
  ) {
    return this.service.changeRoles(
      req.principal,
      id,
      input.roles,
      input.version,
    );
  }
  @Get() @RequireAccess(["company_admin", "company_user"]) list(
    @Req() req: AuthRequest,
  ) {
    return this.service.list(req.principal);
  }
  @Post("invite") @RequireAccess(["company_admin", "company_user"]) invite(
    @Body() input: TeamInvite,
    @Req() req: AuthRequest,
  ) {
    return this.service.invite(req.principal, input);
  }
  @Post(":id/resend") @RequireAccess(["company_admin", "company_user"]) resend(
    @Param("id") id: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.resend(req.principal, id);
  }
  @Post(":id/revoke") @RequireAccess(["company_admin", "company_user"]) revoke(
    @Param("id") id: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.revoke(req.principal, id);
  }
  @Post(":id/status") @RequireAccess(["company_admin", "company_user"]) status(
    @Param("id") id: string,
    @Body() input: TeamStatus,
    @Req() req: AuthRequest,
  ) {
    return this.service.status(req.principal, id, input);
  }
}
@Controller("api/v1/team")
export class TeamActivationController {
  constructor(private readonly service: TeamService) {}
  @Post("activate")
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  activate(@Body() input: TeamActivate) {
    return this.service.activate(input);
  }
}
