export type Tier = "fast" | "balanced" | "strong";
export type Mode = "pass" | "force" | "shadow" | "auto";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type RouteChoice = {
  tier: Tier;
  confidence: number;
  effortScore?: number;
  effortConfidence?: number;
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
  autoEffort: boolean;
  minimumDowngradeConfidence?: number;
  maxContextTokens: number;
};

export type DecisionEvent = {
  at: string;
  client: "codex" | "claude";
  mode: Mode;
  result: "routed" | "kept" | "manual" | "shadow" | "error";
  model: string;
  effort?: string;
  recommendedEffort?: Effort;
  recommendedTier?: Tier;
  confidence?: number;
  latencyMs?: number;
  jevInputTokens?: number;
  requestId?: string;
  reason: string;
};

export type ResponseObservationEvent = {
  at: string;
  client: "codex";
  kind: "response";
  requestId: string;
  requestedModel: string;
  requestedEffort?: string;
  servedModel: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
};

export type MetricsEvent = DecisionEvent | ResponseObservationEvent;
