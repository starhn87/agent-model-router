import { readFileSync } from "node:fs";
import type { DecisionEvent, Tier } from "./types.js";

export type MetricsSummary = {
  total: number;
  byClient: Record<string, number>;
  byResult: Record<string, number>;
  recommendations: Record<Tier, number>;
  averageJevLatencyMs: number | null;
  p95JevLatencyMs: number | null;
  jevInputTokens: number;
  estimatedJevUsd: number;
};

export function summarizeMetrics(text: string, usdPerMillionInputTokens = 0.042): MetricsSummary {
  const events = text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as DecisionEvent]; } catch { return []; }
  });
  const byClient: Record<string, number> = {};
  const byResult: Record<string, number> = {};
  const recommendations: Record<Tier, number> = { fast: 0, balanced: 0, strong: 0 };
  const latencies: number[] = [];
  let jevInputTokens = 0;
  for (const event of events) {
    byClient[event.client] = (byClient[event.client] ?? 0) + 1;
    byResult[event.result] = (byResult[event.result] ?? 0) + 1;
    if (event.recommendedTier && event.recommendedTier in recommendations) recommendations[event.recommendedTier] += 1;
    if (typeof event.latencyMs === "number") latencies.push(event.latencyMs);
    if (typeof event.jevInputTokens === "number") jevInputTokens += event.jevInputTokens;
  }
  latencies.sort((a, b) => a - b);
  return {
    total: events.length, byClient, byResult, recommendations,
    averageJevLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    p95JevLatencyMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] ?? null : null,
    jevInputTokens,
    estimatedJevUsd: jevInputTokens * usdPerMillionInputTokens / 1_000_000,
  };
}

export function readMetricsFile(path: string, usdPerMillionInputTokens?: number): MetricsSummary {
  return summarizeMetrics(readFileSync(path, "utf8"), usdPerMillionInputTokens);
}
