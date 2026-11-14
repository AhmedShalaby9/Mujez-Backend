import { KimiClient } from "../dist/infrastructure/ai/kimi.client.js";
try {
  const result = await KimiClient.fromEnvironment().complete(
    [
      {
        role: "user",
        content: "Compute 13 * 17. Reply with only the integer answer.",
      },
    ],
    1024,
  );
  if (
    result.content.trim() !== "221" ||
    !result.thinkingEnabled ||
    !result.reasoningReceived
  )
    throw Error("Kimi thinking smoke test failed");
  console.log(
    JSON.stringify({
      status: "passed",
      model: result.model,
      thinkingEnabled: result.thinkingEnabled,
      reasoningReceived: result.reasoningReceived,
      answer: result.content.trim(),
      usage: result.usage,
    }),
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
