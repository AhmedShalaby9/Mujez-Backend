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
import { InventoryService } from "../projects/inventory.service.js";
import {
  InventoryQuery,
  UnitInput,
  UnitUpdate,
  InventoryArchive,
} from "../projects/inventory.dto.js";
@RequireAccess(["company_admin"], "units.read")
@Controller("api/v1/units")
export class UnitsController {
  constructor(private readonly s: InventoryService) {}
  @Get() list(@Req() r: AuthRequest, @Query() q: InventoryQuery) {
    return this.s.units(r.principal, q);
  }
  @Get(":id") detail(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.unit(r.principal, id);
  }
  @Post() @RequireAccess(["company_admin"], "units.manage") create(
    @Req() r: AuthRequest,
    @Body() b: UnitInput,
  ) {
    return this.s.saveUnit(r.principal, b);
  }
  @Post(":id/update") @RequireAccess(["company_admin"], "units.manage") update(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: UnitUpdate,
  ) {
    return this.s.saveUnit(r.principal, b, id);
  }
  @Post(":id/archive")
  @RequireAccess(["company_admin"], "units.manage")
  archive(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: InventoryArchive,
  ) {
    return this.s.archive(r.principal, "units", id, b);
  }
}
