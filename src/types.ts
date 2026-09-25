export type Tier = "fast" | "balanced" | "strong";
export type Mode = "pass" | "force" | "shadow" | "auto";

export type RouteChoice = {
  tier: Tier;
  confidence: number;
  inputTokens?: number;
  jevModel?: string;
};

export type RouteQuery = {
  prompt: string;
  currentModel: string;
  contextTokens: number;
};

export type RouteResult = {
  model: string;
  tier?: Tier;
  confidence?: number;
  reason: string;
};

export type RouterSettings = {
  mode: Mode;
  baselineModel: string;
  forceModel?: string;
  models: Record<Tier, string>;
  minimumConfidence: number;
  maxContextTokens: number;
};

export type DecisionEvent = {
  at: string;
  client: "codex" | "claude";
  mode: Mode;
  result: "routed" | "kept" | "manual" | "shadow" | "error";
  model: string;
  recommendedTier?: Tier;
  confidence?: number;
  latencyMs?: number;
  jevInputTokens?: number;
  reason: string;
};
