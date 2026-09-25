import { readFileSync } from "node:fs";
import { askJev } from "./jev.js";
import type { RouteChoice, RouteQuery, Tier } from "./types.js";

export type EvaluationCase = {
  id: string;
  prompt: string;
  expectedTier: Tier;
  contextTokens: number;
};

export type EvaluationResult = {
  id: string;
  expectedTier: Tier;
  predictedTier?: Tier;
  jevModel?: string;
  confidence?: number;
  latencyMs: number;
  jevInputTokens: number;
  error?: string;
};

export type EvaluationSummary = {
  total: number;
  classified: number;
  errors: number;
  correct: number;
  accuracy: number;
  classifiedAccuracy: number | null;
  errorRate: number;
  falseFast: number;
  riskyCases: number;
  falseFastRate: number | null;
  underRouted: number;
  underRoutingRate: number | null;
  p95JevLatencyMs: number | null;
  totalJevInputTokens: number;
  estimatedJevUsd: number;
  results: EvaluationResult[];
};

const TIERS = new Set(["fast", "balanced", "strong"]);
const TIER_RANK: Record<Tier, number> = { fast: 0, balanced: 1, strong: 2 };
const JEV_USD_PER_MILLION_INPUT_TOKENS = 0.042;

export function readEvaluationCases(path: string, maxCalls?: number): EvaluationCase[] {
  const cases: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(cases) || !cases.length) throw new Error("evaluation cases must be a non-empty array");
  if (maxCalls !== undefined && (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || cases.length > maxCalls)) {
    throw new Error("evaluation case count exceeds --max-calls");
  }
  const ids = new Set<string>();
  return cases.map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid evaluation case");
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim() || ids.has(record.id) ||
        typeof record.prompt !== "string" || !record.prompt.trim() ||
        !TIERS.has(record.expectedTier as string) || typeof record.contextTokens !== "number" ||
        !Number.isSafeInteger(record.contextTokens) || record.contextTokens < 0) {
      throw new Error("invalid evaluation case");
    }
    ids.add(record.id);
    return record as EvaluationCase;
  });
}

export async function evaluateCases(
  cases: EvaluationCase[],
  classify: (query: RouteQuery) => Promise<RouteChoice> = askJev,
): Promise<EvaluationSummary> {
  if (!cases.length) throw new Error("evaluation cases must be a non-empty array");
  const results: EvaluationResult[] = [];
  for (const item of cases) {
    const started = Date.now();
    try {
      const choice = await classify({ prompt: item.prompt, contextTokens: item.contextTokens, currentModel: "gpt-6-sol" });
      results.push({ id: item.id, expectedTier: item.expectedTier, predictedTier: choice.tier,
        jevModel: choice.jevModel, confidence: choice.confidence, latencyMs: Date.now() - started,
        jevInputTokens: choice.inputTokens ?? 0 });
    } catch {
      results.push({ id: item.id, expectedTier: item.expectedTier, latencyMs: Date.now() - started,
        jevInputTokens: 0, error: "jev-unavailable" });
    }
  }
  const classified = results.filter((result) => result.predictedTier);
  const correct = classified.filter((result) => result.expectedTier === result.predictedTier).length;
  const falseFast = classified.filter((result) => result.predictedTier === "fast" && result.expectedTier !== "fast").length;
  const underRouted = classified.filter((result) => result.predictedTier !== undefined &&
    TIER_RANK[result.predictedTier] < TIER_RANK[result.expectedTier]).length;
  const riskyCases = cases.filter((item) => item.expectedTier !== "fast").length;
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const totalJevInputTokens = results.reduce((sum, result) => sum + result.jevInputTokens, 0);
  return {
    total: cases.length,
    classified: classified.length,
    errors: cases.length - classified.length,
    correct,
    accuracy: correct / cases.length,
    classifiedAccuracy: classified.length ? correct / classified.length : null,
    errorRate: (cases.length - classified.length) / cases.length,
    falseFast,
    riskyCases,
    falseFastRate: riskyCases ? falseFast / riskyCases : null,
    underRouted,
    underRoutingRate: riskyCases ? underRouted / riskyCases : null,
    p95JevLatencyMs: latencies[Math.ceil(latencies.length * 0.95) - 1] ?? null,
    totalJevInputTokens,
    estimatedJevUsd: totalJevInputTokens * JEV_USD_PER_MILLION_INPUT_TOKENS / 1_000_000,
    results,
  };
}
