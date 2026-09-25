import type { Effort, RouteChoice, RouteQuery, RouteResult, RouterSettings } from "./types.js";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const MAX_CLASSIFIER_PROMPT_CHARS = 1600;

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
  };
}

export const SENSITIVE_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|bearer|password|secret)\s*[:=]\s*\S+|\.env\b)/i;
const ACKNOWLEDGEMENTS = new Set(["응", "네", "예", "좋아", "좋아요", "오케이", "알겠어", "ok", "okay", "yes"]);
const CONTINUATIONS = [
  /^(?:(?:그대로|이어서|계속) )?(?:계속|진행)(?:해(?:\s?줘|주세요|요)?)?$/u,
  /^(?:(?:그대로|이어서) )?(?:해\s?줘|다시\s?해(?:\s?줘|주세요|요)?)$/u,
  /^(?:그|그거|그 문장|이전 답변|위 문장)(?:을|를)? (?:고쳐줘|수정해줘)$/u,
  /^(?:please )?(?:continue|go ahead|proceed|do it|try again)(?: please)?$/u,
];

function isContinuation(prompt: string): boolean {
  const words = prompt.toLowerCase().replace(/[.!?,。！？\s]+/gu, " ").trim().split(" ");
  while (words.length && ACKNOWLEDGEMENTS.has(words[0]!)) words.shift();
  return words.length === 0 || CONTINUATIONS.some((pattern) => pattern.test(words.join(" ")));
}

export function routingGuard(query: RouteQuery): string | null {
  const prompt = query.prompt.trim();
  if (SENSITIVE_PATTERN.test(prompt)) return "sensitive-prompt";
  // Never choose from a truncated task. Conversation history alone is not a guard.
  if (prompt.length > MAX_CLASSIFIER_PROMPT_CHARS) return "oversized-prompt";
  if (isContinuation(prompt)) return "context-follow-up";
  return null;
}

export function fallbackModel(currentModel: string, settings: RouterSettings, allowedModels?: ReadonlySet<string>): string {
  const balanced = settings.models.balanced;
  if (!allowedModels?.size || allowedModels.has(balanced)) return balanced;
  // Catalog availability is the only reason a fallback may retain another model.
  return [currentModel, settings.baselineModel, settings.models.strong, settings.models.fast]
    .find((model) => allowedModels.has(model)) ?? allowedModels.values().next().value!;
}

export function isSimpleTurn(prompt: string): boolean {
  if (/^(?:안녕(?:하세요|하십니까)?|반가워(?:요)?|hello|hi|hey)[.!~\s]*$/iu.test(prompt)) return true;
  if (prompt.length > 240 || /[\r\n]/u.test(prompt)) return false;
  // Require supplied text plus an exact correction instruction, not a keyword.
  const korean = prompt.match(/^(.+?)(?:의)?\s+(?:맞춤법|문법|오탈자)(?:을|를)?\s*(?:고쳐\s*줘|수정해\s*줘|교정해\s*줘)[.!?\s]*$/u);
  const english = prompt.match(/^(?:fix|correct) (?:the )?(?:spelling|grammar)(?: of| in)?\s*:\s*(.+)$/iu);
  const supplied = korean?.[1] ?? english?.[1];
  if (!supplied) return false;
  // Quoted prose in either language, or a short standalone English sentence.
  const quoted = supplied.match(/^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|“([^”\r\n]+)”|‘([^’\r\n]+)’)$/u);
  if (quoted) {
    const prose = quoted.slice(1).find((part) => part !== undefined)!;
    return /\p{L}/u.test(prose) && /^[\p{L}\p{N}\s,.!?…'’“-]+$/u.test(prose);
  }
  if (/^(?:this|that|it|the above|previous|above)(?:\s|$)/iu.test(supplied)) return false;
  return /^[a-z][a-z ',.!?’-]*$/iu.test(supplied) && supplied.trim().split(/\s+/u).length >= 3;
}

export function localRoute(query: RouteQuery, settings: RouterSettings, allowedModels?: ReadonlySet<string>): RouteResult | null {
  const guard = routingGuard(query);
  if (guard === "context-follow-up") return { model: query.currentModel, reason: guard };
  if (guard) return { model: fallbackModel(query.currentModel, settings, allowedModels), effort: "medium", reason: guard };
  if (!isSimpleTurn(query.prompt.trim())) return null;
  if (allowedModels?.size && !allowedModels.has(settings.models.fast)) {
    return { model: fallbackModel(query.currentModel, settings, allowedModels), effort: "medium", reason: "model-unavailable" };
  }
  return { model: settings.models.fast, effort: "low", tier: "fast", confidence: 1, reason: "simple-turn" };
}

// The route a lower tier confidence would have chosen, or null when it matches the applied one.
export function shadowRoute(query: RouteQuery, choice: RouteChoice, applied: RouteResult, settings: RouterSettings,
  allowedModels?: ReadonlySet<string>): RouteResult | null {
  const threshold = settings.shadowConfidence?.[choice.tier];
  if (threshold === undefined || (applied.reason !== "low-confidence" && applied.reason !== "downgrade-fallback")) return null;
  const alternative = chooseModel(query, choice, { ...settings, shadowConfidence: undefined,
    minimumConfidence: Math.min(settings.minimumConfidence, threshold),
    ...(settings.minimumDowngradeConfidence === undefined ? {} : { minimumDowngradeConfidence: Math.min(settings.minimumDowngradeConfidence, threshold) }),
  }, allowedModels);
  return alternative.model === applied.model ? null : alternative;
}

export function chooseModel(
  query: RouteQuery,
  choice: RouteChoice | null,
  settings: RouterSettings,
  allowedModels?: ReadonlySet<string>,
): RouteResult {
  const local = localRoute(query, settings, allowedModels);
  if (local) return local;
  const fallback = { model: fallbackModel(query.currentModel, settings, allowedModels), effort: "medium" as const };
  if (!choice) return { ...fallback, reason: "router-unavailable" };
  if (choice.confidence < settings.minimumConfidence) {
    return { ...fallback, tier: choice.tier, confidence: choice.confidence, reason: "low-confidence" };
  }
  const model = settings.models[choice.tier];
  if (allowedModels?.size && !allowedModels.has(model)) {
    return { ...fallback, tier: choice.tier, confidence: choice.confidence, reason: "model-unavailable" };
  }
  const tiers: (keyof RouterSettings["models"])[] = ["fast", "balanced", "strong"];
  const currentRank = tiers.findIndex((tier) => settings.models[tier] === query.currentModel);
  const nextRank = tiers.indexOf(choice.tier);
  if (settings.minimumDowngradeConfidence !== undefined && currentRank >= 0 && nextRank < currentRank &&
      choice.confidence < settings.minimumDowngradeConfidence) {
    return { ...fallback, tier: choice.tier, confidence: choice.confidence, reason: "downgrade-fallback" };
  }
  const defaultEffort = { fast: "low", balanced: "medium", strong: "high" } as const;
  const effort = choice.effortConfidence !== undefined && choice.effortConfidence < settings.minimumConfidence
    ? defaultEffort[choice.tier] : effortFromScore(choice.effortScore) ?? defaultEffort[choice.tier];
  return { model, effort, tier: choice.tier, confidence: choice.confidence, reason: model === query.currentModel ? "same-model" : "jev-choice" };
}
