import { readFileSync } from "node:fs";
import type { MetricsEvent, Tier } from "./types.js";

export type MetricsSummary = {
  total: number;
  byClient: Record<string, number>;
  byResult: Record<string, number>;
  byEffort: Record<string, number>;
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
  tasks: {
    started: number;
    withCompletedResponse: number;
    completedResponses: number;
    toolContinuations: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    p50RequestDurationMs: number | null;
    p95RequestDurationMs: number | null;
    p50ObservedSpanMs: number | null;
    p95ObservedSpanMs: number | null;
  };
};

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.ceil(values.length * fraction) - 1] ?? null;
}

export function summarizeMetrics(text: string, usdPerMillionInputTokens = 0.042): MetricsSummary {
  const events = text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as MetricsEvent]; } catch { return []; }
  });
  const byClient: Record<string, number> = {};
  const byResult: Record<string, number> = {};
  const byEffort: Record<string, number> = {};
  const recommendations: Record<Tier, number> = { fast: 0, balanced: 0, strong: 0 };
  const latencies: number[] = [];
  let jevInputTokens = 0;
  let observedResponses = 0;
  let differentModelIds = 0;
  let observedInputTokens = 0;
  let cachedInputTokens = 0;
  let observedOutputTokens = 0;
  let decisions = 0;
  type TaskRecord = { startedAt?: number; lastResponseAt?: number; decisionRequests: Set<string>; responseRequests: string[];
    responses: number; input: number; cached: number; output: number };
  const tasks = new Map<string, TaskRecord>();
  const requestDurations: number[] = [];
  for (const event of events) {
    const task = event.taskId ? (tasks.get(event.taskId) ?? (() => {
      const created: TaskRecord = { decisionRequests: new Set<string>(), responseRequests: [], responses: 0, input: 0, cached: 0, output: 0 };
      tasks.set(event.taskId!, created);
      return created;
    })()) : undefined;
    if ("kind" in event) {
      observedResponses += 1;
      if (event.requestedModel !== event.servedModel) differentModelIds += 1;
      observedInputTokens += event.inputTokens ?? 0;
      cachedInputTokens += event.cachedInputTokens ?? 0;
      observedOutputTokens += event.outputTokens ?? 0;
      if (task) {
        task.responses += 1;
        task.input += event.inputTokens ?? 0;
        task.cached += event.cachedInputTokens ?? 0;
        task.output += event.outputTokens ?? 0;
        task.responseRequests.push(event.requestId);
        const at = Date.parse(event.at);
        if (Number.isFinite(at)) task.lastResponseAt = Math.max(task.lastResponseAt ?? at, at);
      }
      if (task && typeof event.requestDurationMs === "number" && Number.isFinite(event.requestDurationMs) && event.requestDurationMs >= 0) {
        requestDurations.push(event.requestDurationMs);
      }
      continue;
    }
    decisions += 1;
    if (task) {
      if (event.requestId) task.decisionRequests.add(event.requestId);
      const at = Date.parse(event.at);
      if (Number.isFinite(at)) task.startedAt = Math.min(task.startedAt ?? at, at);
    }
    byClient[event.client] = (byClient[event.client] ?? 0) + 1;
    byResult[event.result] = (byResult[event.result] ?? 0) + 1;
    if (event.effort) byEffort[event.effort] = (byEffort[event.effort] ?? 0) + 1;
    if (event.recommendedTier && event.recommendedTier in recommendations) recommendations[event.recommendedTier] += 1;
    if (typeof event.latencyMs === "number") latencies.push(event.latencyMs);
    if (typeof event.jevInputTokens === "number") jevInputTokens += event.jevInputTokens;
  }
  latencies.sort((a, b) => a - b);
  const tracked = [...tasks.values()];
  const spans = tracked.flatMap((task) => task.startedAt !== undefined && task.lastResponseAt !== undefined && task.lastResponseAt >= task.startedAt
    ? [task.lastResponseAt - task.startedAt] : []);
  return {
    total: decisions, byClient, byResult, byEffort, recommendations,
    averageJevLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    p95JevLatencyMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] ?? null : null,
    jevInputTokens,
    estimatedJevUsd: jevInputTokens * usdPerMillionInputTokens / 1_000_000,
    observedResponses, differentModelIds, observedInputTokens, cachedInputTokens, observedOutputTokens,
    observedCacheReadRate: observedInputTokens ? cachedInputTokens / observedInputTokens : null,
    tasks: {
      started: tracked.filter((task) => task.startedAt !== undefined).length,
      withCompletedResponse: tracked.filter((task) => task.responses > 0).length,
      completedResponses: tracked.reduce((sum, task) => sum + task.responses, 0),
      toolContinuations: tracked.reduce((sum, task) => sum + task.responseRequests.filter((id) => !task.decisionRequests.has(id)).length, 0),
      inputTokens: tracked.reduce((sum, task) => sum + task.input, 0),
      cachedInputTokens: tracked.reduce((sum, task) => sum + task.cached, 0),
      outputTokens: tracked.reduce((sum, task) => sum + task.output, 0),
      p50RequestDurationMs: percentile(requestDurations, 0.5),
      p95RequestDurationMs: percentile(requestDurations, 0.95),
      p50ObservedSpanMs: percentile(spans, 0.5),
      p95ObservedSpanMs: percentile(spans, 0.95),
    },
  };
}

export function readMetricsFile(path: string, usdPerMillionInputTokens?: number): MetricsSummary {
  return summarizeMetrics(readFileSync(path, "utf8"), usdPerMillionInputTokens);
}
