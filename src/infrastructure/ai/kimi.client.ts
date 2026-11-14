import { z } from "zod";
const configSchema = z.object({
  apiKey: z.string().min(10),
  baseUrl: z
    .enum(["https://api.moonshot.ai/v1", "https://api.moonshot.cn/v1"])
    .default("https://api.moonshot.ai/v1"),
  model: z.literal("kimi-k3.1-pro").default("kimi-k3.1-pro"),
  thinking: z.literal(true).default(true),
  reasoningEffort: z.enum(["low", "high", "max"]).default("high"),
  timeoutMs: z.number().int().min(1).max(120000).default(60000),
});
export type KimiConfiguration = z.input<typeof configSchema>;
export type KimiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
export class KimiError extends Error {
  constructor(
    readonly kind:
      "configuration" | "upstream" | "timeout" | "network" | "invalid_response",
    readonly status?: number,
  ) {
    super(
      status
        ? `Kimi request failed (HTTP ${status})`
        : `Kimi request failed (${kind})`,
    );
  }
}
/** Private provider adapter. Nothing calls it automatically or exposes the key to a browser. */
export class KimiClient {
  #config: z.output<typeof configSchema>;
  constructor(
    config: KimiConfiguration,
    private readonly transport: typeof fetch = fetch,
  ) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new KimiError("configuration");
    this.#config = parsed.data;
  }
  static fromEnvironment(
    input: NodeJS.ProcessEnv = process.env,
    transport: typeof fetch = fetch,
  ) {
    if (input.KIMI_THINKING !== undefined && input.KIMI_THINKING !== "true")
      throw new KimiError("configuration");
    return new KimiClient(
      {
        apiKey: input.KIMI_API_KEY ?? "",
        baseUrl: input.KIMI_BASE_URL as KimiConfiguration["baseUrl"],
        model: input.KIMI_MODEL as KimiConfiguration["model"],
        thinking: true,
        reasoningEffort:
          input.KIMI_REASONING_EFFORT as KimiConfiguration["reasoningEffort"],
      },
      transport,
    );
  }
  async complete(messages: KimiMessage[], maxTokens = 4096) {
    if (
      !messages.length ||
      messages.length > 50 ||
      messages.some(
        (m) =>
          !["system", "user", "assistant"].includes(m.role) ||
          typeof m.content !== "string" ||
          m.content.length > 50000,
      ) ||
      !Number.isInteger(maxTokens) ||
      maxTokens < 64 ||
      maxTokens > 16000
    )
      throw new KimiError("configuration");
    const { apiKey, baseUrl, model, reasoningEffort, timeoutMs } = this.#config;
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await this.transport(baseUrl + "/chat/completions", {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          max_tokens: maxTokens,
          reasoning_effort: reasoningEffort,
        }),
        signal,
      });
    } catch {
      throw new KimiError(signal.aborted ? "timeout" : "network");
    }
    // Never surface upstream error bodies, which may echo keys, prompts or customer data.
    if (!response.ok) {
      await response.body?.cancel();
      throw new KimiError("upstream", response.status);
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new KimiError(signal.aborted ? "timeout" : "invalid_response");
    }
    const choice = data?.choices?.[0];
    if (
      choice?.finish_reason !== "stop" ||
      typeof choice?.message?.content !== "string" ||
      !choice.message.content.trim()
    )
      throw new KimiError("invalid_response");
    return {
      content: choice.message.content,
      model,
      thinkingEnabled: true as const,
      reasoningReceived:
        typeof choice.message.reasoning_content === "string" &&
        choice.message.reasoning_content.length > 0,
      usage: {
        promptTokens: Number(data.usage?.prompt_tokens ?? 0),
        completionTokens: Number(data.usage?.completion_tokens ?? 0),
      },
    };
  }
}
