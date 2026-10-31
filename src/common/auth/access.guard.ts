import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ACCESS, type Access, type Principal } from "./access.js";
import { SessionService } from "./session.service.js";
import { WorkspaceService } from "../../modules/platform/workspace/workspace.service.js";
export type AuthRequest = Request & { principal: Principal };
function cookieNamed(req: Request, ...names: string[]): string {
  const parts = req.headers.cookie?.split(";").map((s) => s.trim()) ?? [];
  for (const name of names) {
    const hit = parts.find((s) => s.startsWith(name + "="));
    if (hit) return hit.split("=")[1] ?? "";
  }
  return "";
}
export function sessionCookie(req: Request): string {
  return cookieNamed(req, "__Host-mujez_session", "mujez_session");
}
export function workspaceCookie(req: Request): string {
  return cookieNamed(req, "__Host-mujez_workspace", "mujez_workspace");
}
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    @Optional() private readonly workspace?: WorkspaceService,
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
    let principal = await this.sessions.resolve(token);
    if (
      principal.pool === "platform" &&
      !req.path.startsWith("/admin/") &&
      access.pools.includes("company_admin") &&
      this.workspace
    ) {
      const wsToken = workspaceCookie(req);
      const wsPrincipal = wsToken
        ? await this.workspace.resolve(wsToken, principal)
        : null;
      if (wsPrincipal) principal = wsPrincipal;
    }
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
    if (
      principal.workspace?.mode === "read" &&
      !SAFE_METHODS.has(req.method) &&
      !req.path.includes("/workspace-session/")
    )
      throw new ForbiddenException({
        code: "read_only_session",
        message: "This is a read-only workspace session.",
      });
    req.principal = principal;
    return true;
  }
}
