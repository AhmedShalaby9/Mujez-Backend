import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Param,
  Query,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { SalesQuery, ActivityQuery } from "../leads/leads.dto.js";
import { TasksService } from "./tasks.service.js";
import { TaskQuery, TaskInput, TaskUpdate, TaskStatus } from "./tasks.dto.js";
@RequireAccess(["company_admin"], "tasks.read")
@Controller("api/v1/tasks")
export class TasksController {
  constructor(private readonly service: TasksService) {}
  @Get() list(@Req() r: AuthRequest, @Query() q: TaskQuery) {
    return this.service.list(r.principal, q);
  }
  @Get("options") options(@Req() r: AuthRequest) {
    return this.service.options(r.principal);
  }
  @Get("lead-options") leads(@Req() r: AuthRequest, @Query() q: SalesQuery) {
    return this.service.leadOptions(r.principal, q);
  }
  @Get(":id") detail(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.detail(r.principal, id);
  }
  @Get(":id/activities") activities(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() q: ActivityQuery,
  ) {
    return this.service.activities(r.principal, id, q);
  }
  @Post() @RequireAccess(["company_admin"], "tasks.manage") create(
    @Req() r: AuthRequest,
    @Body() b: TaskInput,
  ) {
    return this.service.create(r.principal, b);
  }
  @Post(":id/update") @RequireAccess(["company_admin"], "tasks.manage") update(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: TaskUpdate,
  ) {
    return this.service.update(r.principal, id, b);
  }
  @Post(":id/status") @RequireAccess(["company_admin"], "tasks.manage") status(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: TaskStatus,
  ) {
    return this.service.status(r.principal, id, b);
  }
}
