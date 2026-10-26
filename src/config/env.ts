import { z } from "zod";
import ipaddr from "ipaddr.js";

const url = z.string().url();
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: url,
  PLATFORM_DATABASE_URL: url,
  REDIS_URL: url,
  CORS_ORIGINS: z.string().default("http://localhost:4200"),
  PLATFORM_IP_ALLOWLIST: z.string().min(1),
  AUTH_COMPANY_ADMIN_ISSUER: url,
  AUTH_COMPANY_ADMIN_AUDIENCE: z.string().min(1),
  AUTH_COMPANY_ADMIN_JWKS_URL: url,
  AUTH_COMPANY_USER_ISSUER: url,
  AUTH_COMPANY_USER_AUDIENCE: z.string().min(1),
  AUTH_COMPANY_USER_JWKS_URL: url,
  AUTH_PLATFORM_ISSUER: url,
  AUTH_PLATFORM_AUDIENCE: z.string().min(1),
  AUTH_PLATFORM_JWKS_URL: url,
});
export type Environment = z.infer<typeof schema>;
export const ENV = Symbol("ENV");

export function parseEnvironment(input: NodeJS.ProcessEnv): Environment {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  const env = parsed.data;
  for (const key of ["DATABASE_URL", "PLATFORM_DATABASE_URL"] as const) {
    if (!["postgres:", "postgresql:"].includes(new URL(env[key]).protocol))
      throw new Error(`${key} must use PostgreSQL`);
  }
  if (!["redis:", "rediss:"].includes(new URL(env.REDIS_URL).protocol))
    throw new Error("REDIS_URL must use Redis");
  const identities = ["COMPANY_ADMIN", "COMPANY_USER", "PLATFORM"] as const;
  if (new Set(identities.map((i) => env[`AUTH_${i}_ISSUER`])).size !== 3)
    throw new Error("Three separate identity issuers are required");
  const ranges = env.PLATFORM_IP_ALLOWLIST.split(",").map((s) => s.trim());
  for (const range of ranges) {
    ipaddr.parseCIDR(range);
    if (range.endsWith("/0"))
      throw new Error("Platform IP allowlist cannot allow every address");
  }
  for (const origin of env.CORS_ORIGINS.split(",")) {
    if (new URL(origin.trim()).origin !== origin.trim())
      throw new Error("CORS requires explicit origins");
  }
  if (env.NODE_ENV === "production") {
    for (const i of identities) {
      if (
        ![env[`AUTH_${i}_ISSUER`], env[`AUTH_${i}_JWKS_URL`]].every((s) =>
          s.startsWith("https://"),
        )
      )
        throw new Error("Production OIDC requires HTTPS");
    }
    if (
      env.CORS_ORIGINS.split(",").some((s) => !s.trim().startsWith("https://"))
    )
      throw new Error("Production CORS requires HTTPS");
  }
  return env;
}
