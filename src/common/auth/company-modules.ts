import { ForbiddenException } from "@nestjs/common";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
export async function requireAiModule(
  db: DatabaseService,
  companyId: string | undefined,
) {
  if (!companyId) throw new ForbiddenException();
  const enabled = await db.platform(
    async (c) =>
      (
        await c.query("SELECT ai_enabled FROM platform.companies WHERE id=$1", [
          companyId,
        ])
      ).rows[0]?.ai_enabled,
  );
  if (!enabled)
    throw new ForbiddenException({
      code: "ai_module_disabled",
      message: "The AI module is disabled for this company",
    });
}
