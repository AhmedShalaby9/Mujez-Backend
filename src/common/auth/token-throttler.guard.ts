import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
@Injectable()
export class TokenThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(
    req: Record<string, any>,
  ): Promise<string> {
    const token: unknown = req.headers?.authorization;
    return typeof token === "string"
      ? `token:${createHash("sha256").update(token).digest("hex")}`
      : `anonymous:${req.ip}`;
  }
}
