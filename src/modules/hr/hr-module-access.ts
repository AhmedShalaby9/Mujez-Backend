import { ForbiddenException } from "@nestjs/common";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";

/** Check persisted company configuration, never client roles or cached session flags. */
export async function requireHrModule(db: DatabaseService, companyId: string) {
  const enabled = await db.platform(
    async (c) =>
      (
        await c.query("SELECT hr_enabled FROM platform.companies WHERE id=$1", [
          companyId,
        ])
      ).rows[0]?.hr_enabled,
  );
  if (!enabled)
    throw new ForbiddenException({
      code: "hr_module_disabled",
      message: "The HR module is disabled for this company",
    });
}
