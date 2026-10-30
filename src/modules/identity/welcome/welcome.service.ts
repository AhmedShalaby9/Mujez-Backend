import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  createHash,
} from "node:crypto";
import type { PoolClient } from "pg";
import { ENV, type Environment } from "../../../config/env.js";
import { hashPassword } from "../../../common/auth/password.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
export function seal(secret: string, key: string, aad: string) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  c.setAAD(Buffer.from(aad));
  return [iv, c.update(secret, "utf8"), c.final(), c.getAuthTag()]
    .map((b) => b.toString("base64"))
    .join(".");
}
export function unseal(value: string, key: string, aad: string) {
  const [iv, body, tail, tag] = value
    .split(".")
    .map((x) => Buffer.from(x, "base64"));
  const d = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv!);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(body!), d.update(tail!), d.final()]).toString(
    "utf8",
  );
}
@Injectable()
export class OwnerWelcomeService {
  constructor(@Inject(ENV) readonly env: Environment) {}
  ready() {
    if (
      !this.env.MAIL_ENABLED ||
      !this.env.WELCOME_ENCRYPTION_KEY ||
      !this.env.SMTP_HOST ||
      !this.env.SMTP_USER ||
      (!this.env.SMTP_PASSWORD && !this.env.SMTP_PASSWORD_FILE) ||
      !this.env.DASHBOARD_URL
    )
      throw new ServiceUnavailableException(
        "Owner email delivery is not configured. Please contact the platform administrator.",
      );
  }
  async provision(c: PoolClient, company: any, actor: string) {
    this.ready();
    const admin = (
      await c.query(
        "SELECT 1 FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE u.id=$1 AND u.status='active' AND 'co.create'=ANY(r.permissions) FOR SHARE OF u,r",
        [actor],
      )
    ).rowCount;
    if (!admin)
      throw new ServiceUnavailableException(
        "Company administrator is unavailable.",
      );
    const accountId = (
      await c.query("SELECT platform.provision_company_owner($1,$2,$3) AS id", [
        company.id,
        company.name.en,
        company.admin_email,
      ])
    ).rows[0].id;
    const token = randomBytes(32).toString("hex");
    await c.query(
      "INSERT INTO platform.company_owner_invitations(account_id,digest,created_by,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')",
      [accountId, createHash("sha256").update(token).digest("hex"), actor],
    );
    const temporary = randomBytes(24).toString("base64url"),
      hashed = await hashPassword(temporary);
    await c.query("SELECT platform.activate_company_owner($1,$2)", [
      createHash("sha256").update(token).digest("hex"),
      hashed,
    ]);
    await this.queue(c, accountId, company, actor, temporary);
    return { status: "queued", recipient: company.admin_email };
  }
  async queue(
    c: PoolClient,
    accountId: string,
    company: any,
    actor: string,
    temporary?: string,
  ) {
    this.ready();
    const plain = temporary ?? randomBytes(24).toString("base64url"),
      generation = randomUUID();
    if (!temporary)
      await c.query(
        "UPDATE platform.company_owner_credentials SET password_hash=$2 WHERE account_id=$1",
        [accountId, await hashPassword(plain)],
      );
    await c.query(
      "UPDATE platform.company_owner_credentials SET must_change_password=true,temporary_expires_at=now()+interval '24 hours' WHERE account_id=$1",
      [accountId],
    );
    await c.query("SELECT platform.prepare_owner_first_login($1)", [accountId]);
    await c.query(
      "DELETE FROM platform.company_owner_sessions WHERE account_id=$1",
      [accountId],
    );
    const payload = seal(
      JSON.stringify({
        password: plain,
        company: company.name.en,
        loginUrl: this.env.DASHBOARD_URL,
      }),
      this.env.WELCOME_ENCRYPTION_KEY!,
      accountId + ":" + generation,
    );
    await c.query(
      "INSERT INTO platform.owner_welcome_emails(account_id,generation,recipient,ciphertext,status) VALUES($1,$2,$3,$4,'queued') ON CONFLICT(account_id) DO UPDATE SET generation=excluded.generation,recipient=excluded.recipient,ciphertext=excluded.ciphertext,status='queued',attempts=0,next_attempt_at=now(),lease_token=NULL,lease_until=NULL,accepted_at=NULL,error_code=NULL,updated_at=now()",
      [accountId, generation, company.admin_email, payload],
    );
    await recordPlatformEvent(c, {
      companyId: company.id,
      actorId: actor,
      action: "company_owner.welcome_queued",
      resourceType: "company_owner",
      resourceId: accountId,
      after: { delivery: "queued" },
      payload: { accountId, generation },
    });
  }
}
