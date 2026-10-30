import "reflect-metadata";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { parseEnvironment } from "../../../config/env.js";
import { runSlaSweep } from "./sla-sweep.js";
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
        const result = await runSlaSweep(db, () => stopping);
        await db.platform(async (c) => {
          await c.query(
            "INSERT INTO platform.worker_heartbeats(key,seen_at,details) VALUES('lead-routing',now(),$1) ON CONFLICT(key) DO UPDATE SET seen_at=excluded.seen_at,details=excluded.details",
            [result],
          );
        });
        await writeFile("/tmp/mujez-routing-heartbeat", "ok");
        console.log(JSON.stringify({ event: "routing.sweep", ...result }));
      } catch (e) {
        console.error(
          JSON.stringify({
            event: "routing.sweep_failed",
            errorType: e instanceof Error ? e.name : "Unknown",
          }),
        );
      }
      if (stopping) break;
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
      event: "routing.worker_stopped",
      errorType: e instanceof Error ? e.name : "Unknown",
    }),
  );
  process.exitCode = 1;
});
