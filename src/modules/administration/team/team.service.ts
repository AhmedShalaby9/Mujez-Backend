import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { SalesService } from "../../sales/leads/sales.service.js";
import { hashPassword } from "../../../common/auth/password.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import type { TeamInvite, TeamStatus, TeamActivate } from "./team.dto.js";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (v: any) => (v ? new Date(v).toISOString() : null);
function memberDto(r: any) {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role_key,
    roleName: r.role_name,
    status: r.status,
    invitationExpiresAt: iso(r.invitation_expires_at),
    lastLoginAt: iso(r.last_login_at),
    createdAt: iso(r.created_at),
  };
}
/** Team accounts live in `platform.*` (the same shared login-email namespace
 * as company_owner), on a separate connection pool/role from tenant data, so
 * these mutations cannot share the tenant.sales_requests idempotency ledger
 * the rest of the CRM uses -- this advisory lock is the only guard against
 * concurrent invites/status changes for the same company. */
@Injectable()
export class TeamService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
  ) {}
  async list(p: Principal) {
    await this.sales.access(p, "team.read");
    const accounts = await this.db.platform(
      async (c) =>
        (
          await c.query(
            `SELECT a.id,a.user_id,a.name,a.email,a.status,a.created_at,(SELECT expires_at FROM platform.company_employee_invitations i WHERE i.account_id=a.id AND i.used_at IS NULL AND i.revoked_at IS NULL ORDER BY created_at DESC LIMIT 1) AS invitation_expires_at FROM platform.company_employee_accounts a WHERE a.company_id=$1 ORDER BY a.created_at DESC,a.id`,
            [p.companyId],
          )
        ).rows,
    );
    if (!accounts.length) return { items: [] };
    const roles = await this.db.tenant(
      p.companyId!,
      async (c) =>
        (
          await c.query(
            `SELECT u.id AS user_id,u.last_login_at,r.key AS role_key,r.name AS role_name FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.id=ANY($2::uuid[])`,
            [p.companyId, accounts.map((a) => a.user_id)],
          )
        ).rows,
    );
    const byUser = new Map(roles.map((r) => [r.user_id, r]));
    return {
      items: accounts.map((a) =>
        memberDto({ ...a, ...(byUser.get(a.user_id) ?? {}) }),
      ),
    };
  }
  async invite(p: Principal, input: TeamInvite) {
    await this.sales.access(p, "team.manage");
    return this.db
      .platform(async (c) => {
        await c.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,80425114))",
          ["team:" + p.companyId],
        );
        if (
          (
            await c.query(
              "SELECT 1 FROM platform.users WHERE email=$1 UNION ALL SELECT 1 FROM platform.company_owner_accounts WHERE email=$1 UNION ALL SELECT 1 FROM platform.company_employee_accounts WHERE email=$1",
              [input.email.toLowerCase()],
            )
          ).rowCount
        )
          throw new ConflictException(
            "Email already belongs to an account. Use a different email.",
          );
        const accountId = (
          await c.query(
            "SELECT platform.provision_company_employee($1,$2,$3,$4) AS id",
            [p.companyId, input.name, input.email.toLowerCase(), input.role],
          )
        ).rows[0].id;
        const token = randomBytes(32).toString("hex"),
          expiresAt = (
            await c.query(
              `INSERT INTO platform.company_employee_invitations(account_id,digest,created_by,expires_at) VALUES($1,$2,$3,now()+interval '24 hours') RETURNING expires_at`,
              [accountId, digest(token), p.id],
            )
          ).rows[0].expires_at;
        return {
          status: "invited",
          accountId,
          token,
          expiresAt,
          email: input.email.toLowerCase(),
        };
      })
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === "23505")
          throw new ConflictException(
            "Email already belongs to an account. Refresh and try again.",
          );
        throw e;
      });
  }
  async resend(p: Principal, accountId: string) {
    await this.sales.access(p, "team.manage");
    return this.db.platform(async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,80425114))",
        ["team:" + p.companyId],
      );
      const a = (
        await c.query(
          "SELECT * FROM platform.company_employee_accounts WHERE id=$1 AND company_id=$2 FOR UPDATE",
          [accountId, p.companyId],
        )
      ).rows[0];
      if (!a || a.status !== "invited")
        throw new ConflictException("Only a pending invitation can be resent.");
      await c.query(
        "UPDATE platform.company_employee_invitations SET revoked_at=now() WHERE account_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
        [a.id],
      );
      const token = randomBytes(32).toString("hex"),
        expiresAt = (
          await c.query(
            `INSERT INTO platform.company_employee_invitations(account_id,digest,created_by,expires_at) VALUES($1,$2,$3,now()+interval '24 hours') RETURNING expires_at`,
            [a.id, digest(token), p.id],
          )
        ).rows[0].expires_at;
      return {
        status: "invited",
        accountId: a.id,
        token,
        expiresAt,
        email: a.email,
      };
    });
  }
  async revoke(p: Principal, accountId: string) {
    await this.sales.access(p, "team.manage");
    return this.db.platform(async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,80425114))",
        ["team:" + p.companyId],
      );
      const a = (
        await c.query(
          "SELECT * FROM platform.company_employee_accounts WHERE id=$1 AND company_id=$2 FOR UPDATE",
          [accountId, p.companyId],
        )
      ).rows[0];
      if (!a) throw new NotFoundException("Team member not found");
      if (a.status !== "invited")
        throw new ConflictException(
          "Only a pending invitation can be revoked.",
        );
      await c.query(
        "UPDATE platform.company_employee_invitations SET revoked_at=now() WHERE account_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
        [a.id],
      );
      await c.query(
        "UPDATE platform.company_employee_accounts SET status='disabled' WHERE id=$1",
        [a.id],
      );
      return { status: "revoked" };
    });
  }
  async status(p: Principal, accountId: string, input: TeamStatus) {
    await this.sales.access(p, "team.manage");
    return this.db.platform(async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,80425114))",
        ["team:" + p.companyId],
      );
      const a = (
        await c.query(
          "SELECT * FROM platform.company_employee_accounts WHERE id=$1 AND company_id=$2 FOR UPDATE",
          [accountId, p.companyId],
        )
      ).rows[0];
      if (!a) throw new NotFoundException("Team member not found");
      if (!["active", "disabled"].includes(a.status))
        throw new ConflictException(
          "Only an active or disabled member can change status.",
        );
      const next = input.action === "disable" ? "disabled" : "active";
      if (a.status === next)
        throw new ConflictException("Member already has that status.");
      await c.query(
        "UPDATE platform.company_employee_accounts SET status=$2 WHERE id=$1",
        [a.id, next],
      );
      if (next === "disabled")
        await c.query(
          "DELETE FROM platform.company_employee_sessions WHERE account_id=$1",
          [a.id],
        );
      await this.db.tenant(p.companyId!, async (tc) => {
        await tc.query(
          "UPDATE tenant.users SET status=$3,updated_at=now() WHERE company_id=$1 AND id=$2",
          [p.companyId, a.user_id, next === "disabled" ? "disabled" : "active"],
        );
        await recordTenantEvent(tc, {
          companyId: p.companyId!,
          actorId: p.id,
          action: "employee." + next,
          resourceType: "user",
          resourceId: a.user_id,
          after: { status: next },
          payload: { accountId: a.id },
        });
      });
      return { status: next };
    });
  }
  async activate(input: TeamActivate) {
    const hash = await hashPassword(input.password);
    try {
      return await this.db.platform(async (c) => {
        await c.query("SELECT platform.activate_company_employee($1,$2)", [
          digest(input.token),
          hash,
        ]);
        return { status: "activated" };
      });
    } catch (e) {
      if ((e as { code?: string }).code === "22023")
        throw new BadRequestException("Invitation invalid or expired");
      throw e;
    }
  }
}
