import { randomUUID } from "node:crypto";
import type { Environment } from "../../../config/env.js";
import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { unseal } from "./welcome.service.js";
import type { mailTransport } from "./delivery.js";
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function employeeActivationMessage(
  job: any,
  token: string,
  env: Environment,
) {
  const url = new URL("/activate/team", env.DASHBOARD_URL!);
  url.hash = "token=" + token;
  return {
    from: { name: "Mujez", address: "info@mujez.net" },
    to: job.recipient,
    messageId: "<employee-activation-" + job.generation + "@mujez.net>",
    subject: "Activate your Mujez employee account | حساب الموظف",
    text: `Your employee account is ready. Set your own password: ${url.href}\nThis link expires after 24 hours. Your assigned roles determine your workspace.\nتم إنشاء حساب الموظف. استخدم الرابط لتعيين كلمة مرور خلال ٢٤ ساعة.`,
    html: `<div style="font:16px Arial,sans-serif;line-height:1.7;max-width:600px;margin:auto"><h1>Mujez | موچز</h1><h2>Your employee account is ready</h2><p><a href="${escape(url.href)}">Activate your account and set your password</a></p><p>This link expires after 24 hours. Your assigned roles determine the pages you can access.</p><p dir="rtl">تم إنشاء حساب الموظف. استخدم الرابط لتعيين كلمة مرور خلال ٢٤ ساعة.</p></div>`,
  };
}
export async function deliverEmployeeActivation(
  db: Pick<DatabaseService, "platform">,
  env: Environment,
  transport: Pick<ReturnType<typeof mailTransport>, "sendMail">,
) {
  const lease = randomUUID();
  const job = await db.platform(async (c) => {
    const row = (
      await c.query(
        "SELECT * FROM platform.employee_activation_emails WHERE (status IN ('queued','retry') AND next_attempt_at<=now()) OR (status='processing' AND lease_until<now()) ORDER BY next_attempt_at,account_id LIMIT 1 FOR UPDATE SKIP LOCKED",
      )
    ).rows[0];
    if (!row) return null;
    const available = (
      await c.query(
        "SELECT 1 FROM platform.company_employee_accounts a JOIN platform.companies co ON co.id=a.company_id JOIN platform.company_employee_invitations i ON i.account_id=a.id WHERE a.id=$1 AND a.status='invited' AND a.email=$3 AND co.status IN ('pending','trial','active') AND i.digest=$2 AND i.revoked_at IS NULL AND i.used_at IS NULL AND i.expires_at>now() AND platform.employee_activation_available(a.id,$4)",
        [row.account_id, row.invitation_digest, row.recipient, row.employee_id],
      )
    ).rowCount;
    if (!available) {
      await c.query(
        "UPDATE platform.employee_activation_emails SET status='cancelled',ciphertext=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE account_id=$1",
        [row.account_id],
      );
      return null;
    }
    await c.query(
      "UPDATE platform.employee_activation_emails SET status='processing',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '2 minutes',updated_at=now() WHERE account_id=$1",
      [row.account_id, lease],
    );
    return { ...row, attempts: row.attempts + 1 };
  });
  if (!job) return { processed: 0 };
  try {
    const { token } = JSON.parse(
      unseal(
        job.ciphertext,
        env.WELCOME_ENCRYPTION_KEY!,
        job.employee_id + ":" + job.generation,
      ),
    );
    const result = await transport.sendMail(
      employeeActivationMessage(job, token, env),
    );
    if (!result.accepted?.length || result.rejected?.length)
      throw Error("Recipient not accepted");
    await db.platform((c) =>
      c.query(
        "UPDATE platform.employee_activation_emails SET status='accepted',ciphertext=NULL,accepted_at=now(),error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE account_id=$1 AND generation=$2 AND lease_token=$3",
        [job.account_id, job.generation, lease],
      ),
    );
    return { processed: 1, accepted: 1 };
  } catch {
    await db.platform((c) =>
      c.query(
        "UPDATE platform.employee_activation_emails SET status=CASE WHEN attempts>=8 THEN 'failed' ELSE 'retry' END,ciphertext=CASE WHEN attempts>=8 THEN NULL ELSE ciphertext END,error_code='delivery_failed',next_attempt_at=now()+$4*interval '1 second',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE account_id=$1 AND generation=$2 AND lease_token=$3",
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
