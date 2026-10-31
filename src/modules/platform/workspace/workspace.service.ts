import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { recordPlatformEvent } from "../../../infrastructure/outbox/domain-events.js";
import { ConfirmationService } from "../../../common/auth/confirmation.service.js";
import type { Principal } from "../../../common/auth/access.js";
import type { EnterInput, ElevateInput } from "./workspace.dto.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const READ_PERMISSIONS = [
  "workspace.view",
  "leads.read",
  "pipeline.read",
  "tasks.read",
  "projects.read",
  "units.read",
  "reservations.read",
  "contracts.read",
  "documents.read",
  "commissions.read",
  "marketing.read",
  "routing.read",
  "reports.read",
  "audit.read",
  "contacts.read",
  "calendar.read",
];

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly confirmation: ConfirmationService,
  ) {}

  async enter(
    actor: { id: string; permissions: string[] },
    publicId: string,
    input: EnterInput,
  ) {
    if (input.mode === "manage") {
      if (!actor.permissions.includes("ws.manage"))
        throw new ForbiddenException();
      if (!input.reason)
        throw new ForbiddenException(
          "A reason is required for management mode.",
        );
      if (!input.durationMinutes)
        throw new ForbiddenException("Choose a duration for management mode.");
      await this.confirmation.rate(actor.id);
    } else if (!actor.permissions.includes("ws.read")) {
      throw new ForbiddenException();
    }
    const token =
      (input.mode === "manage" ? "wm_" : "wr_") +
      randomBytes(32).toString("hex");
    return this.db.platform(async (c) => {
      const company = (
        await c.query(
          "SELECT id,public_id,name,status FROM platform.companies WHERE public_id=$1 FOR SHARE",
          [publicId],
        )
      ).rows[0];
      if (!company) throw new NotFoundException("Company not found");
      if (company.status === "archived")
        throw new ForbiddenException(
          "This company is archived. Its workspace is closed and cannot be entered.",
        );
      const owner = (
        await c.query(
          "SELECT 1 FROM platform.company_owner_accounts WHERE company_id=$1 AND status='active'",
          [company.id],
        )
      ).rows[0];
      if (!owner)
        throw new ForbiddenException(
          "This workspace is not set up yet — the administrator has not activated the account.",
        );
      if (input.mode === "manage") {
        if (!["active", "trial"].includes(company.status))
          throw new ForbiddenException(
            "Management mode is not available for a " +
              company.status +
              " company.",
          );
        await this.confirmation.verify(
          c,
          actor.id,
          input.password ?? "",
          "ws.manage",
        );
      }
      await c.query(
        "UPDATE platform.workspace_sessions SET ended_at=now(),end_reason='switched' WHERE platform_user_id=$1 AND ended_at IS NULL",
        [actor.id],
      );
      const manageExpiresAt =
        input.mode === "manage"
          ? new Date(Date.now() + input.durationMinutes! * 60000)
          : null;
      const row = (
        await c.query(
          `INSERT INTO platform.workspace_sessions(digest,platform_user_id,company_id,mode,reason,manage_expires_at)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,started_at`,
          [
            digest(token),
            actor.id,
            company.id,
            input.mode,
            input.reason ?? null,
            manageExpiresAt,
          ],
        )
      ).rows[0];
      await recordPlatformEvent(c, {
        actorId: actor.id,
        action: "workspace.entered",
        companyId: company.id,
        resourceType: "company",
        resourceId: company.public_id,
        after: { mode: input.mode, reason: input.reason ?? null },
        payload: { sessionId: row.id },
      });
      return {
        token,
        mode: input.mode as "read" | "manage",
        manageExpiresAt: manageExpiresAt?.toISOString() ?? null,
        company: {
          id: company.public_id,
          name: company.name,
          status: company.status,
        },
      };
    });
  }

  /** Resolves a workspace token into a tenant-scoped Principal, or null if not a valid/active workspace session. */
  async resolve(
    token: string,
    platformPrincipal: Principal,
  ): Promise<Principal | null> {
    if (!token.startsWith("wr_") && !token.startsWith("wm_")) return null;
    return this.db.platform(async (c) => {
      const row = (
        await c.query(
          `SELECT s.*,co.id AS co_uuid,co.public_id,co.slug,co.name AS co_name,co.status AS co_status
           FROM platform.workspace_sessions s JOIN platform.companies co ON co.id=s.company_id
           WHERE s.digest=$1 AND s.ended_at IS NULL`,
          [digest(token)],
        )
      ).rows[0];
      if (!row || row.platform_user_id !== platformPrincipal.id) return null;
      if (row.co_status === "archived") {
        await c.query(
          "UPDATE platform.workspace_sessions SET ended_at=now(),end_reason='company_archived' WHERE id=$1",
          [row.id],
        );
        return null;
      }
      let mode: "read" | "manage" = row.mode;
      let manageExpiresAt: string | null = row.manage_expires_at
        ? new Date(row.manage_expires_at).toISOString()
        : null;
      if (
        mode === "manage" &&
        row.manage_expires_at &&
        new Date(row.manage_expires_at) <= new Date()
      ) {
        await c.query(
          "UPDATE platform.workspace_sessions SET mode='read',manage_expires_at=NULL WHERE id=$1",
          [row.id],
        );
        await recordPlatformEvent(c, {
          actorId: platformPrincipal.id,
          action: "workspace.mode_auto_dropped",
          companyId: row.co_uuid,
          resourceType: "company",
          resourceId: row.public_id,
          after: { mode: "read" },
          payload: { sessionId: row.id },
        });
        mode = "read";
        manageExpiresAt = null;
      }
      return {
        id: platformPrincipal.id,
        subject: platformPrincipal.id,
        pool: "company_admin",
        companyId: row.co_uuid,
        name: platformPrincipal.name,
        email: platformPrincipal.email,
        // scope:"company" gives this principal full (non-own-scoped) read visibility in
        // sales.service.ts#access, matching what an owner sees. Every actual write stays
        // blocked because this principal is never granted a `.manage` permission, and
        // AccessGuard blocks writes outright in read mode.
        role: "company_owner",
        permissions: READ_PERMISSIONS,
        scope: "company",
        workspace: {
          sessionId: row.id,
          mode,
          reason: row.reason,
          startedAt: new Date(row.started_at).toISOString(),
          manageExpiresAt,
          platformUserName: platformPrincipal.name,
          platformRoleName: platformPrincipal.roleName,
          company: {
            id: row.public_id,
            uuid: row.co_uuid,
            slug: row.slug,
            name: row.co_name,
            status: row.co_status,
          },
        },
      };
    });
  }

  async elevate(
    workspace: NonNullable<Principal["workspace"]>,
    actorId: string,
    input: ElevateInput,
  ) {
    await this.confirmation.rate(actorId);
    return this.db.platform(async (c) => {
      const company = (
        await c.query(
          "SELECT id,public_id,status FROM platform.companies WHERE id=$1 FOR SHARE",
          [workspace.company.uuid],
        )
      ).rows[0];
      if (!company || !["active", "trial"].includes(company.status))
        throw new ForbiddenException(
          "Management mode is not available for a " +
            (company?.status ?? "unknown") +
            " company.",
        );
      await this.confirmation.verify(c, actorId, input.password, "ws.manage");
      const manageExpiresAt = new Date(
        Date.now() + input.durationMinutes * 60000,
      );
      await c.query(
        "UPDATE platform.workspace_sessions SET mode='manage',reason=$2,manage_expires_at=$3 WHERE id=$1 AND ended_at IS NULL",
        [workspace.sessionId, input.reason, manageExpiresAt],
      );
      await recordPlatformEvent(c, {
        actorId,
        action: "workspace.elevated",
        companyId: company.id,
        resourceType: "company",
        resourceId: company.public_id,
        after: { mode: "manage", reason: input.reason },
        payload: { sessionId: workspace.sessionId },
      });
      return {
        mode: "manage" as const,
        manageExpiresAt: manageExpiresAt.toISOString(),
      };
    });
  }

  async drop(workspace: NonNullable<Principal["workspace"]>, actorId: string) {
    return this.db.platform(async (c) => {
      await c.query(
        "UPDATE platform.workspace_sessions SET mode='read',manage_expires_at=NULL WHERE id=$1 AND ended_at IS NULL",
        [workspace.sessionId],
      );
      await recordPlatformEvent(c, {
        actorId,
        action: "workspace.dropped_to_read",
        companyId: workspace.company.uuid,
        resourceType: "company",
        resourceId: workspace.company.id,
        after: { mode: "read" },
        payload: { sessionId: workspace.sessionId },
      });
      return { mode: "read" as const };
    });
  }

  async exit(
    workspace: NonNullable<Principal["workspace"]>,
    actorId: string,
    reason?: string,
  ) {
    return this.db.platform(async (c) => {
      await c.query(
        "UPDATE platform.workspace_sessions SET ended_at=now(),end_reason=$2 WHERE id=$1 AND ended_at IS NULL",
        [workspace.sessionId, reason ?? "exited"],
      );
      await recordPlatformEvent(c, {
        actorId,
        action: "workspace.exited",
        companyId: workspace.company.uuid,
        resourceType: "company",
        resourceId: workspace.company.id,
        after: { reason: reason ?? null },
        payload: { sessionId: workspace.sessionId },
      });
      return { status: "ended" };
    });
  }

  /** Ends any active workspace session for a platform user, e.g. on logout. */
  async endAllFor(platformUserId: string) {
    await this.db.platform((c) =>
      c.query(
        "UPDATE platform.workspace_sessions SET ended_at=now(),end_reason='logout' WHERE platform_user_id=$1 AND ended_at IS NULL",
        [platformUserId],
      ),
    );
  }
}
