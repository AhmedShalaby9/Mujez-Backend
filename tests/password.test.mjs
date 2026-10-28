import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../dist/common/auth/password.js";
test("salted password hashes accept correct passwords and reject altered values", async () => {
  const a = await hashPassword("test-password-123"),
    b = await hashPassword("test-password-123");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("test-password-123", a), true);
  assert.equal(await verifyPassword("wrong-password", a), false);
  assert.equal(
    await verifyPassword("test-password-123", a.slice(0, -2)),
    false,
  );
});
