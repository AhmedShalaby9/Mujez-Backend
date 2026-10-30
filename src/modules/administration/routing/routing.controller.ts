import {
  Controller,
  Get,
  Post,
  Req,
  Body,
  Param,
  ParseUUIDPipe,
} from "@nestjs/common";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { RoutingService } from "./routing.service.js";
import {
  RoutingInput,
  RoutingUpdate,
  RoutingAction,
  RoutingSimulation,
} from "./routing.dto.js";
@RequireAccess(["company_admin"], "routing.read")
@Controller("api/v1/routing")
export class RoutingController {
  constructor(private readonly s: RoutingService) {}
  @Get() list(@Req() r: AuthRequest) {
    return this.s.list(r.principal);
  }
  @Get("options") options(@Req() r: AuthRequest) {
    return this.s.options(r.principal);
  }
  @Post("simulate") simulate(
    @Req() r: AuthRequest,
    @Body() b: RoutingSimulation,
  ) {
    return this.s.simulate(r.principal, b);
  }
  @Post() @RequireAccess(["company_admin"], "routing.manage") create(
    @Req() r: AuthRequest,
    @Body() b: RoutingInput,
  ) {
    return this.s.save(r.principal, b);
  }
  @Post(":id/update")
  @RequireAccess(["company_admin"], "routing.manage")
  update(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: RoutingUpdate,
  ) {
    return this.s.save(r.principal, b, id);
  }
  @Post(":id/action")
  @RequireAccess(["company_admin"], "routing.manage")
  action(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: RoutingAction,
  ) {
    return this.s.action(r.principal, id, b);
  }
}
