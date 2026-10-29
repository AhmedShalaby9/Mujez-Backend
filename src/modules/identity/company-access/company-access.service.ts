import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
  HttpException,
} from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { CacheService } from "../../../infrastructure/cache/cache.module.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
import { hashPassword, verifyPassword } from "../../../common/auth/password.js";
import type {
  OwnerInvite,
  OwnerRevoke,
  OwnerActivate,
} from "./company-access.dto.js";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
@Injectable()
export class CompanyAccessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly cache: CacheService,
  ) {}
  async owner(publicId: string) {
    return this.db.platform(async (c) => {
      const company = (
        await c.query("SELECT id FROM platform.companies WHERE public_id=$1", [
          publicId,
        ])
      ).rows[0];
      if (!company) throw new NotFoundException("Company not found");
      const a = (
        await c.query(
          `SELECT a.id,a.name,a.email,a.status,(SELECT expires_at FROM platform.company_owner_invitations i WHERE i.account_id=a.id AND i.used_at IS NULL AND i.revoked_at IS NULL ORDER BY created_at DESC LIMIT 1) AS invitation_expires_at FROM platform.company_owner_accounts a WHERE company_id=$1`,
          [company.id],
        )
      ).rows[0];
      return { owner: a ?? null, delivery: "manual" };
    });
  }
  async mutate(
    publicId: string,
    input: OwnerInvite | OwnerRevoke,
    actor: string,
    revoke = false,
  ) {
    if (!(await this.cache.consume("owner-invite:" + actor, 20, 900)))
      throw new HttpException("Too many verification attempts", 429);
    return this.db
      .platform(async (c) => {
        const company = (
          await c.query(
            "SELECT * FROM platform.companies WHERE public_id=$1 FOR UPDATE",
            [publicId],
          )
        ).rows[0];
        if (!company) throw new NotFoundException("Company not found");
        if (company.version !== input.version)
          throw new ConflictException("Company changed. Refresh first.");
        if (!["pending", "trial", "active"].includes(company.status))
          throw new ConflictException(
            "Company is unavailable for owner invitations",
          );
        const admin = (
          await c.query(
            `SELECT p.password_hash FROM platform.users u JOIN platform.roles r ON r.id=u.role_id JOIN platform.credentials p ON p.user_id=u.id WHERE u.id=$1 AND u.status='active' AND 'co.create'=ANY(r.permissions) FOR SHARE OF u,r`,
            [actor],
          )
        ).rows[0];
        if (!admin) throw new ForbiddenException();
        if (!(await verifyPassword(input.password, admin.password_hash)))
          throw new UnauthorizedException("Password verification failed");
        let a = (
          await c.query(
            "SELECT * FROM platform.company_owner_accounts WHERE company_id=$1 FOR UPDATE",
            [company.id],
          )
        ).rows[0];
        if (a && a.status !== "invited")
          throw new ConflictException(
            "Owner has already activated. Invitation cannot reset access.",
          );
        if (!a) {
          if (revoke)
            throw new ConflictException("No pending owner invitation");
          if (!company.admin_email)
            throw new BadRequestException("Set the company admin email first");
          if (
            (
              await c.query(
                "SELECT 1 FROM platform.users WHERE email=$1 UNION ALL SELECT 1 FROM platform.company_owner_accounts WHERE email=$1",
                [company.admin_email],
              )
            ).rowCount
          )
            throw new ConflictException(
              "Email already belongs to an account. Use a different company admin email.",
            );
          const id = (
            await c.query(
              "SELECT platform.provision_company_owner($1,$2,$3) AS id",
              [company.id, (input as OwnerInvite).name, company.admin_email],
            )
          ).rows[0].id;
          a = (
            await c.query(
              "SELECT * FROM platform.company_owner_accounts WHERE id=$1",
              [id],
            )
          ).rows[0];
        }
        await c.query(
          "UPDATE platform.company_owner_invitations SET revoked_at=now() WHERE account_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
          [a.id],
        );
        const token = revoke ? null : randomBytes(32).toString("hex");
        let expiresAt = null;
        if (token)
          expiresAt = (
            await c.query(
              `INSERT INTO platform.company_owner_invitations(account_id,digest,created_by,expires_at) VALUES($1,$2,$3,now()+interval '24 hours') RETURNING expires_at`,
              [a.id, digest(token), actor],
            )
          ).rows[0].expires_at;
        await c.query(
          "UPDATE platform.companies SET version=version+1,updated_at=now() WHERE id=$1",
          [company.id],
        );
        await recordPlatformEvent(c, {
          actorId: actor,
          companyId: company.id,
          action: revoke
            ? "company_owner.invitation_revoked"
            : "company_owner.invited",
          resourceType: "company_owner",
          resourceId: a.id,
          after: { reason: input.reason, status: "invited" },
          payload: { accountId: a.id },
        });
        return {
          status: revoke ? "revoked" : "invited",
          token,
          expiresAt,
          delivery: "manual",
          email: a.email,
        };
      })
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === "23505")
          throw new ConflictException(
            "Email already belongs to an account. Refresh and check the owner contact.",
          );
        throw e;
      });
  }
  async activate(input: OwnerActivate, ip: string) {
    if (!(await this.cache.consume("owner-activate:" + digest(ip), 20, 900)))
      throw new HttpException("Too many attempts", 429);
    const ref = await this.db.platform(
      async (c) =>
        (
          await c.query(
            `SELECT i.id FROM platform.company_owner_invitations i JOIN platform.company_owner_accounts a ON a.id=i.account_id JOIN platform.companies co ON co.id=a.company_id WHERE i.digest=$1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() AND a.status='invited' AND co.status IN ('pending','trial','active')`,
            [digest(input.token)],
          )
        ).rows[0],
    );
    if (!ref) throw new BadRequestException("Invitation invalid or expired");
    const hash = await hashPassword(input.password);
    try {
      return await this.db.platform(async (c) => {
        await c.query("SELECT platform.activate_company_owner($1,$2)", [
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
