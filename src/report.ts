import { readFileSync } from "node:fs";
import type { MetricsEvent, Tier } from "./types.js";

export type MetricsSummary = {
  total: number;
  byClient: Record<string, number>;
  byResult: Record<string, number>;
  recommendations: Record<Tier, number>;
  averageJevLatencyMs: number | null;
  p95JevLatencyMs: number | null;
  jevInputTokens: number;
  estimatedJevUsd: number;
  observedResponses: number;
  differentModelIds: number;
  observedInputTokens: number;
  cachedInputTokens: number;
  observedOutputTokens: number;
  observedCacheReadRate: number | null;
};

export function summarizeMetrics(text: string, usdPerMillionInputTokens = 0.042): MetricsSummary {
  const events = text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as MetricsEvent]; } catch { return []; }
  });
  const byClient: Record<string, number> = {};
  const byResult: Record<string, number> = {};
  const recommendations: Record<Tier, number> = { fast: 0, balanced: 0, strong: 0 };
  const latencies: number[] = [];
  let jevInputTokens = 0;
  let observedResponses = 0;
  let differentModelIds = 0;
  let observedInputTokens = 0;
  let cachedInputTokens = 0;
  let observedOutputTokens = 0;
  let decisions = 0;
  for (const event of events) {
    if ("kind" in event) {
      observedResponses += 1;
      if (event.requestedModel !== event.servedModel) differentModelIds += 1;
      observedInputTokens += event.inputTokens ?? 0;
      cachedInputTokens += event.cachedInputTokens ?? 0;
      observedOutputTokens += event.outputTokens ?? 0;
      continue;
    }
    decisions += 1;
    byClient[event.client] = (byClient[event.client] ?? 0) + 1;
    byResult[event.result] = (byResult[event.result] ?? 0) + 1;
    if (event.recommendedTier && event.recommendedTier in recommendations) recommendations[event.recommendedTier] += 1;
    if (typeof event.latencyMs === "number") latencies.push(event.latencyMs);
    if (typeof event.jevInputTokens === "number") jevInputTokens += event.jevInputTokens;
  }
  latencies.sort((a, b) => a - b);
  return {
    total: decisions, byClient, byResult, recommendations,
    averageJevLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    p95JevLatencyMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] ?? null : null,
    jevInputTokens,
    estimatedJevUsd: jevInputTokens * usdPerMillionInputTokens / 1_000_000,
    observedResponses, differentModelIds, observedInputTokens, cachedInputTokens, observedOutputTokens,
    observedCacheReadRate: observedInputTokens ? cachedInputTokens / observedInputTokens : null,
  };
}

export function readMetricsFile(path: string, usdPerMillionInputTokens?: number): MetricsSummary {
  return summarizeMetrics(readFileSync(path, "utf8"), usdPerMillionInputTokens);
}
