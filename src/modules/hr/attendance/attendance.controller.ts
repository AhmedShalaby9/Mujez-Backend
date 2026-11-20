import {
  Controller,
  Get,
  Post,
  Req,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { AttendanceService } from "./attendance.service.js";
@Controller("api/v1/attendance")
@RequireAccess(["company_admin", "company_user"])
export class AttendanceController {
  constructor(private readonly s: AttendanceService) {}
  @Get("context") context(@Req() r: AuthRequest) {
    return this.s.context(r.principal);
  }
  @Get("schedules") schedules(@Req() r: AuthRequest) {
    return this.s.schedules(r.principal);
  }
  @Post("schedules") createSchedule(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveSchedule(r.principal, b);
  }
  @Post("schedules/:id") updateSchedule(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.saveSchedule(r.principal, b, id);
  }
  @Get("options") options(@Req() r: AuthRequest) {
    return this.s.options(r.principal);
  }
  @Get("assignments") assignments(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.assignments(r.principal, q);
  }
  @Post("assignments") assign(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.assign(r.principal, b);
  }
  @Post("punch") punch(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.punch(r.principal, b);
  }
  @Get("report") report(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.report(r.principal, q);
  }
  @Get("corrections") corrections(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.s.corrections(r.principal, q);
  }
  @Post("corrections") correct(
    @Req() r: AuthRequest,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.correct(r.principal, b);
  }
  @Post("corrections/:id/action") review(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.s.review(r.principal, id, b);
  }
}
