import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import ipaddr from "ipaddr.js";
import { ENV, type Environment } from "../../config/env.js";
import { ACCESS, type Access, type Principal } from "./access.js";
import { TokenVerifier } from "./token-verifier.service.js";
import { PrincipalService } from "./principal.service.js";
export type AuthRequest = Request & { principal: Principal };
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly principals: PrincipalService,
    @Inject(ENV) private readonly env: Environment,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<Access>(ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (access && "public" in access) return true;
    if (!access)
      throw new ForbiddenException({
        code: "access_unconfigured",
        message: "Access is not configured for this operation",
      });
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const bearer =
      request.headers.authorization?.match(/^Bearer ([^ ]+)$/i)?.[1];
    if (!bearer) throw new UnauthorizedException();
    const identity = await this.verifier.verify(bearer, access.pools);
    // Reject a verifier result from another pool even if a custom verifier is injected.
    if (!access.pools.includes(identity.pool))
      throw new ForbiddenException({
        code: "identity_pool_denied",
        message: "Identity pool is not permitted",
      });
    if (identity.pool === "platform" && !this.allowedIp(request.ip))
      throw new ForbiddenException({
        code: "ip_not_allowed",
        message: "Platform access is unavailable from this address",
      });
    const principal = await this.principals.resolve(identity);
    if (access.permission && !principal.permissions.includes(access.permission))
      throw new ForbiddenException({
        code: "permission_denied",
        message: `Permission denied — requires “${access.permission}”`,
        permission: access.permission,
      });
    request.principal = principal;
    return true;
  }
  private allowedIp(raw: string | undefined): boolean {
    try {
      const address = ipaddr.process(raw ?? "");
      return this.env.PLATFORM_IP_ALLOWLIST.split(",").some((range) => {
        const cidr = ipaddr.parseCIDR(range.trim());
        return address.kind() === cidr[0].kind() && address.match(cidr);
      });
    } catch {
      return false;
    }
  }
}
