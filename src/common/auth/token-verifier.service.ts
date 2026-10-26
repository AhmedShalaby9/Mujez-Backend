import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { ENV, type Environment } from "../../config/env.js";
import type { Pool } from "./access.js";
export interface VerifiedIdentity {
  pool: Pool;
  claims: JWTPayload;
}
@Injectable()
export class TokenVerifier {
  private readonly issuers;
  constructor(@Inject(ENV) env: Environment) {
    this.issuers = (["COMPANY_ADMIN", "COMPANY_USER", "PLATFORM"] as const).map(
      (key) => ({
        pool: key.toLowerCase() as Pool,
        issuer: env[`AUTH_${key}_ISSUER`],
        audience: env[`AUTH_${key}_AUDIENCE`],
        keys: createRemoteJWKSet(new URL(env[`AUTH_${key}_JWKS_URL`]), {
          timeoutDuration: 3000,
          cooldownDuration: 30000,
        }),
      }),
    );
  }
  async verify(token: string, allowed: Pool[]): Promise<VerifiedIdentity> {
    for (const config of this.issuers.filter((i) => allowed.includes(i.pool))) {
      try {
        const { payload } = await jwtVerify(token, config.keys, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ["RS256", "ES256"],
          requiredClaims: ["sub", "exp", "iat"],
          clockTolerance: 5,
        });
        if (!payload.sub || payload.iat! > Date.now() / 1000 + 5) continue;
        return { pool: config.pool, claims: payload };
      } catch {
        /* Fail closed; never decode an unverified token into a principal. */
      }
    }
    throw new UnauthorizedException({
      code: "invalid_token",
      message: "A valid access token is required",
    });
  }
}
