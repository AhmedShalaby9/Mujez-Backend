import { syncTeamReporting } from "../../hr/team-reporting.js";
import {
  COMPANY_ROLE_FIELDS,
  COMPANY_ROLE_DEFINITIONS,
  ASSIGNABLE_COMPANY_ROLES,
  OFFICE_SALES_ROLES,
  TEAM_MEMBER_ROLES,
  primaryCompanyRole,
  isTeamLeadRole,
} from "../../../common/auth/company-roles.js";
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
    roles: r.roles ?? [r.role_key],
    rolesVersion: r.roles_version ?? 0,
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
            `SELECT u.id AS user_id,u.team_id,u.last_login_at,r.key AS role_key,r.name AS role_name,${COMPANY_ROLE_FIELDS} FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.id=ANY($2::uuid[])`,
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
    const definition = COMPANY_ROLE_DEFINITIONS[role];
    await c.query(
      `INSERT INTO tenant.roles(company_id,key,name,permissions,scope) VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id,key) DO NOTHING`,
      [companyId, role, definition.name, definition.permissions, definition.scope],
    );
    return (
      await c.query(
        "SELECT id FROM tenant.roles WHERE company_id=$1 AND key=$2",
        [companyId, role],
      )
    ).rows[0].id;
  }
  private owner(p: Principal) {
    if (
      p.pool !== "company_admin" ||
      p.role !== "company_owner" ||
      p.scope !== "company" ||
      p.workspace
    )
      throw new ForbiddenException("Only the company admin can assign roles");
  }
  private async officeRoles(p: Principal, roles: TeamRole[]) {
    const office = await this.db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT 1 FROM platform.companies WHERE id=$1 AND company_type='real_estate_office'",
            [p.companyId],
          )
        ).rowCount,
    );
    if (
      office &&
      (!roles.length || roles.some((r) => !OFFICE_SALES_ROLES.includes(r as any)))
    )
      throw new BadRequestException(
        "Real estate offices can assign only Sales Agent and Team Lead",
      );
    // Brokerage companies are not restricted to the new sales ladder at the
    // database/provisioning level -- 'brokerage' is this platform's default
    // company_type, used by plenty of fixtures/tests that have nothing to do
    // with the CRM sales ladder. The dashboard's employee-invite UI is where
    // brokerage companies are actually steered toward the ladder roles
    // instead of Sales Agent/Team Lead.
    return !!office;
  }
  /** The role key a team's lead_user_id is promoted to: the brokerage
   * ladder's team_leader when they're already on that ladder (or already a
   * team_leader), otherwise the legacy team_lead everyone else uses.
   * 'brokerage' is this platform's default company_type (plenty of
   * fixtures/tests use it with no connection to the CRM sales ladder), so
   * this is driven by the member's own current role, not company_type. */
  private leadRoleKey(previousRole: string): TeamRole {
    return (
      ["property_advisor", "property_consultant", "senior", "expert"].includes(
        previousRole,
      ) || previousRole === "team_leader"
    ) ? "team_leader" : "team_lead";
  }
  async changeRole(p: Principal, accountId: string, role: TeamRole) {
    return this.changeRoles(p, accountId, [role], undefined, true);
  }
  async changeRoles(
    p: Principal,
    accountId: string,
    selected: TeamRole[],
    version?: number,
    legacy = false,
  ) {
    this.owner(p);
    await this.sales.access(p, "team.manage");
    const office = await this.officeRoles(p, selected);
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
          `SELECT u.*,r.key AS role,${COMPANY_ROLE_FIELDS} FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.id=$2 AND u.identity_pool='company_user' AND u.deleted_at IS NULL FOR UPDATE OF u`,
          [p.companyId, account.user_id],
        )
      ).rows[0];
      if (!user) throw new NotFoundException("Employee not found");
      if (version !== undefined && version !== user.roles_version)
        throw new ConflictException("Roles changed. Refresh before saving.");
      const roles = [
        ...new Set([
          ...selected,
          ...(office && user.roles.includes("employee") ? ["employee"] : []),
          ...(legacy
            ? user.roles.filter(
                (r: string) => !(TEAM_MEMBER_ROLES as readonly string[]).includes(r),
              )
            : []),
        ]),
      ];
      if (
        !roles.length ||
        roles.some((r) => !ASSIGNABLE_COMPANY_ROLES.includes(r))
      )
        throw new BadRequestException("Choose supported company roles");
      const primary = primaryCompanyRole(roles);
      if (
        !roles.some(isTeamLeadRole) &&
        (
          await c.query(
            "SELECT 1 FROM tenant.teams WHERE company_id=$1 AND lead_user_id=$2",
            [p.companyId, user.id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Assign another team lead before removing the Team Lead role.",
        );
      if ([...user.roles].sort().join(",") === [...roles].sort().join(","))
        return {
          status: "unchanged",
          role: primary,
          roles: user.roles,
          rolesVersion: user.roles_version,
        };
      const roleIds = new Map<string, string>();
      for (const key of roles)
        roleIds.set(key, await this.roleId(c, p.companyId!, key));
      await c.query(
        "DELETE FROM tenant.user_additional_roles WHERE company_id=$1 AND user_id=$2",
        [p.companyId, user.id],
      );
      await c.query(
        `UPDATE tenant.users SET role_id=$3,roles_version=roles_version+1,team_id=CASE WHEN $5 THEN team_id ELSE NULL END,updated_at=now(),updated_by=$4 WHERE company_id=$1 AND id=$2`,
        [
          p.companyId,
          user.id,
          roleIds.get(primary),
          p.id,
          roles.some((r) => (TEAM_MEMBER_ROLES as readonly string[]).includes(r)),
        ],
      );
      for (const key of roles.filter((r) => r !== primary))
        await c.query(
          "INSERT INTO tenant.user_additional_roles(company_id,user_id,role_id) VALUES($1,$2,$3)",
          [p.companyId, user.id, roleIds.get(key)],
        );
      await syncTeamReporting(c, p);
      await recordTenantEvent(c, {
        companyId: p.companyId!,
        actorId: p.id,
        action: "employee.role_changed",
        resourceType: "user",
        resourceId: user.id,
        before: { role: user.role, roles: user.roles },
        after: { role: primary, roles },
        payload: { role: primary, roles },
      });
      return {
        status: "updated",
        role: primary,
        roles,
        rolesVersion: user.roles_version + 1,
      };
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
    if (p.pool !== "company_user" || !isTeamLeadRole(p.role))
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
            !(TEAM_MEMBER_ROLES as readonly string[]).includes(m.role) ||
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
      const previousRole = members.find((m) => m.id === input.leadUserId)!.role;
      const leadRoleKey = this.leadRoleKey(previousRole);
      const leadRoleId = await this.roleId(c, p.companyId!, leadRoleKey);
      if (previousRole !== leadRoleKey)
        await c.query(
          "INSERT INTO tenant.user_additional_roles(company_id,user_id,role_id) SELECT company_id,id,role_id FROM tenant.users WHERE company_id=$1 AND id=$2 ON CONFLICT DO NOTHING",
          [p.companyId, input.leadUserId],
        );
      await c.query(
        "DELETE FROM tenant.user_additional_roles WHERE company_id=$1 AND user_id=$2 AND role_id=$3",
        [p.companyId, input.leadUserId, leadRoleId],
      );
      await c.query(
        "UPDATE tenant.users SET role_id=$3,roles_version=roles_version+CASE WHEN role_id IS DISTINCT FROM $3 THEN 1 ELSE 0 END WHERE company_id=$1 AND id=$2",
        [p.companyId, input.leadUserId, leadRoleId],
      );
      if (previousRole !== leadRoleKey)
        await recordTenantEvent(c, {
          companyId: p.companyId!,
          actorId: p.id,
          action: "employee.role_changed",
          resourceType: "user",
          resourceId: input.leadUserId,
          before: { role: previousRole },
          after: { role: leadRoleKey },
          payload: { role: leadRoleKey },
        });
      await syncTeamReporting(c, p);
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
    this.owner(p);
    if ((input.role && input.roles) || (!input.role && !input.roles))
      throw new BadRequestException("Provide either role or roles");
    const roles = input.roles ?? [input.role!];
    await this.officeRoles(p, roles);
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
            "SELECT platform.provision_company_employee_roles($1,$2,$3,$4::text[],$5) AS id",
            [p.companyId, input.name, input.email.toLowerCase(), roles, p.id],
          )
        ).rows[0].id;
        const userId = (
          await c.query(
            "SELECT user_id FROM platform.company_employee_accounts WHERE id=$1",
            [accountId],
          )
        ).rows[0].user_id;
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
          userId,
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
