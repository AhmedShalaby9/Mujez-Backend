import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// Reuse the existing idempotent domain seeds; never invent historical revenue or usage.
for (const name of [
  "seed-companies.mjs",
  "seed-subscriptions.mjs",
  "seed-billing.mjs",
]) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL(name, import.meta.url))],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Error("Overview seed dependency failed: " + name);
}
console.log(
  "Overview sample companies, trial contracts, invoices and recorded sample payments are present. Existing records preserved; no backdated charts, churn or fake usage created.",
);
