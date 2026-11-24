import { Controller, Get, Query, Req } from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";
import { RequireAccess } from "../../common/auth/access.js";
import type { AuthRequest } from "../../common/auth/access.guard.js";
import { OfficeTeamService } from "./office-team.service.js";
@RequireAccess(["company_user"], "team.self.read")
@Controller("api/v1/office/my-team")
export class OfficeTeamController {
  constructor(private readonly s: OfficeTeamService) {}
  @Get("clients")
  @ApiOperation({
    summary: "Current office team's clients",
    description:
      "Active team lead only. Rechecks current roster; memberId, q, status, page and limit filters run before pagination. Office records only.",
  })
  clients(@Req() r: AuthRequest, @Query() q: Record<string, string>) {
    return this.s.list(r.principal, "clients", q);
  }
  @Get("tasks")
  @ApiOperation({ summary: "Current office team's assigned tasks" })
  tasks(@Req() r: AuthRequest, @Query() q: Record<string, string>) {
    return this.s.list(r.principal, "tasks", q);
  }
  @Get("performance")
  @ApiOperation({
    summary: "Current office team's performance",
    description:
      "7/30/90 Cairo calendar days through asOf. Current workload; new clients, logged actor calls/viewings, completed tasks and closed deals in period. Exact sale values and agreed monthly rents are separate, with no accounting revenue or rent collection implied.",
  })
  performance(@Req() r: AuthRequest, @Query() q: Record<string, string>) {
    return this.s.performance(r.principal, q);
  }
}
