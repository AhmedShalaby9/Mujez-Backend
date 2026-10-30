import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ACCESS, type Access, type Principal } from "./access.js";
import { SessionService } from "./session.service.js";
export type AuthRequest = Request & { principal: Principal };
export function sessionCookie(req: Request): string {
  return (
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find(
        (s) =>
          s.startsWith("__Host-mujez_session=") ||
          s.startsWith("mujez_session="),
      )
      ?.split("=")[1] ?? ""
  );
}
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}
  async canActivate(context: ExecutionContext) {
    const access = this.reflector.getAllAndOverride<Access>(ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (access && "public" in access) return true;
    if (!access) throw new ForbiddenException();
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const token = sessionCookie(req);
    if (!token) throw new UnauthorizedException();
    const principal = await this.sessions.resolve(token);
    if (
      principal.mustChangePassword &&
      !["/api/v1/auth/session", "/api/v1/auth/change-password"].includes(
        req.path,
      )
    )
      throw new ForbiddenException({
        code: "password_change_required",
        message:
          "Change your temporary password before accessing the workspace.",
      });
    if (!access.pools.includes(principal.pool)) throw new ForbiddenException();
    if (access.permission && !principal.permissions.includes(access.permission))
      throw new ForbiddenException();
    req.principal = principal;
    return true;
  }
}
