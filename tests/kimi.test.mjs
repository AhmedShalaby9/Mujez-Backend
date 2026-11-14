import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { KimiClient } from "../dist/infrastructure/ai/kimi.client.js";
const secret = "fake-test-key-never-real";
async function httpFixture(handler, work) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const transport = (url, options) => {
    assert.equal(url, "https://api.moonshot.ai/v1/chat/completions");
    return fetch(
      `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      options,
    );
  };
  try {
    await work(transport);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
test("Kimi uses thinking-compatible K3.1 parameters through real HTTP and returns only final content", async () => {
  await httpFixture(
    async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer " + secret);
      let raw = "";
      for await (const b of req) raw += b;
      const body = JSON.parse(raw);
      assert.equal(body.reasoning_effort, "high");
      assert.equal(body.model, "kimi-k3.1-pro");
      assert.equal(body.thinking, undefined);
      assert.equal(body.temperature, undefined);
      assert.equal(body.max_tokens, 1024);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "221",
                reasoning_content: "private reasoning",
              },
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 12 },
        }),
      );
    },
    async (transport) => {
      const c = new KimiClient({ apiKey: secret }, transport);
      const r = await c.complete([{ role: "user", content: "13 * 17" }], 1024);
      assert.equal(r.content, "221");
      assert.equal(r.thinkingEnabled, true);
      assert.equal(r.reasoningReceived, true);
      assert(!JSON.stringify(r).includes("private reasoning"));
      assert(!JSON.stringify(c).includes(secret));
    },
  );
});
test("Kimi rejects invalid settings and external endpoints before sending credentials", () => {
  assert.throws(
    () =>
      new KimiClient({ apiKey: secret, baseUrl: "https://example.test/v1" }),
  );
  assert.throws(() =>
    KimiClient.fromEnvironment({
      KIMI_API_KEY: secret,
      KIMI_THINKING: "false",
    }),
  );
  assert.throws(() => KimiClient.fromEnvironment({}));
});
test("Kimi never returns upstream secret bodies or retries charged requests automatically", async () => {
  let calls = 0;
  await httpFixture(
    (req, res) => {
      calls++;
      res.writeHead(429);
      res.end(JSON.stringify({ error: { message: secret } }));
    },
    async (transport) => {
      await assert.rejects(
        () =>
          new KimiClient({ apiKey: secret }, transport).complete([
            { role: "user", content: "Test" },
          ]),
        (e) => e.status === 429 && !e.message.includes(secret),
      );
    },
  );
  assert.equal(calls, 1);
});
test("Kimi cancels timed-out HTTP calls and rejects truncated output", async () => {
  await httpFixture(
    () => {},
    async (transport) => {
      await assert.rejects(
        () =>
          new KimiClient({ apiKey: secret, timeoutMs: 30 }, transport).complete(
            [{ role: "user", content: "Test" }],
          ),
        (e) => e.kind === "timeout",
      );
    },
  );
  await httpFixture(
    (req, res) => {
      res.end(
        JSON.stringify({
          choices: [
            { finish_reason: "length", message: { content: "Partial" } },
          ],
        }),
      );
    },
    async (transport) => {
      await assert.rejects(
        () =>
          new KimiClient({ apiKey: secret }, transport).complete([
            { role: "user", content: "Test" },
          ]),
        (e) => e.kind === "invalid_response",
      );
    },
  );
});
