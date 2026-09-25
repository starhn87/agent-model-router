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
  effort?: Effort;
  tier?: Tier;
  confidence?: number;
  reason: string;
};

export type RouterSettings = {
  mode: Mode;
  // Client model ID used as the Auto selector; not the default execution model.
  baselineModel: string;
  forceModel?: string;
  models: Record<Tier, string>;
  minimumConfidence: number;
  autoEffort: boolean;
  minimumDowngradeConfidence?: number;
  // Per-tier confidence to evaluate in the log only; the applied route is unchanged.
  shadowConfidence?: Partial<Record<Tier, number>>;
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
  taskId?: string;
  reason: string;
  // What the route would have been under settings.shadowConfidence, when it differs.
  shadowModel?: string;
  shadowEffort?: string;
};

export type ResponseObservationEvent = {
  at: string;
  client: "codex" | "claude";
  kind: "response";
  requestId: string;
  taskId?: string;
  requestDurationMs?: number;
  requestedModel: string;
  requestedEffort?: string;
  servedModel: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
};

export type MetricsEvent = DecisionEvent | ResponseObservationEvent;
