import { askJev } from "./jev.js";
import { routingGuard } from "./policy.js";
import { writeMetric } from "./metrics.js";
import type { DecisionEvent, RouteChoice, RouteQuery } from "./types.js";

type ClaudeHookInput = { hook_event_name?: unknown; prompt?: unknown };

export async function observeClaudePrompt(
  input: ClaudeHookInput,
  metricsFile: string,
  classify: (query: RouteQuery) => Promise<RouteChoice> = askJev,
): Promise<DecisionEvent | null> {
  if (input.hook_event_name !== "UserPromptSubmit" || typeof input.prompt !== "string") return null;
  const query = { prompt: input.prompt, currentModel: "claude-current", contextTokens: 0 };
  // The legacy observer retains Claude's existing short-prompt behavior.
  const guard = input.prompt.trim().length < 12 ? "short-follow-up" : routingGuard(query);
  const started = Date.now();
  let event: DecisionEvent;
  if (guard) {
    event = { at: new Date().toISOString(), client: "claude", mode: "shadow", result: "kept", model: "claude-current", reason: guard };
  } else {
    try {
      const choice = await classify(query);
      event = { at: new Date().toISOString(), client: "claude", mode: "shadow", result: "shadow", model: "claude-current",
        recommendedTier: choice.tier, confidence: choice.confidence, jevInputTokens: choice.inputTokens,
        latencyMs: Date.now() - started, reason: "jev-choice" };
    } catch {
      event = { at: new Date().toISOString(), client: "claude", mode: "shadow", result: "error", model: "claude-current",
        latencyMs: Date.now() - started, reason: "jev-unavailable" };
    }
  }
  writeMetric(event, metricsFile);
  return event;
}
