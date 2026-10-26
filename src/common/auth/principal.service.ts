import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import type { Principal } from "./access.js";
import type { VerifiedIdentity } from "./token-verifier.service.js";
@Injectable()
export class PrincipalService {
  constructor(private readonly db: DatabaseService) {}
  async resolve(identity: VerifiedIdentity): Promise<Principal> {
    const { pool, claims } = identity;
    if (pool === "platform") {
      if (
        !Array.isArray(claims.amr) ||
        !claims.amr.some((v) => v === "mfa" || v === "otp")
      )
        throw new ForbiddenException({
          code: "mfa_required",
          message: "Platform access requires MFA",
        });
      return this.db.platform(async (c) => {
        const { rows } = await c.query(
          `SELECT u.id, u.name, u.email, r.key AS role, r.permissions FROM platform.users u JOIN platform.roles r ON r.id = u.role_id WHERE u.oidc_subject = $1 AND u.status = 'active'`,
          [claims.sub],
        );
        const row = rows[0];
        if (!row || !/^[^@]+@mujez\.io$/i.test(row.email))
          throw new UnauthorizedException();
        return { ...row, subject: claims.sub!, pool, scope: "platform" };
      });
    }
    const companyId = claims.company_id;
    if (
      typeof companyId !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(companyId)
    )
      throw new UnauthorizedException();
    const active = await this.db.platform(async (c) => {
      const result = await c.query(
        `SELECT 1 FROM platform.companies WHERE id = $1 AND status IN ('active', 'trial')`,
        [companyId],
      );
      return result.rowCount === 1;
    });
    if (!active)
      throw new ForbiddenException({
        code: "company_unavailable",
        message: "Company access is unavailable",
      });
    return this.db.tenant(companyId, async (c) => {
      const { rows } = await c.query(
        `SELECT u.id, u.name, u.email, u.team_id AS "teamId", r.key AS role, r.permissions, r.scope FROM tenant.users u JOIN tenant.roles r ON r.id = u.role_id AND r.company_id = u.company_id WHERE u.oidc_subject = $1 AND u.identity_pool = $2 AND u.status = 'active' AND u.deleted_at IS NULL`,
        [claims.sub, pool],
      );
      const row = rows[0];
      if (!row || (pool === "company_user" && row.role === "company_admin"))
        throw new UnauthorizedException();
      return { ...row, subject: claims.sub!, pool, companyId };
    });
  }
}
