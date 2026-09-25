import type { RouteChoice, RouteQuery, Tier } from "./types.js";
import { MAX_CLASSIFIER_PROMPT_CHARS } from "./policy.js";

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
      user_turn: query.prompt.slice(0, MAX_CLASSIFIER_PROMPT_CHARS),
      approximate_context_tokens: query.contextTokens,
      current_model: query.currentModel,
    },
    questions: {
      tier: {
        type: "choice",
        instructions: "Choose the least expensive model tier that can reliably complete this user turn. Assess the current requested work. Conversation length and the previous model are not evidence of task difficulty. Use strong only when the current task clearly requires it. If context is insufficient to judge, choose balanced.",
        criteria: {
          fast: "Simple formatting, direct facts, small unambiguous edits, or routine replies with low risk.",
          balanced: "Typical coding, writing, analysis, and multi-step tasks requiring sound judgment.",
          strong: "Hard debugging, architecture, high-stakes reasoning, complex cross-file changes, or ambiguous trade-offs.",
        },
      },
      effort: {
        type: "score",
        instructions: "How much reasoning does this user turn require? Judge the work independently of the model tier.",
        criteria: [
          "Immediate answer or mechanical edit; little reasoning.",
          "A few simple steps or a small choice.",
          "Several steps, ordinary coding, or a meaningful judgment.",
          "Complex debugging, planning, or interacting constraints.",
          "Open-ended or high-stakes work requiring the deepest reasoning.",
        ],
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
  const effort = answers?.effort as Record<string, unknown> | undefined;
  const effortScore = effort?.type === "score" && typeof effort.score === "number" &&
    Number.isFinite(effort.score) && effort.score >= 0 && effort.score <= 4 ? effort.score : undefined;
  const effortConfidence = typeof effort?.confidence === "number" && Number.isFinite(effort.confidence) &&
    effort.confidence >= 0 && effort.confidence <= 1 ? effort.confidence : undefined;
  const usage = record.usage as Record<string, unknown> | undefined;
  const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined;
  return {
    tier: answer.choice as Tier, confidence: answer.confidence, inputTokens,
    ...(effortScore === undefined ? {} : { effortScore }),
    ...(effortConfidence === undefined ? {} : { effortConfidence }),
    ...(typeof record.model === "string" ? { jevModel: record.model } : {}),
  };
}
