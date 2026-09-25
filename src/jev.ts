import type { RouteChoice, RouteQuery, Tier } from "./types.js";

export type JevOptions = {
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const TIERS: ReadonlySet<string> = new Set(["fast", "balanced", "strong"]);

export async function askJev(query: RouteQuery, options: JevOptions = {}): Promise<RouteChoice> {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
  if (!apiKey) throw new Error("jev-key-missing");

  const request = {
    model: "jev-latest",
    state: {
      user_turn: query.prompt.slice(0, 1600),
      approximate_context_tokens: query.contextTokens,
      current_model: query.currentModel,
    },
    questions: {
      tier: {
        type: "choice",
        instructions: "Choose the least expensive model tier that can reliably complete this user turn. Assess the requested work, not the length of the message. If context is insufficient to judge, choose balanced.",
        criteria: {
          fast: "Simple formatting, direct facts, small unambiguous edits, or routine replies with low risk.",
          balanced: "Typical coding, writing, analysis, and multi-step tasks requiring sound judgment.",
          strong: "Hard debugging, architecture, high-stakes reasoning, complex cross-file changes, or ambiguous trade-offs.",
        },
      },
    },
  };

  const response = await (options.fetchImpl ?? fetch)(options.endpoint ?? "https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(options.timeoutMs ?? 1200),
  });
  if (!response.ok) throw new Error(`jev-http-${response.status}`);

  const result: unknown = await response.json();
  if (!result || typeof result !== "object") throw new Error("jev-response-invalid");
  const record = result as Record<string, unknown>;
  const answers = record.answers as Record<string, unknown> | undefined;
  const answer = answers?.tier as Record<string, unknown> | undefined;
  if (answer?.type !== "choice" || typeof answer.choice !== "string" || !TIERS.has(answer.choice)) {
    throw new Error("jev-choice-invalid");
  }
  if (typeof answer.confidence !== "number" || answer.confidence < 0 || answer.confidence > 1) {
    throw new Error("jev-confidence-invalid");
  }
  const usage = record.usage as Record<string, unknown> | undefined;
  const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined;
  return {
    tier: answer.choice as Tier, confidence: answer.confidence, inputTokens,
    ...(typeof record.model === "string" ? { jevModel: record.model } : {}),
  };
}
