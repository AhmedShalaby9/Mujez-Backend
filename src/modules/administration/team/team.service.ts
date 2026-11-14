import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Principal } from "../../../common/auth/access.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { SalesService } from "../../sales/leads/sales.service.js";
import { hashPassword } from "../../../common/auth/password.js";
import { recordTenantEvent } from "../../../infrastructure/outbox/domain-events.js";
import type {
  TeamInvite,
  TeamStatus,
  TeamActivate,
  TeamRole,
  SalesTeamInput,
  SalesTeamUpdate,
} from "./team.dto.js";
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
    teamId: r.team_id ?? null,
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
            `SELECT u.id AS user_id,u.team_id,u.last_login_at,r.key AS role_key,r.name AS role_name FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.id=ANY($2::uuid[])`,
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
  private async lock(c: PoolClient, companyId: string) {
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,80425140))",
      [companyId],
    );
  }
  private async roleId(c: PoolClient, companyId: string, role: TeamRole) {
    const permissions = [
      "leads.read",
      "leads.manage",
      "pipeline.read",
      "pipeline.manage",
      "contacts.read",
      "contacts.manage",
      "calendar.read",
      "calendar.manage",
      "tasks.read",
      "tasks.manage",
      "projects.read",
      "units.read",
      "reservations.read",
      "reservations.manage",
      "contracts.read",
      "contracts.manage",
      "commissions.read",
      "documents.read",
      "documents.manage",
    ];
    if (role === "team_lead") permissions.push("team.self.read");
    await c.query(
      `INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES($1,$2,$3,$4,'own') ON CONFLICT(company_id,key) DO NOTHING`,
      [
        companyId,
        role,
        role === "team_lead"
          ? { en: "Team Lead", ar: "قائد الفريق" }
          : { en: "Sales Agent", ar: "وكيل المبيعات" },
        permissions,
      ],
    );
    return (
      await c.query(
        "SELECT id FROM tenant.roles WHERE company_id=$1 AND key=$2",
        [companyId, role],
      )
    ).rows[0].id;
  }
  async changeRole(p: Principal, accountId: string, role: TeamRole) {
    await this.sales.access(p, "team.manage");
    const account = (
      await this.db.platform((c) =>
        c.query(
          "SELECT user_id FROM platform.company_employee_accounts WHERE company_id=$1 AND id=$2",
          [p.companyId, accountId],
        ),
      )
    ).rows[0];
    if (!account) throw new NotFoundException("Employee not found");
    return this.db.tenant(p.companyId!, async (c) => {
      await this.lock(c, p.companyId!);
      const user = (
        await c.query(
          "SELECT u.*,r.key AS role FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.id=$2 AND u.identity_pool='company_user' AND u.deleted_at IS NULL FOR UPDATE OF u",
          [p.companyId, account.user_id],
        )
      ).rows[0];
      if (!user) throw new NotFoundException("Employee not found");
      if (
        role !== "team_lead" &&
        (
          await c.query(
            "SELECT 1 FROM tenant.teams WHERE company_id=$1 AND lead_user_id=$2",
            [p.companyId, user.id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Assign another team lead before changing this role.",
        );
      if (user.role === role) return { status: "unchanged" };
      const roleId = await this.roleId(c, p.companyId!, role);
      await c.query(
        "UPDATE tenant.users SET role_id=$3,updated_at=now(),updated_by=$4 WHERE company_id=$1 AND id=$2",
        [p.companyId, user.id, roleId, p.id],
      );
      await recordTenantEvent(c, {
        companyId: p.companyId!,
        actorId: p.id,
        action: "employee.role_changed",
        resourceType: "user",
        resourceId: user.id,
        before: { role: user.role },
        after: { role },
        payload: { role },
      });
      return { status: "updated", role };
    });
  }
  private async readGroups(c: PoolClient, companyId: string, leadId?: string) {
    const teams = (
      await c.query(
        `SELECT t.id,t.name,t.lead_user_id,t.version,t.created_at,t.updated_at FROM tenant.teams t WHERE t.company_id=$1 ${leadId ? "AND t.lead_user_id=$2" : ""} ORDER BY t.name,t.id`,
        leadId ? [companyId, leadId] : [companyId],
      )
    ).rows;
    if (!teams.length) return { items: [] };
    const members = (
      await c.query(
        `SELECT u.id,u.team_id,u.name,u.email,u.status,r.key AS role FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.team_id=ANY($2::uuid[]) AND u.deleted_at IS NULL ORDER BY u.name,u.id`,
        [companyId, teams.map((t) => t.id)],
      )
    ).rows;
    return {
      items: teams.map((t) => ({
        id: t.id,
        name: t.name,
        leadUserId: t.lead_user_id,
        version: t.version,
        createdAt: iso(t.created_at),
        updatedAt: iso(t.updated_at),
        members: members
          .filter((m) => m.team_id === t.id)
          .map((m) => ({
            id: m.id,
            name: m.name,
            email: m.email,
            status: m.status,
            role: m.role,
          })),
      })),
    };
  }
  async groups(p: Principal) {
    await this.sales.access(p, "team.read");
    return this.db.tenant(
      p.companyId!,
      (c) => this.readGroups(c, p.companyId!),
      true,
    );
  }
  async myTeam(p: Principal) {
    await this.sales.access(p, "team.self.read");
    if (p.pool !== "company_user" || p.role !== "team_lead")
      throw new ForbiddenException();
    return this.db.tenant(
      p.companyId!,
      (c) => this.readGroups(c, p.companyId!, p.id),
      true,
    );
  }
  async saveGroup(
    p: Principal,
    input: SalesTeamInput | SalesTeamUpdate,
    id?: string,
  ) {
    await this.sales.access(p, "team.manage");
    // Validate account lifecycle as well as the tenant identity; revoked invitations
    // must not be assignable even when their tenant row still says invited.
    const eligible = new Set(
      (await this.list(p)).items
        .filter((m) => ["invited", "active"].includes(m.status))
        .map((m) => m.userId),
    );
    const ids = [...new Set([input.leadUserId, ...input.memberUserIds])];
    if (ids.some((x) => !eligible.has(x)))
      throw new BadRequestException(
        "Choose active or invited employees from this company.",
      );
    return this.db.tenant(p.companyId!, async (c) => {
      await this.lock(c, p.companyId!);
      const before = id
        ? (
            await c.query(
              "SELECT * FROM tenant.teams WHERE company_id=$1 AND id=$2 FOR UPDATE",
              [p.companyId, id],
            )
          ).rows[0]
        : null;
      if (id && !before) throw new NotFoundException("Team not found");
      if (before && before.version !== (input as SalesTeamUpdate).version)
        throw new ConflictException("Team changed. Refresh before saving.");
      const members = (
        await c.query(
          `SELECT u.id,u.team_id,u.status,r.key AS role FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.id=ANY($2::uuid[]) AND u.identity_pool='company_user' AND u.deleted_at IS NULL FOR UPDATE OF u`,
          [p.companyId, ids],
        )
      ).rows;
      if (
        members.length !== ids.length ||
        members.some(
          (m) =>
            !["agent", "team_lead"].includes(m.role) ||
            !["active", "invited"].includes(m.status),
        )
      )
        throw new BadRequestException(
          "Choose sales agents or team leads from this company.",
        );
      if (members.some((m) => m.team_id && m.team_id !== id))
        throw new ConflictException(
          "A member already belongs to another team. Remove them from that team first.",
        );
      if (
        (
          await c.query(
            "SELECT 1 FROM tenant.teams WHERE company_id=$1 AND lead_user_id=$2 AND ($3::uuid IS NULL OR id<>$3)",
            [p.companyId, input.leadUserId, id ?? null],
          )
        ).rowCount
      )
        throw new ConflictException(
          "This employee already leads another team.",
        );
      if (
        (
          await c.query(
            "SELECT 1 FROM tenant.teams WHERE company_id=$1 AND lower(name)=lower($2) AND ($3::uuid IS NULL OR id<>$3)",
            [p.companyId, input.name, id ?? null],
          )
        ).rowCount
      )
        throw new ConflictException("A team with this name already exists.");
      const team = id
        ? (
            await c.query(
              "UPDATE tenant.teams SET name=$3,lead_user_id=$4,version=version+1,updated_at=now(),updated_by=$5 WHERE company_id=$1 AND id=$2 RETURNING id,version",
              [p.companyId, id, input.name, input.leadUserId, p.id],
            )
          ).rows[0]
        : (
            await c.query(
              "INSERT INTO tenant.teams(company_id,name,lead_user_id,created_by,updated_by) VALUES($1,$2,$3,$4,$4) RETURNING id,version",
              [p.companyId, input.name, input.leadUserId, p.id],
            )
          ).rows[0];
      await c.query(
        "UPDATE tenant.users SET team_id=NULL,updated_at=now(),updated_by=$3 WHERE company_id=$1 AND team_id=$2",
        [p.companyId, team.id, p.id],
      );
      await c.query(
        "UPDATE tenant.users SET team_id=$3,updated_at=now(),updated_by=$4 WHERE company_id=$1 AND id=ANY($2::uuid[])",
        [p.companyId, ids, team.id, p.id],
      );
      const leadRole = await this.roleId(c, p.companyId!, "team_lead");
      const previousRole = members.find((m) => m.id === input.leadUserId)!.role;
      await c.query(
        "UPDATE tenant.users SET role_id=$3 WHERE company_id=$1 AND id=$2",
        [p.companyId, input.leadUserId, leadRole],
      );
      if (previousRole !== "team_lead")
        await recordTenantEvent(c, {
          companyId: p.companyId!,
          actorId: p.id,
          action: "employee.role_changed",
          resourceType: "user",
          resourceId: input.leadUserId,
          before: { role: previousRole },
          after: { role: "team_lead" },
          payload: { role: "team_lead" },
        });
      await recordTenantEvent(c, {
        companyId: p.companyId!,
        actorId: p.id,
        action: id ? "team.updated" : "team.created",
        resourceType: "team",
        resourceId: team.id,
        before: before
          ? { name: before.name, leadUserId: before.lead_user_id }
          : undefined,
        after: {
          name: input.name,
          leadUserId: input.leadUserId,
          memberUserIds: ids,
        },
        payload: { version: team.version },
      });
      return team;
    });
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
