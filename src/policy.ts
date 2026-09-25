import type { Effort, RouteChoice, RouteQuery, RouteResult, RouterSettings } from "./types.js";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function effortFromScore(score: number | undefined): Effort | undefined {
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 4) return undefined;
  return EFFORTS[Math.round(score)];
}

export function defaultSettings(mode: RouterSettings["mode"] = "shadow"): RouterSettings {
  return {
    mode,
    baselineModel: "gpt-6-sol",
    models: {
      fast: "gpt-6-luna",
      balanced: "gpt-6-sol",
      strong: "gpt-6-astra",
    },
    minimumConfidence: 0.8,
    autoEffort: true,
    maxContextTokens: 24_000,
  };
}

const SENSITIVE_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|bearer|password|secret)\s*[:=]\s*\S+|\.env\b)/i;

export function routingGuard(query: RouteQuery, settings: RouterSettings): string | null {
  const prompt = query.prompt.trim();
  if (prompt.length < 12) return "short-follow-up";
  if (query.contextTokens > settings.maxContextTokens) return "large-context";
  if (SENSITIVE_PATTERN.test(prompt)) return "sensitive-prompt";
  return null;
}

export function fallbackModel(currentModel: string, settings: RouterSettings): string {
  return currentModel === settings.models.fast ? settings.baselineModel : currentModel;
}

export function chooseModel(
  query: RouteQuery,
  choice: RouteChoice | null,
  settings: RouterSettings,
  allowedModels?: ReadonlySet<string>,
): RouteResult {
  const guard = routingGuard(query, settings);
  if (guard) return { model: guard === "short-follow-up" ? query.currentModel : fallbackModel(query.currentModel, settings), reason: guard };
  if (!choice) return { model: fallbackModel(query.currentModel, settings), reason: "router-unavailable" };
  if (choice.confidence < settings.minimumConfidence) {
    return { model: fallbackModel(query.currentModel, settings), tier: choice.tier, confidence: choice.confidence, reason: "low-confidence" };
  }
  const model = settings.models[choice.tier];
  if (allowedModels?.size && !allowedModels.has(model)) {
    return { model: fallbackModel(query.currentModel, settings), tier: choice.tier, confidence: choice.confidence, reason: "model-unavailable" };
  }
  const tiers: (keyof RouterSettings["models"])[] = ["fast", "balanced", "strong"];
  const currentRank = tiers.findIndex((tier) => settings.models[tier] === query.currentModel);
  const nextRank = tiers.indexOf(choice.tier);
  if (settings.minimumDowngradeConfidence !== undefined && currentRank >= 0 && nextRank < currentRank &&
      choice.confidence < settings.minimumDowngradeConfidence) {
    return { model: query.currentModel, tier: choice.tier, confidence: choice.confidence, reason: "downgrade-held" };
  }
  return { model, tier: choice.tier, confidence: choice.confidence, reason: model === query.currentModel ? "same-model" : "jev-choice" };
}
