import { Optional } from "@nestjs/common";
import { SettingsService } from "../../modules/platform/settings/settings.service.js";
import { DEFAULT_SETTINGS } from "../../modules/platform/settings/settings.model.js";
import { CacheService } from "../../infrastructure/cache/cache.module.js";
import {
  Injectable,
  UnauthorizedException,
  HttpException,
  ForbiddenException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { hashPassword, verifyPassword } from "./password.js";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
@Injectable()
export class SessionService {
  private readonly dummy = hashPassword(randomBytes(32).toString("hex"));
  constructor(
    private readonly db: DatabaseService,
    private readonly cache: CacheService,
    @Optional() private readonly settings?: SettingsService,
  ) {}
  async login(
    email: string,
    password: string,
    remember: boolean,
    previous?: string,
    ip = "unknown",
  ) {
    const policy = this.settings
      ? await this.settings.value()
      : DEFAULT_SETTINGS;
    if (
      !(await this.cache.consume("login:ip:" + digest(ip), 100, 900)) ||
      !(await this.cache.consume(
        "login:email:" + digest(email.trim().toLowerCase()),
        policy.lockoutAttempts,
        900,
      ))
    )
      throw new HttpException("Too many attempts. Try again later.", 429);
    const user = await this.db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT u.id,c.password_hash FROM platform.users u JOIN platform.credentials c ON c.user_id=u.id WHERE u.email=$1 AND u.status='active'",
            [email.trim().toLowerCase()],
          )
        ).rows[0],
    );
    const valid = await verifyPassword(
      password,
      user?.password_hash ?? (await this.dummy),
    );
    if (!user || !valid)
      throw new UnauthorizedException("Invalid email or password");
    const token = randomBytes(32).toString("hex");
    const seconds = remember ? 2592000 : policy.sessionLength * 60;
    await this.db.platform(async (c) => {
      const current = (
        await c.query(
          "SELECT u.status,p.password_hash FROM platform.users u JOIN platform.credentials p ON p.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u",
          [user.id],
        )
      ).rows[0];
      if (
        !current ||
        current.status !== "active" ||
        current.password_hash !== user.password_hash
      )
        throw new UnauthorizedException("Invalid email or password");
      await c.query(
        "UPDATE platform.users SET last_login_at=now() WHERE id=$1",
        [user.id],
      );
      if (previous)
        await c.query("DELETE FROM platform.sessions WHERE digest=$1", [
          digest(previous),
        ]);
      await c.query("DELETE FROM platform.sessions WHERE expires_at < now()");
      await c.query(
        "INSERT INTO platform.sessions(digest,user_id,expires_at) VALUES ($1,$2,now()+$3*interval '1 second')",
        [digest(token), user.id, seconds],
      );
    });
    return { token, seconds };
  }
  async loginAny(
    email: string,
    password: string,
    remember: boolean,
    previous?: string,
    ip = "unknown",
  ) {
    const realm = await this.db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT EXISTS(SELECT 1 FROM platform.users WHERE email=$1) AS platform,EXISTS(SELECT 1 FROM platform.company_owner_accounts WHERE email=$1) AS company",
            [email.trim().toLowerCase()],
          )
        ).rows[0],
    );
    if (realm.platform && realm.company)
      throw new UnauthorizedException("Invalid email or password");
    const session = realm.company
      ? await this.loginOwner(email, password, remember, ip)
      : await this.login(email, password, remember, previous, ip);
    if (previous) await this.logout(previous);
    return session;
  }
  async loginOwner(
    email: string,
    password: string,
    remember: boolean,
    ip: string,
  ) {
    const policy = this.settings
      ? await this.settings.value()
      : DEFAULT_SETTINGS;
    if (
      !(await this.cache.consume("login:ip:" + digest(ip), 100, 900)) ||
      !(await this.cache.consume(
        "login:email:" + digest(email.trim().toLowerCase()),
        policy.lockoutAttempts,
        900,
      ))
    )
      throw new HttpException("Too many attempts. Try again later.", 429);
    const a = await this.db.platform(
      async (c) =>
        (
          await c.query(
            `SELECT a.*,p.password_hash,co.status AS company_status FROM platform.company_owner_accounts a JOIN platform.company_owner_credentials p ON p.account_id=a.id JOIN platform.companies co ON co.id=a.company_id WHERE a.email=$1 AND a.status='active'`,
            [email.trim().toLowerCase()],
          )
        ).rows[0],
    );
    const valid = await verifyPassword(
      password,
      a?.password_hash ?? (await this.dummy),
    );
    if (!a || !valid)
      throw new UnauthorizedException("Invalid email or password");
    if (!["pending", "trial", "active"].includes(a.company_status))
      throw new ForbiddenException("Company access unavailable");
    await this.ownerProfile(a);
    const token = "c_" + randomBytes(32).toString("hex"),
      seconds = remember ? 2592000 : policy.sessionLength * 60;
    await this.db.platform(async (c) => {
      const current = (
        await c.query(
          `SELECT a.status,p.password_hash,co.status AS company_status FROM platform.company_owner_accounts a JOIN platform.company_owner_credentials p ON p.account_id=a.id JOIN platform.companies co ON co.id=a.company_id WHERE a.id=$1 FOR SHARE OF co,a,p`,
          [a.id],
        )
      ).rows[0];
      if (
        !current ||
        current.status !== "active" ||
        current.password_hash !== a.password_hash
      )
        throw new UnauthorizedException("Invalid email or password");
      if (!["pending", "trial", "active"].includes(current.company_status))
        throw new ForbiddenException("Company access unavailable");
      await c.query(
        "DELETE FROM platform.company_owner_sessions WHERE expires_at<now()",
      );
      await c.query(
        `INSERT INTO platform.company_owner_sessions(digest,account_id,expires_at) VALUES($1,$2,now()+$3*interval '1 second')`,
        [digest(token), a.id, seconds],
      );
    });
    await this.db.tenant(a.company_id, async (c) => {
      await c.query(
        "UPDATE tenant.users SET last_login_at=now() WHERE company_id=$1 AND id=$2",
        [a.company_id, a.user_id],
      );
    });
    return { token, seconds };
  }
  async ownerProfile(a: any) {
    const user = await this.db.tenant(
      a.company_id,
      async (c) =>
        (
          await c.query(
            `SELECT u.id,u.name,u.email,u.team_id,r.key AS role,r.name AS role_name,r.permissions,r.scope FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=$1 AND u.id=$2 AND u.status='active' AND u.deleted_at IS NULL AND u.identity_pool='company_admin' AND r.key='company_owner' AND r.scope='company'`,
            [a.company_id, a.user_id],
          )
        ).rows[0],
    );
    if (!user) throw new UnauthorizedException();
    return {
      id: user.id,
      subject: user.id,
      pool: "company_admin" as const,
      scope: "company" as const,
      companyId: a.company_id,
      name: user.name,
      email: user.email,
      role: user.role,
      roleName: user.role_name,
      permissions: user.permissions,
      teamId: user.team_id ?? undefined,
    };
  }
  async resolveOwner(token: string) {
    if (!/^c_[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException();
    const a = await this.db.platform(
      async (c) =>
        (
          await c.query(
            `SELECT a.*,co.public_id,co.slug,co.name AS company_name,co.status AS company_status FROM platform.company_owner_sessions s JOIN platform.company_owner_accounts a ON a.id=s.account_id JOIN platform.companies co ON co.id=a.company_id WHERE s.digest=$1 AND s.expires_at>now() AND a.status='active'`,
            [digest(token)],
          )
        ).rows[0],
    );
    if (!a) throw new UnauthorizedException();
    if (!["pending", "trial", "active"].includes(a.company_status))
      throw new ForbiddenException("Company access unavailable");
    const profile = await this.ownerProfile(a);
    return {
      ...profile,
      company: {
        id: a.public_id,
        slug: a.slug,
        name: a.company_name,
        status: a.company_status,
      },
    };
  }
  async resolve(token: string) {
    if (token.startsWith("c_")) return this.resolveOwner(token);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException();
    const user = await this.db.platform(
      async (c) =>
        (
          await c.query(
            "SELECT u.id,u.name,u.email,r.key AS role,r.name AS role_name,r.permissions FROM platform.sessions s JOIN platform.users u ON u.id=s.user_id JOIN platform.roles r ON r.id=u.role_id WHERE s.digest=$1 AND s.expires_at>now() AND u.status='active'",
            [digest(token)],
          )
        ).rows[0],
    );
    if (!user) throw new UnauthorizedException();
    const { role_name, ...profile } = user;
    return {
      ...profile,
      roleName: role_name,
      pool: "platform" as const,
      scope: "platform" as const,
      subject: user.id,
    };
  }
  async logout(token: string) {
    if (token.startsWith("c_")) {
      await this.db.platform((c) =>
        c.query("DELETE FROM platform.company_owner_sessions WHERE digest=$1", [
          digest(token),
        ]),
      );
      return;
    }
    await this.db.platform((c) =>
      c.query("DELETE FROM platform.sessions WHERE digest=$1", [digest(token)]),
    );
  }
}
