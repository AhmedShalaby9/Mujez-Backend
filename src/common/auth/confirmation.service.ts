import {
  Injectable,
  ForbiddenException,
  UnauthorizedException,
  HttpException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { CacheService } from "../../infrastructure/cache/cache.module.js";
import { verifyPassword } from "./password.js";
@Injectable()
export class ConfirmationService {
  constructor(private readonly cache: CacheService) {}
  async rate(actor: string) {
    if (!(await this.cache.consume("configuration:reauth:" + actor, 30, 900)))
      throw new HttpException("Too many verification attempts", 429);
  }
  async verify(
    c: PoolClient,
    actor: string,
    password: string,
    permission: string,
    superOnly = false,
  ) {
    const u = (
      await c.query(
        "SELECT u.status,r.key,r.permissions,p.password_hash FROM platform.users u JOIN platform.roles r ON r.id=u.role_id JOIN platform.credentials p ON p.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u",
        [actor],
      )
    ).rows[0];
    if (
      !u ||
      u.status !== "active" ||
      !u.permissions.includes(permission) ||
      (superOnly && u.key !== "super_admin")
    )
      throw new ForbiddenException();
    if (!(await verifyPassword(password, u.password_hash)))
      throw new UnauthorizedException("Password confirmation failed");
  }
}
