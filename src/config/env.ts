import ipaddr from "ipaddr.js";
import { z } from "zod";
export const ENV = Symbol("ENV");
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  PLATFORM_DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  TRUST_PROXY_CIDRS: z.string().default(""),
  CORS_ORIGINS: z.string().default("http://localhost:4200"),
});
export type Environment = z.infer<typeof schema>;
export function parseEnvironment(input: NodeJS.ProcessEnv): Environment {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error(
      "Invalid configuration: " +
        result.error.issues.map((i) => i.path.join(".")).join(","),
    );
  const env = result.data;
  for (const cidr of env.TRUST_PROXY_CIDRS.split(",").filter(Boolean)) {
    const range = ipaddr.parseCIDR(cidr);
    if (range[1] === 0)
      throw new Error("Unrestricted proxy trust is forbidden");
  }
  for (const key of ["DATABASE_URL", "PLATFORM_DATABASE_URL"] as const)
    if (!["postgres:", "postgresql:"].includes(new URL(env[key]).protocol))
      throw new Error(key + " must use PostgreSQL");
  if (!["redis:", "rediss:"].includes(new URL(env.REDIS_URL).protocol))
    throw new Error("REDIS_URL must use Redis");
  for (const origin of env.CORS_ORIGINS.split(",")) {
    if (
      new URL(origin).origin !== origin ||
      (env.NODE_ENV === "production" && !origin.startsWith("https://"))
    )
      throw new Error("Invalid CORS origin");
  }
  return env;
}
