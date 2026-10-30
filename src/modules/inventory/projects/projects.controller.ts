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
import { SalesQuery } from "../../sales/leads/leads.dto.js";
import { InventoryService } from "./inventory.service.js";
import {
  ProjectInput,
  ProjectUpdate,
  PhaseInput,
  PhaseUpdate,
  BuildingInput,
  BuildingUpdate,
  InventoryArchive,
} from "./inventory.dto.js";
@RequireAccess(["company_admin"], "projects.read")
@Controller("api/v1/projects")
export class ProjectsController {
  constructor(private readonly s: InventoryService) {}
  @Get() list(@Req() r: AuthRequest, @Query() q: SalesQuery) {
    return this.s.projects(r.principal, q);
  }
  @Get(":id") detail(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.project(r.principal, id);
  }
  @Post() @RequireAccess(["company_admin"], "projects.manage") create(
    @Req() r: AuthRequest,
    @Body() b: ProjectInput,
  ) {
    return this.s.createProject(r.principal, b);
  }
  @Post(":id/update")
  @RequireAccess(["company_admin"], "projects.manage")
  update(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: ProjectUpdate,
  ) {
    return this.s.updateProject(r.principal, id, b);
  }
  @Post(":id/archive")
  @RequireAccess(["company_admin"], "projects.manage")
  archive(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: InventoryArchive,
  ) {
    return this.s.archive(r.principal, "projects", id, b);
  }
  @Post(":id/phases")
  @RequireAccess(["company_admin"], "projects.manage")
  phase(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: PhaseInput,
  ) {
    return this.s.phase(r.principal, id, b);
  }
  @Post(":id/phases/:phase/update")
  @RequireAccess(["company_admin"], "projects.manage")
  phaseUpdate(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("phase", ParseUUIDPipe) ph: string,
    @Body() b: PhaseUpdate,
  ) {
    return this.s.phase(r.principal, id, b, ph);
  }
  @Post("phases/:phase/buildings")
  @RequireAccess(["company_admin"], "projects.manage")
  building(
    @Req() r: AuthRequest,
    @Param("phase", ParseUUIDPipe) ph: string,
    @Body() b: BuildingInput,
  ) {
    return this.s.building(r.principal, ph, b);
  }
  @Post("phases/:phase/buildings/:building/update")
  @RequireAccess(["company_admin"], "projects.manage")
  buildingUpdate(
    @Req() r: AuthRequest,
    @Param("phase", ParseUUIDPipe) ph: string,
    @Param("building", ParseUUIDPipe) bu: string,
    @Body() b: BuildingUpdate,
  ) {
    return this.s.building(r.principal, ph, b, bu);
  }
}
