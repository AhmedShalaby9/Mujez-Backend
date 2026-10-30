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
import { ReservationsService } from "./reservations.service.js";
import {
  ReservationQuery,
  HoldInput,
  ReservationAction,
} from "./reservations.dto.js";
@RequireAccess(["company_admin"], "reservations.read")
@Controller("api/v1/reservations")
export class ReservationsController {
  constructor(private readonly s: ReservationsService) {}
  @Get() list(@Req() r: AuthRequest, @Query() q: ReservationQuery) {
    return this.s.list(r.principal, q);
  }
  @Get(":id") detail(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.detail(r.principal, id);
  }
  @Post() @RequireAccess(["company_admin"], "reservations.manage") hold(
    @Req() r: AuthRequest,
    @Body() b: HoldInput,
  ) {
    return this.s.hold(r.principal, b);
  }
  @Post(":id/action")
  @RequireAccess(["company_admin"], "reservations.manage")
  action(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: ReservationAction,
  ) {
    return this.s.action(r.principal, id, b);
  }
}
