import { readFileSync } from "node:fs";
import { agentCost, priceFor, usageUsd, type AgentCost, type PriceTable, type TokenUsage } from "./pricing.js";
import type { MetricsEvent, Tier } from "./types.js";

// Below this many Jev attempts an error rate is too noisy to warn about.
const MIN_ATTEMPTS_FOR_WARNING = 10;
const ERROR_RATE_WARNING = 0.2;

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
  jevAttempts: number;
  jevErrors: number;
  jevErrorRate: number | null;
  warnings: string[];
  agentCost?: AgentCost;
  // Turns a shadow confidence would have routed differently. Priced with the same
  // observed tokens, so the delta is an estimate; quality under the shadow model is unknown.
  shadow: {
    decisions: number;
    byModel: Record<string, number>;
    tasks: number;
    responses: number;
    appliedUsd: number | null;
    shadowUsd: number | null;
  };
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

export function summarizeMetrics(text: string, usdPerMillionInputTokens = 0.042, prices?: PriceTable, since?: number): MetricsSummary {
  const events = text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as MetricsEvent]; } catch { return []; }
  }).filter((event) => since === undefined || Date.parse(event.at) >= since);
  const shadowTasks = new Map<string, string>();
  const shadowByModel: Record<string, number> = {};
  let shadowDecisions = 0;
  for (const event of events) {
    if ("kind" in event || typeof event.shadowModel !== "string") continue;
    shadowDecisions += 1;
    shadowByModel[event.shadowModel] = (shadowByModel[event.shadowModel] ?? 0) + 1;
    if (event.taskId) shadowTasks.set(event.taskId, event.shadowModel);
  }
  let shadowResponses = 0;
  let appliedUsd: number | null = prices ? 0 : null;
  let shadowUsd: number | null = prices ? 0 : null;
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
  let jevAttempts = 0;
  let jevErrors = 0;
  const usages: TokenUsage[] = [];
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
      usages.push(event);
      const shadowModel = event.taskId ? shadowTasks.get(event.taskId) : undefined;
      if (shadowModel) {
        shadowResponses += 1;
        const applied = prices && priceFor(prices, event.servedModel);
        const alternative = prices && priceFor(prices, shadowModel);
        if (applied && alternative && appliedUsd !== null && shadowUsd !== null) {
          appliedUsd += usageUsd(applied, event);
          shadowUsd += usageUsd(alternative, event);
        } else appliedUsd = shadowUsd = null;
      }
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
    // Local routes carry no latency; every Jev call, answered or failed, does.
    if (typeof event.latencyMs === "number" || event.result === "error") jevAttempts += 1;
    if (event.result === "error") jevErrors += 1;
    if (typeof event.jevInputTokens === "number") jevInputTokens += event.jevInputTokens;
  }
  latencies.sort((a, b) => a - b);
  const jevErrorRate = jevAttempts ? jevErrors / jevAttempts : null;
  const warnings = jevErrorRate !== null && jevAttempts >= MIN_ATTEMPTS_FOR_WARNING && jevErrorRate >= ERROR_RATE_WARNING
    ? [`Jev failed ${jevErrors} of ${jevAttempts} calls (${Math.round(jevErrorRate * 100)}%); those turns fell back to the balanced model, so routing savings are reduced.`]
    : [];
  const tracked = [...tasks.values()];
  const spans = tracked.flatMap((task) => task.startedAt !== undefined && task.lastResponseAt !== undefined && task.lastResponseAt >= task.startedAt
    ? [task.lastResponseAt - task.startedAt] : []);
  return {
    total: decisions, byClient, byResult, byEffort, recommendations,
    averageJevLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    p95JevLatencyMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] ?? null : null,
    jevInputTokens,
    estimatedJevUsd: jevInputTokens * usdPerMillionInputTokens / 1_000_000,
    jevAttempts, jevErrors, jevErrorRate, warnings,
    ...(prices ? { agentCost: agentCost(prices, usages) } : {}),
    shadow: { decisions: shadowDecisions, byModel: shadowByModel, tasks: shadowTasks.size, responses: shadowResponses,
      appliedUsd: shadowResponses ? appliedUsd : null, shadowUsd: shadowResponses ? shadowUsd : null },
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

export function readMetricsFile(path: string, prices?: PriceTable, since?: number): MetricsSummary {
  return summarizeMetrics(readFileSync(path, "utf8"), undefined, prices, since);
}
