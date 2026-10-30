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
import { ContractsService } from "./contracts.service.js";
import {
  ContractQuery,
  ContractInput,
  ContractUpdate,
  ContractAction,
  RequirementAttach,
} from "./contracts.dto.js";
@RequireAccess(["company_admin"], "contracts.read")
@Controller("api/v1/contracts")
export class ContractsController {
  constructor(private readonly s: ContractsService) {}
  @Get() list(@Req() r: AuthRequest, @Query() q: ContractQuery) {
    return this.s.list(r.principal, q);
  }
  @Get(":id") detail(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.s.detail(r.principal, id);
  }
  @Post() @RequireAccess(["company_admin"], "contracts.manage") create(
    @Req() r: AuthRequest,
    @Body() b: ContractInput,
  ) {
    return this.s.create(r.principal, b);
  }
  @Post(":id/update")
  @RequireAccess(["company_admin"], "contracts.manage")
  update(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: ContractUpdate,
  ) {
    return this.s.update(r.principal, id, b);
  }
  @Post(":id/action")
  @RequireAccess(["company_admin"], "contracts.manage")
  action(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() b: ContractAction,
  ) {
    return this.s.action(r.principal, id, b);
  }
  @Post(":id/requirements/:requirement/attach")
  @RequireAccess(["company_admin"], "contracts.manage")
  attach(
    @Req() r: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("requirement", ParseUUIDPipe) requirement: string,
    @Body() b: RequirementAttach,
  ) {
    return this.s.attach(r.principal, id, requirement, b);
  }
}
