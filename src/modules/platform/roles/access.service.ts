import {
  Injectable,
  ForbiddenException,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
  HttpException,
} from "@nestjs/common";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { CacheService } from "../../../infrastructure/cache/cache.module.js";
import { hashPassword, verifyPassword } from "../../../common/auth/password.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
import { PERMISSIONS } from "./permissions.js";
import type {
  AdminAuth,
  AdminVersion,
  InviteAdmin,
  AssignRole,
  UserStatus,
  NewRole,
  PermissionChange,
  ActivateAdmin,
} from "./access.dto.js";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
@Injectable()
export class PlatformAccessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly cache: CacheService,
  ) {}
  async roles() {
    return this.db.platform(async (c) => ({
      permissions: PERMISSIONS,
      roles: (
        await c.query(
          `SELECT r.*,count(u.id)::int AS members FROM platform.roles r LEFT JOIN platform.users u ON u.role_id=r.id WHERE r.archived_at IS NULL GROUP BY r.id ORDER BY CASE r.key WHEN 'super_admin' THEN 0 WHEN 'platform_admin' THEN 1 WHEN 'support_admin' THEN 2 WHEN 'billing_admin' THEN 3 ELSE 4 END,r.key`,
        )
      ).rows.map((r) => ({
        key: r.key,
        nameEn: r.name.en,
        nameAr: r.name.ar,
        locked: r.key === "super_admin",
        system: r.system,
        members: r.members,
        permissions: r.permissions,
        version: r.version,
      })),
    }));
  }
  async users(page = 1, limit = 100) {
    return this.db.platform(async (c) => ({
      items: (
        await c.query(
          `SELECT u.id,u.name,u.email,u.status,u.version,u.last_login_at,r.key AS role,r.name AS role_name,EXISTS(SELECT 1 FROM platform.credentials p WHERE p.user_id=u.id) AS credential_exists,(SELECT count(*)::int FROM platform.sessions s WHERE s.user_id=u.id AND s.expires_at>now()) AS sessions FROM platform.users u JOIN platform.roles r ON r.id=u.role_id ORDER BY u.created_at,u.id LIMIT $1 OFFSET $2`,
          [limit, (page - 1) * limit],
        )
      ).rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        roleEn: u.role_name.en,
        roleAr: u.role_name.ar,
        status: u.status,
        version: u.version,
        lastLogin: u.last_login_at,
        mfaEnabled: null,
        activeSessions: u.sessions,
        credentialExists: u.credential_exists,
      })),
      total: (await c.query("SELECT count(*)::int AS n FROM platform.users"))
        .rows[0].n,
      mfaSupported: false,
    }));
  }
  async event(
    c: PoolClient,
    actor: string,
    action: string,
    type: string,
    id: string,
    after: Record<string, unknown>,
  ) {
    await recordPlatformEvent(c, {
      actorId: actor,
      action,
      resourceType: type,
      resourceId: id,
      after,
      payload: { action, resourceId: id },
    });
  }
  async write<T>(
    actor: string,
    input: AdminAuth,
    work: (c: PoolClient) => Promise<T>,
  ) {
    if (!(await this.cache.consume("platform-access:reauth:" + actor, 30, 900)))
      throw new HttpException(
        "Too many verification attempts. Try again later.",
        429,
      );
    return this.db.platform(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(80425109)");
      const a = (
        await c.query(
          "SELECT u.status,r.key,p.password_hash FROM platform.users u JOIN platform.roles r ON r.id=u.role_id JOIN platform.credentials p ON p.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u",
          [actor],
        )
      ).rows[0];
      if (!a || a.status !== "active" || a.key !== "super_admin")
        throw new ForbiddenException(
          "Only an active Super Admin can change platform access",
        );
      if (!(await verifyPassword(input.password, a.password_hash)))
        throw new UnauthorizedException("Password verification failed");
      return work(c);
    });
  }
  async role(c: PoolClient, key: string) {
    const r = (
      await c.query(
        "SELECT * FROM platform.roles WHERE key=$1 AND archived_at IS NULL FOR UPDATE",
        [key],
      )
    ).rows[0];
    if (!r) throw new NotFoundException("Role not found");
    return r;
  }
  async user(c: PoolClient, id: string, version: number) {
    const u = (
      await c.query(
        "SELECT u.*,r.key AS role FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE u.id=$1 FOR UPDATE OF u",
        [id],
      )
    ).rows[0];
    if (!u) throw new NotFoundException("Administrator not found");
    if (u.version !== version)
      throw new ConflictException("Administrator changed. Refresh first.");
    return u;
  }
  async issue(c: PoolClient, userId: string, actor: string) {
    const token = randomBytes(32).toString("hex");
    await c.query(
      "UPDATE platform.admin_invitations SET revoked_at=now() WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
      [userId],
    );
    const r = (
      await c.query(
        "INSERT INTO platform.admin_invitations(user_id,digest,created_by,expires_at) VALUES ($1,$2,$3,now()+interval '24 hours') RETURNING expires_at",
        [userId, digest(token), actor],
      )
    ).rows[0];
    return { token, expiresAt: r.expires_at, delivery: "manual" };
  }
  async invite(input: InviteAdmin, actor: string) {
    return this.write(actor, input, async (c) => {
      const role = await this.role(c, input.role);
      if (role.key === "super_admin")
        throw new BadRequestException(
          "Super Admin provisioning is a separate owner operation",
        );
      if (
        (
          await c.query(
            "SELECT 1 FROM platform.users WHERE email=$1 UNION ALL SELECT 1 FROM platform.company_owner_accounts WHERE email=$1 UNION ALL SELECT 1 FROM platform.company_employee_accounts WHERE email=$1",
            [input.email],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Email already exists. Use reissue for a pending invitation",
        );
      const u = (
        await c.query(
          "INSERT INTO platform.users(name,email,role_id,status) VALUES ($1,$2,$3,'invited') RETURNING id",
          [input.name, input.email, role.id],
        )
      ).rows[0];
      const invitation = await this.issue(c, u.id, actor);
      await this.event(
        c,
        actor,
        "platform_user.invited",
        "platform_user",
        u.id,
        { role: role.key, reason: input.reason },
      );
      return { id: u.id, ...invitation };
    }).catch((e: unknown) => {
      if ((e as { code?: string }).code === "23505")
        throw new ConflictException("Email already belongs to an account");
      throw e;
    });
  }
  async reissue(id: string, input: AdminVersion, actor: string) {
    return this.write(actor, input, async (c) => {
      const u = await this.user(c, id, input.version);
      if (u.status !== "invited")
        throw new ConflictException("Only pending invitations can be reissued");
      const r = await this.issue(c, id, actor);
      await c.query(
        "UPDATE platform.users SET version=version+1,updated_at=now() WHERE id=$1",
        [id],
      );
      await this.event(
        c,
        actor,
        "platform_user.invitation_reissued",
        "platform_user",
        id,
        { reason: input.reason },
      );
      return { id, ...r };
    });
  }
  async assign(id: string, input: AssignRole, actor: string) {
    return this.write(actor, input, async (c) => {
      const u = await this.user(c, id, input.version);
      if (id === actor || u.role === "super_admin")
        throw new ConflictException(
          "Your account and Super Admin accounts are protected",
        );
      const r = await this.role(c, input.role);
      if (r.key === "super_admin")
        throw new ConflictException(
          "Super Admin provisioning is a separate owner operation",
        );
      await c.query(
        "UPDATE platform.users SET role_id=$2,version=version+1,updated_at=now() WHERE id=$1",
        [id, r.id],
      );
      await c.query("DELETE FROM platform.sessions WHERE user_id=$1", [id]);
      await this.event(
        c,
        actor,
        "platform_user.role_changed",
        "platform_user",
        id,
        { role: r.key, reason: input.reason },
      );
      return { status: "updated" };
    });
  }
  async status(id: string, input: UserStatus, actor: string) {
    return this.write(actor, input, async (c) => {
      const u = await this.user(c, id, input.version);
      if (id === actor || u.role === "super_admin")
        throw new ConflictException(
          "Your account and Super Admin accounts are protected",
        );
      if (input.status === "active" && u.status !== "disabled")
        throw new ConflictException(
          "Invited accounts must complete activation",
        );
      const next =
        input.status === "disabled"
          ? "disabled"
          : (u.disabled_from ?? "invited");
      await c.query(
        "UPDATE platform.users SET status=$2,disabled_from=CASE WHEN $2='disabled' THEN coalesce(disabled_from,status) ELSE NULL END,version=version+1,updated_at=now() WHERE id=$1",
        [id, next],
      );
      await c.query("DELETE FROM platform.sessions WHERE user_id=$1", [id]);
      await c.query(
        "UPDATE platform.admin_invitations SET revoked_at=now() WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
        [id],
      );
      await this.event(
        c,
        actor,
        "platform_user.status_changed",
        "platform_user",
        id,
        { status: next, reason: input.reason },
      );
      return { status: next };
    });
  }
  async revoke(id: string, input: AdminVersion, actor: string) {
    return this.write(actor, input, async (c) => {
      await this.user(c, id, input.version);
      await c.query("DELETE FROM platform.sessions WHERE user_id=$1", [id]);
      await c.query(
        "UPDATE platform.users SET version=version+1,updated_at=now() WHERE id=$1",
        [id],
      );
      await this.event(
        c,
        actor,
        "platform_user.sessions_revoked",
        "platform_user",
        id,
        { reason: input.reason },
      );
      return { status: "revoked" };
    });
  }
  async newRole(input: NewRole, actor: string) {
    return this.write(actor, input, async (c) => {
      const key = "custom-" + randomUUID().slice(0, 12);
      const r = (
        await c.query(
          "INSERT INTO platform.roles(key,name,permissions) VALUES ($1,$2,ARRAY['co.view']) RETURNING id",
          [key, { en: input.nameEn, ar: input.nameAr }],
        )
      ).rows[0];
      await this.event(
        c,
        actor,
        "platform_role.created",
        "platform_role",
        r.id,
        {
          key,
          name: { en: input.nameEn, ar: input.nameAr },
          reason: input.reason,
        },
      );
      return { key };
    });
  }
  async permission(key: string, input: PermissionChange, actor: string) {
    return this.write(actor, input, async (c) => {
      const r = await this.role(c, key);
      if (r.key === "super_admin")
        throw new ConflictException("Super Admin permissions are locked");
      if (r.version !== input.version)
        throw new ConflictException("Role changed. Refresh first.");
      if (!PERMISSIONS.some((p) => p.key === input.permission))
        throw new BadRequestException("Unknown permission");
      const permissions = new Set<string>(r.permissions);
      if (input.enabled) permissions.add(input.permission);
      else permissions.delete(input.permission);
      await c.query(
        "UPDATE platform.roles SET permissions=$2,version=version+1 WHERE id=$1",
        [r.id, [...permissions]],
      );
      await this.event(
        c,
        actor,
        "platform_role.permission_changed",
        "platform_role",
        r.id,
        {
          key,
          permission: input.permission,
          enabled: input.enabled,
          reason: input.reason,
        },
      );
      return { status: "updated" };
    });
  }
  async archive(key: string, input: AdminVersion, actor: string) {
    return this.write(actor, input, async (c) => {
      const r = await this.role(c, key);
      if (r.system)
        throw new ConflictException("Built-in roles cannot be archived");
      if (r.version !== input.version)
        throw new ConflictException("Role changed. Refresh first.");
      if (
        (
          await c.query(
            "SELECT 1 FROM platform.users WHERE role_id=$1 LIMIT 1",
            [r.id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Reassign every member before archiving this role",
        );
      await c.query(
        "UPDATE platform.roles SET archived_at=now(),version=version+1 WHERE id=$1",
        [r.id],
      );
      await this.event(
        c,
        actor,
        "platform_role.archived",
        "platform_role",
        r.id,
        { key, reason: input.reason },
      );
      return { status: "archived" };
    });
  }
  async activate(input: ActivateAdmin, ip: string) {
    if (
      !(await this.cache.consume(
        "platform-access:activate:" + digest(ip),
        20,
        900,
      ))
    )
      throw new HttpException("Too many attempts", 429);
    if (!/^[a-f0-9]{64}$/.test(input.token))
      throw new BadRequestException("Invitation invalid or expired");
    const ref = await this.db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT i.id FROM platform.admin_invitations i JOIN platform.users u ON u.id=i.user_id WHERE i.digest=$1 AND i.expires_at>now() AND i.used_at IS NULL AND i.revoked_at IS NULL AND u.status='invited'",
            [digest(input.token)],
          )
        ).rows[0],
    );
    if (!ref) throw new BadRequestException("Invitation invalid or expired");
    const hash = await hashPassword(input.password);
    return this.db.platform(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(80425109)");
      const i = (
        await c.query(
          "SELECT i.*,u.status FROM platform.admin_invitations i JOIN platform.users u ON u.id=i.user_id WHERE i.digest=$1 FOR UPDATE OF i,u",
          [digest(input.token)],
        )
      ).rows[0];
      if (
        !i ||
        i.status !== "invited" ||
        i.used_at ||
        i.revoked_at ||
        new Date(i.expires_at).getTime() <= Date.now()
      )
        throw new BadRequestException("Invitation invalid or expired");
      await c.query(
        "INSERT INTO platform.credentials(user_id,password_hash) VALUES ($1,$2)",
        [i.user_id, hash],
      );
      await c.query(
        "UPDATE platform.users SET status='active',version=version+1,updated_at=now() WHERE id=$1",
        [i.user_id],
      );
      await c.query(
        "UPDATE platform.admin_invitations SET used_at=now() WHERE id=$1",
        [i.id],
      );
      await this.event(
        c,
        i.user_id,
        "platform_user.activated",
        "platform_user",
        i.user_id,
        {},
      );
      return { status: "activated" };
    });
  }
}
