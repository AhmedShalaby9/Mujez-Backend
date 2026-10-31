import {
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { RequireAccess } from "../../../common/auth/access.js";
import type { AuthRequest } from "../../../common/auth/access.guard.js";
import { WorkspaceService } from "./workspace.service.js";
import { EnterInput, ElevateInput, ExitInput } from "./workspace.dto.js";
import { ENV, type Environment } from "../../../config/env.js";

function cookieName(env: Environment) {
  return env.NODE_ENV === "production"
    ? "__Host-mujez_workspace"
    : "mujez_workspace";
}
function cookieOptions(env: Environment) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
}

/** Platform side: a Super/Platform/Support admin entering a company's workspace. */
@Controller("admin/api/v1/companies/:id/workspace-session")
export class WorkspaceEntryController {
  constructor(
    private readonly service: WorkspaceService,
    @Inject(ENV) private readonly env: Environment,
  ) {}
  @RequireAccess(["platform"]) @Post() async enter(
    @Param("id") id: string,
    @Body() input: EnterInput,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.enter(
      { id: req.principal.id, permissions: req.principal.permissions },
      id,
      input,
    );
    res.cookie(cookieName(this.env), result.token, cookieOptions(this.env));
    const { token: _token, ...body } = result;
    return body;
  }
}

/** Tenant side: the embedded CRM's workspace banner acting on the active session. */
@Controller("api/v1/workspace-session")
export class WorkspaceSessionController {
  constructor(
    private readonly service: WorkspaceService,
    @Inject(ENV) private readonly env: Environment,
  ) {}
  @RequireAccess(["company_admin"]) @Post("elevate") elevate(
    @Body() input: ElevateInput,
    @Req() req: AuthRequest,
  ) {
    if (!req.principal.workspace) throw new ForbiddenException();
    return this.service.elevate(
      req.principal.workspace,
      req.principal.id,
      input,
    );
  }
  @RequireAccess(["company_admin"]) @Post("drop") drop(
    @Req() req: AuthRequest,
  ) {
    if (!req.principal.workspace) throw new ForbiddenException();
    return this.service.drop(req.principal.workspace, req.principal.id);
  }
  @RequireAccess(["company_admin"]) @Post("exit") async exit(
    @Body() input: ExitInput,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!req.principal.workspace) throw new ForbiddenException();
    const result = await this.service.exit(
      req.principal.workspace,
      req.principal.id,
      input.reason,
    );
    res.clearCookie(cookieName(this.env), cookieOptions(this.env));
    return result;
  }
}
