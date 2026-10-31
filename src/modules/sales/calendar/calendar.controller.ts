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
import { CalendarService } from "./calendar.service.js";
import {
  EventQuery,
  EventInput,
  EventUpdate,
  EventStatus,
} from "./calendar.dto.js";
@RequireAccess(["company_admin"], "calendar.read")
@Controller("api/v1/events")
export class CalendarController {
  constructor(private readonly service: CalendarService) {}
  @Get() list(@Req() r: AuthRequest, @Query() q: EventQuery) {
    return this.service.list(r.principal, q);
  }
  @Get("options") options(@Req() r: AuthRequest) {
    return this.service.options(r.principal);
  }
  @Get(":id") detail(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.detail(r.principal, id);
  }
  @Post() @RequireAccess(["company_admin"], "calendar.manage") create(
    @Req() r: AuthRequest,
    @Body() b: EventInput,
  ) {
    return this.service.create(r.principal, b);
  }
  @Post(":id/update")
  @RequireAccess(["company_admin"], "calendar.manage")
  update(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: EventUpdate,
  ) {
    return this.service.update(r.principal, id, b);
  }
  @Post(":id/status")
  @RequireAccess(["company_admin"], "calendar.manage")
  status(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: EventStatus,
  ) {
    return this.service.status(r.principal, id, b);
  }
}
