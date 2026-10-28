import type { PoolClient } from "pg";
import {
  Injectable,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { ConfirmationService } from "../../../common/auth/confirmation.service.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
import { DEFAULT_SETTINGS, type PlatformSettings } from "./settings.model.js";
import type { SettingsChange } from "./settings.dto.js";
@Injectable()
export class SettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly confirmation: ConfirmationService,
  ) {}
  async read() {
    return this.db.platform(async (c) => {
      const r = (
        await c.query("SELECT * FROM platform.settings WHERE key='platform'")
      ).rows[0];
      return {
        value: { ...DEFAULT_SETTINGS, ...r?.value } as PlatformSettings,
        version: r?.version ?? 0,
        initialized: !!r,
        capabilities: {
          mfa: false,
          workspaceSessions: false,
          ipAllowlist: false,
          notifications: false,
          rememberedSessionDays: 30,
        },
      };
    });
  }
  async forClient(c: PoolClient) {
    const r = (
      await c.query("SELECT value FROM platform.settings WHERE key='platform'")
    ).rows[0];
    return { ...DEFAULT_SETTINGS, ...r?.value } as PlatformSettings;
  }
  async value() {
    return (await this.read()).value;
  }
  async branding() {
    const v = await this.value();
    return {
      platformName: v.platformName,
      supportEmail: v.supportEmail,
      defaultLang: v.defaultLang,
      defaultTimezone: v.defaultTimezone,
      primaryColor: v.primaryColor,
      supportUrl: v.supportUrl,
    };
  }
  async defaults() {
    const v = await this.value();
    return {
      trialDays: v.trialDays,
      defaultPlan: v.defaultPlan,
      defaultCurrency: v.defaultCurrency,
      paymentTerms: v.paymentTerms,
      taxRate: v.taxRate,
      taxProfile: v.taxProfile,
    };
  }
  async save(input: SettingsChange, actor: string) {
    const v = input.value;
    if (!v) throw new BadRequestException("Settings value required");
    if (
      v.requireMfa ||
      v.notifyPaymentFailed ||
      v.notifyTrialEnding ||
      v.notifyTicketAssigned ||
      v.notifyIncident
    )
      throw new BadRequestException(
        "MFA and notification delivery are not implemented",
      );
    if (v.supportUrl) {
      try {
        const u = new URL(v.supportUrl);
        if (u.protocol !== "https:" || u.username || u.password) throw Error();
      } catch {
        throw new BadRequestException(
          "Support URL must use HTTPS without embedded credentials",
        );
      }
    }
    await this.confirmation.rate(actor);
    return this.db.platform(async (c) => {
      await this.confirmation.verify(
        c,
        actor,
        input.password,
        "settings",
        true,
      );
      await c.query("SELECT pg_advisory_xact_lock(80425110)");
      let r = (
        await c.query(
          "SELECT * FROM platform.settings WHERE key='platform' FOR UPDATE",
        )
      ).rows[0];
      if ((r?.version ?? 0) !== input.version)
        throw new ConflictException("Settings changed. Reload before saving");
      if (
        !(
          await c.query(
            "SELECT 1 FROM platform.subscription_plans WHERE key=$1 AND NOT archived",
            [v.defaultPlan],
          )
        ).rowCount
      )
        throw new BadRequestException(
          "Default plan must be an active configured plan",
        );
      const before = { ...DEFAULT_SETTINGS, ...r?.value };
      if (!r)
        r = (
          await c.query(
            "INSERT INTO platform.settings(key,value) VALUES ('platform',$1) RETURNING *",
            [DEFAULT_SETTINGS],
          )
        ).rows[0];
      await c.query(
        "UPDATE platform.settings SET value=$2,version=version+1,updated_at=now() WHERE id=$1",
        [r.id, v],
      );
      if (v.sessionLength < before.sessionLength)
        await c.query(
          "UPDATE platform.sessions SET expires_at=least(expires_at,now()+$1*interval '1 minute')",
          [v.sessionLength],
        );
      await recordPlatformEvent(c, {
        actorId: actor,
        action: "settings.updated",
        resourceType: "platform_settings",
        resourceId: r.id,
        before,
        after: { ...v, reason: input.reason },
        payload: { version: r.version + 1 },
      });
      return { status: "saved", version: r.version + 1 };
    });
  }
}
