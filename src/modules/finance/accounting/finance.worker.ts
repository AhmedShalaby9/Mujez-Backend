import { runOfficeSweep } from "../../office/office-sweep.js";
import { runFinanceAutomation } from "./finance-automation-sweep.js";
import "reflect-metadata";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { parseEnvironment } from "../../../config/env.js";
import { runFinanceSweep } from "./finance-sweep.js";
async function main() {
  const db = new DatabaseService(parseEnvironment(process.env));
  let stopping = false;
  const controller = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT"])
    process.on(sig, () => {
      stopping = true;
      controller.abort();
    });
  try {
    await db.ready();
    while (!stopping) {
      try {
        let office: unknown;
        try {
          office = await runOfficeSweep(db, () => stopping);
        } catch {
          office = { failed: true };
          console.error(JSON.stringify({ event: "office.lease_sweep_failed" }));
        }
        const automation = await runFinanceAutomation(db, () => stopping);
        const result = {
          ...(await runFinanceSweep(db, () => stopping)),
          automation,
          office,
        };
        await db.platform((c) =>
          c.query(
            "INSERT INTO platform.worker_heartbeats(key,seen_at,details) VALUES('company-finance',now(),$1) ON CONFLICT(key) DO UPDATE SET seen_at=excluded.seen_at,details=excluded.details",
            [result],
          ),
        );
        await writeFile("/tmp/mujez-finance-heartbeat", "ok");
        console.log(JSON.stringify({ event: "finance.reminders", ...result }));
      } catch (e) {
        console.error(
          JSON.stringify({
            event: "finance.reminders_failed",
            errorType: e instanceof Error ? e.name : "Unknown",
          }),
        );
      }
      if (!stopping)
        try {
          await delay(60000, undefined, { signal: controller.signal });
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
      event: "finance.worker_stopped",
      errorType: e instanceof Error ? e.name : "Unknown",
    }),
  );
  process.exitCode = 1;
});
