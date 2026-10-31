import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  ForbiddenException,
  Req,
  Res,
} from "@nestjs/common";
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { Public, RequireAccess } from "../../common/auth/access.js";
import {
  sessionCookie,
  workspaceCookie,
  type AuthRequest,
} from "../../common/auth/access.guard.js";
import { SessionService } from "../../common/auth/session.service.js";
import { WorkspaceService } from "../platform/workspace/workspace.service.js";
import { ENV, type Environment } from "../../config/env.js";
class ChangeOwnerPasswordDto {
  @IsString() @MinLength(1) @MaxLength(256) declare currentPassword: string;
  @IsString() @MinLength(12) @MaxLength(256) declare newPassword: string;
}
class LoginDto {
  @IsEmail() @MaxLength(254) declare email: string;
  @IsString() @MinLength(1) @MaxLength(256) declare password: string;
  @IsOptional() @IsBoolean() declare remember?: boolean;
}
@Controller(["admin/api/v1/auth", "api/v1/auth"])
export class AuthController {
  constructor(
    private readonly sessions: SessionService,
    private readonly workspace: WorkspaceService,
    @Inject(ENV) private readonly env: Environment,
  ) {}
  private get name() {
    return this.env.NODE_ENV === "production"
      ? "__Host-mujez_session"
      : "mujez_session";
  }
  private get workspaceName() {
    return this.env.NODE_ENV === "production"
      ? "__Host-mujez_workspace"
      : "mujez_workspace";
  }
  @Public()
  @Post("login")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async login(
    @Body() body: LoginDto,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await (
      req.path.startsWith("/admin/")
        ? this.sessions.login.bind(this.sessions)
        : this.sessions.loginAny.bind(this.sessions)
    )(
      body.email,
      body.password,
      body.remember ?? false,
      sessionCookie(req),
      req.ip,
    );
    res.cookie(this.name, session.token, {
      httpOnly: true,
      secure: this.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      ...(body.remember ? { maxAge: session.seconds * 1000 } : {}),
    });
    return { status: "authenticated" };
  }
  @RequireAccess(["platform", "company_admin", "company_user"])
  @Get("session")
  session(@Req() req: AuthRequest) {
    if (req.path.startsWith("/admin/") && req.principal.pool !== "platform")
      throw new ForbiddenException();
    const { subject, ...user } = req.principal;
    return user;
  }
  @RequireAccess(["company_admin", "company_user"])
  @Post("change-password")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async changePassword(
    @Body() body: ChangeOwnerPasswordDto,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (req.path.startsWith("/admin/")) throw new ForbiddenException();
    const employee = req.principal.pool === "company_user";
    await (
      employee
        ? this.sessions.changeEmployeePassword.bind(this.sessions)
        : this.sessions.changeOwnerPassword.bind(this.sessions)
    )(req.principal, body.currentPassword, body.newPassword);
    const next = await (
      employee
        ? this.sessions.loginEmployee.bind(this.sessions)
        : this.sessions.loginOwner.bind(this.sessions)
    )(req.principal.email, body.newPassword, false, req.ip ?? "unknown");
    res.cookie(this.name, next.token, {
      httpOnly: true,
      secure: this.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
    return { status: "password_changed" };
  }
  @Public() @Post("logout") @HttpCode(200) async logout(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = sessionCookie(req);
    if (token && !token.startsWith("c_")) {
      try {
        const principal = await this.sessions.resolve(token);
        if (principal.pool === "platform")
          await this.workspace.endAllFor(principal.id);
      } catch {}
    }
    await this.sessions.logout(token);
    res.clearCookie(this.name, {
      httpOnly: true,
      secure: this.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
    res.clearCookie(this.workspaceName, {
      httpOnly: true,
      secure: this.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
    return { status: "signed_out" };
  }
}
