import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import type { Environment } from "../../../config/env.js";
import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { unseal } from "./welcome.service.js";
export function mailTransport(env: Environment, ca?: string) {
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    requireTLS: true,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASSWORD_FILE
        ? readFileSync(env.SMTP_PASSWORD_FILE, "utf8").trim()
        : env.SMTP_PASSWORD,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    dnsTimeout: 10000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
    },
  });
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function welcomeMessage(
  job: any,
  payload: { password: string; company: string; loginUrl: string },
) {
  const url = payload.loginUrl;
  return {
    from: { name: "Mujez", address: "info@mujez.net" },
    to: job.recipient,
    messageId: "<owner-welcome-" + job.generation + "@mujez.net>",
    subject: "Your Mujez company account | حساب شركتك في مجاز",
    text: `Welcome to Mujez — ${payload.company}\n\nLogin: ${url}\nEmail: ${job.recipient}\nTemporary password: ${payload.password}\n\nThis password expires after 24 hours. You must choose a new password at first login. Your role is Company Owner. Workspace modules require an available company and current subscription.\n\nمرحبًا بك في مجاز\nتم إنشاء حساب مالك الشركة. استخدم رابط الدخول والبريد وكلمة المرور المؤقتة أعلاه. تنتهي كلمة المرور خلال ٢٤ ساعة ويجب تغييرها عند أول دخول.\n\nIf you did not expect this account, contact the Mujez administrator.`,
    html: `<div style="font:16px Arial,sans-serif;max-width:600px;margin:auto;line-height:1.7"><h1>Mujez | مجاز</h1><h2>Welcome, ${escape(payload.company)}</h2><p>Your Company Owner account has been created.</p><p><a href="${escape(url)}">Sign in to your company workspace</a></p><p>Email: <strong>${escape(job.recipient)}</strong><br>Temporary password: <strong>${escape(payload.password)}</strong></p><p>This password expires after 24 hours. Choose a new password at first login.</p><div dir="rtl"><h2>مرحبًا بك في مجاز</h2><p>تم إنشاء حساب مالك الشركة. استخدم بيانات الدخول أعلاه، وغيّر كلمة المرور المؤقتة عند أول دخول خلال ٢٤ ساعة.</p></div><p>Workspace access follows your company status and subscription. If you did not expect this email, contact the Mujez administrator.</p></div>`,
  };
}
export async function deliverWelcome(
  db: Pick<DatabaseService, "platform">,
  env: Environment,
  transport: Pick<ReturnType<typeof mailTransport>, "sendMail">,
) {
  const lease = randomUUID();
  const job = await db.platform(async (c) => {
    const row = (
      await c.query(
        "SELECT * FROM platform.owner_welcome_emails WHERE (status IN ('queued','retry') AND next_attempt_at<=now()) OR (status='processing' AND lease_until<now()) ORDER BY next_attempt_at,account_id LIMIT 1 FOR UPDATE SKIP LOCKED",
      )
    ).rows[0];
    if (!row) return null;
    const available = (
      await c.query(
        "SELECT 1 FROM platform.company_owner_accounts a JOIN platform.companies co ON co.id=a.company_id JOIN platform.company_owner_credentials p ON p.account_id=a.id WHERE a.id=$1 AND a.status='active' AND co.status IN ('pending','trial','active') AND p.must_change_password AND p.temporary_expires_at>now()",
        [row.account_id],
      )
    ).rowCount;
    if (!available) {
      await c.query(
        "UPDATE platform.owner_welcome_emails SET status='cancelled',ciphertext=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE account_id=$1",
        [row.account_id],
      );
      return null;
    }
    await c.query(
      "UPDATE platform.owner_welcome_emails SET status='processing',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '2 minutes',updated_at=now() WHERE account_id=$1",
      [row.account_id, lease],
    );
    return { ...row, attempts: row.attempts + 1 };
  });
  if (!job) return { processed: 0 };
  try {
    const payload = JSON.parse(
      unseal(
        job.ciphertext,
        env.WELCOME_ENCRYPTION_KEY!,
        job.account_id + ":" + job.generation,
      ),
    );
    const result = await transport.sendMail(welcomeMessage(job, payload));
    if (!result.accepted?.length || result.rejected?.length)
      throw new Error("Recipient not accepted");
    await db.platform((c) =>
      c.query(
        "UPDATE platform.owner_welcome_emails SET status='accepted',ciphertext=NULL,accepted_at=now(),error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE account_id=$1 AND generation=$2 AND lease_token=$3",
        [job.account_id, job.generation, lease],
      ),
    );
    return { processed: 1, accepted: 1 };
  } catch {
    await db.platform((c) =>
      c.query(
        "UPDATE platform.owner_welcome_emails SET status=CASE WHEN attempts>=8 THEN 'failed' ELSE 'retry' END,ciphertext=CASE WHEN attempts>=8 THEN NULL ELSE ciphertext END,error_code='delivery_failed',next_attempt_at=now()+$4*interval '1 second',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE account_id=$1 AND generation=$2 AND lease_token=$3",
        [
          job.account_id,
          job.generation,
          lease,
          Math.min(3600, 30 * 2 ** Math.min(job.attempts - 1, 7)),
        ],
      ),
    );
    return { processed: 1, accepted: 0 };
  }
}
