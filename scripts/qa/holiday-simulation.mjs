// Start the repository's local Postman holiday simulation before running this.
import assert from "node:assert/strict";
import { tenantHarness } from "../../tests/tenant-harness.mjs";
import { EgyptHolidaysService } from "../../dist/modules/hr/leave/egypt-holidays.service.js";
const h = await tenantHarness();
try {
  const s = new EgyptHolidaysService(h.database, {
    EGYPT_HOLIDAYS_BASE_URL: "http://127.0.0.1:4518/egypt/api/v3",
  });
  const r = await s.get(2027);
  assert.equal(r.holidays[0].date, "2027-01-07");
  await assert.rejects(s.get(2025), (e) => e.getStatus() === 503);
  await assert.rejects(s.get(2024), (e) => e.getStatus() === 503);
  console.log(
    "Real holiday client + database passed Postman simulation: success, 503 HTML failure, wrong-country rejection.",
  );
} finally {
  await h.close();
}
