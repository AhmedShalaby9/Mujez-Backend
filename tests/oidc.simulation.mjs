import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { importJWK, SignJWT, generateKeyPair } from "jose";
import { TokenVerifier } from "../dist/common/auth/token-verifier.service.js";
import { parseEnvironment } from "../dist/config/env.js";
const env = parseEnvironment({
  ...parseEnv(
    await readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ),
  AUTH_COMPANY_USER_JWKS_URL: "http://127.0.0.1:4919/oidc/jwks",
});
const key = await importJWK(
  JSON.parse(
    await readFile(
      new URL("./.generated/private-jwk.json", import.meta.url),
      "utf8",
    ),
  ),
  "RS256",
);
const verifier = new TokenVerifier(env);
const sign = async (overrides = {}, signingKey = key) =>
  new SignJWT({
    company_id: "10000000-0000-4000-8000-000000000001",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "mujez-test" })
    .setSubject("employee-1")
    .setIssuer(env.AUTH_COMPANY_USER_ISSUER)
    .setAudience(env.AUTH_COMPANY_USER_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
test("verifies signed employee token through real JWKS HTTP request to Postman simulation", async () => {
  const token = await sign();
  const identity = await verifier.verify(token, ["company_user"]);
  assert.equal(identity.pool, "company_user");
  assert.equal(identity.claims.sub, "employee-1");
});
test("rejects wrong signature", async () => {
  const other = await generateKeyPair("RS256");
  await assert.rejects(
    verifier.verify(await sign({}, other.privateKey), ["company_user"]),
  );
});
test("rejects wrong audience and expired token", async () => {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "mujez-test" })
    .setSubject("x")
    .setIssuer(env.AUTH_COMPANY_USER_ISSUER)
    .setAudience("wrong")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
  await assert.rejects(verifier.verify(token, ["company_user"]));
  const expired = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "mujez-test" })
    .setSubject("x")
    .setIssuer(env.AUTH_COMPANY_USER_ISSUER)
    .setAudience(env.AUTH_COMPANY_USER_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(key);
  await assert.rejects(verifier.verify(expired, ["company_user"]));
});
test("rejects a forged unsigned token", async () => {
  const token = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"forged"}').toString("base64url")}.`;
  await assert.rejects(verifier.verify(token, ["company_user"]));
});
