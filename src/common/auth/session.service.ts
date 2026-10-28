import { Optional } from "@nestjs/common";
import { SettingsService } from "../../modules/platform/settings/settings.service.js";
import { DEFAULT_SETTINGS } from "../../modules/platform/settings/settings.model.js";
import { CacheService } from "../../infrastructure/cache/cache.module.js";
import {
  Injectable,
  UnauthorizedException,
  HttpException,
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
  async resolve(token: string) {
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
    await this.db.platform((c) =>
      c.query("DELETE FROM platform.sessions WHERE digest=$1", [digest(token)]),
    );
  }
}
