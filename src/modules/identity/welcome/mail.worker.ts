import "reflect-metadata";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { parseEnvironment } from "../../../config/env.js";
import { OwnerWelcomeService } from "./welcome.service.js";
import { deliverWelcome, mailTransport } from "./delivery.js";
async function main() {
  const env = parseEnvironment(process.env);
  new OwnerWelcomeService(env).ready();
  const db = new DatabaseService(env),
    transport = {
      sendMail: (
        message: Parameters<ReturnType<typeof mailTransport>["sendMail"]>[0],
      ) => {
        const smtp = mailTransport(env);
        return smtp.sendMail(message).finally(() => smtp.close());
      },
    },
    controller = new AbortController();
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, () => {
      stopping = true;
      controller.abort();
    });
  try {
    await db.ready();
    while (!stopping) {
      try {
        const result = await deliverWelcome(db, env, transport);
        await db.platform((c) =>
          c.query(
            "INSERT INTO platform.worker_heartbeats(key,seen_at,details) VALUES('owner-email',now(),$1) ON CONFLICT(key) DO UPDATE SET seen_at=excluded.seen_at,details=excluded.details",
            [result],
          ),
        );
        await writeFile("/tmp/mujez-mail-heartbeat", "ok");
      } catch (e) {
        console.error(
          JSON.stringify({
            event: "owner_email.sweep_failed",
            errorType: e instanceof Error ? e.name : "Unknown",
          }),
        );
      }
      if (!stopping)
        try {
          await delay(3000, undefined, { signal: controller.signal });
        } catch {
          if (!stopping) throw Error("Worker delay interrupted");
        }
    }
  } finally {
    await db.onApplicationShutdown();
  }
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      event: "owner_email.worker_stopped",
      errorType: e instanceof Error ? e.name : "Unknown",
    }),
  );
  process.exitCode = 1;
});
