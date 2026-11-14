# Kimi provider foundation

The private `KimiClient` adapter reads `KIMI_API_KEY`, `KIMI_BASE_URL`, `KIMI_MODEL`, `KIMI_THINKING` and `KIMI_REASONING_EFFORT` from the server environment. The configured model is `kimi-k3.1-pro`: thinking is native/always enabled, so requests use `reasoning_effort: high` and deliberately omit unsupported `thinking` and `temperature` parameters. Official contract: https://platform.kimi.ai/docs/guide/use-thinking-models .

Staging loads the optional protected `/opt/mujez-staging/shared/kimi.env`, independent of release directories and GitHub STAGING_ENV. The matching local configuration is in ignored `.env.kimi` (0600). No real keys belong in code, `.env.example`, runtime-config.json, browser requests, public integration endpoints or logs. Only the API container receives this optional configuration; mail/routing workers do not need it.

No application feature invokes Kimi automatically. This adds a reusable backend adapter/configuration and an explicit arithmetic smoke test only; no CRM/customer data is sent. Wait for the user's next feature instruction before wiring it to business flows.

Build, then run `node --env-file=.env.kimi scripts/test-kimi.mjs` locally, or supply the protected env file to an isolated staging test container. The smoke test makes one bounded request, expects 221, and checks that reasoning was returned without logging it. Errors omit upstream bodies and secrets; redirects are rejected, timeouts cancel requests and there are no automatic paid retries. `tests/kimi.test.mjs` uses a local HTTP stand-in to exercise the real fetch path for success, rate limits, timeout, truncation and configuration safety.
