import assert from "node:assert/strict";
import test from "node:test";
import { summarizeMetrics } from "./report.js";

test("summary computes latency, decisions, and Jev-only input cost", () => {
  const input = [
    { client: "codex", result: "routed", recommendedTier: "fast", effort: "low", latencyMs: 100, jevInputTokens: 1000 },
    { client: "claude", result: "shadow", recommendedTier: "strong", latencyMs: 300, jevInputTokens: 2000 },
  ].map((event) => JSON.stringify(event)).join("\n");
  const summary = summarizeMetrics(input);
  assert.equal(summary.total, 2);
  assert.equal(summary.averageJevLatencyMs, 200);
  assert.equal(summary.p95JevLatencyMs, 300);
  assert.equal(summary.jevInputTokens, 3000);
  assert.deepEqual(summary.byEffort, { low: 1 });
  assert.ok(Math.abs(summary.estimatedJevUsd - 0.000126) < 1e-10);
});

test("response observations show served models and cache reads without doubling decision counts", () => {
  const input = [
    { client: "codex", result: "routed", model: "gpt-6-luna" },
    { client: "codex", kind: "response", requestedModel: "gpt-6-luna", servedModel: "gpt-6-sol", inputTokens: 100, cachedInputTokens: 75, outputTokens: 10 },
  ].map((event) => JSON.stringify(event)).join("\n");
  const summary = summarizeMetrics(input);
  assert.equal(summary.total, 1);
  assert.equal(summary.observedResponses, 1);
  assert.equal(summary.differentModelIds, 1);
  assert.equal(summary.observedCacheReadRate, 0.75);
});

test("task summary includes tool calls and reports only observed spans", () => {
  const input = [
    { at: "2026-01-01T00:00:00.000Z", client: "codex", result: "routed", requestId: "first", taskId: "anonymous-1" },
    { at: "2026-01-01T00:00:00.100Z", client: "codex", kind: "response", requestId: "first", taskId: "anonymous-1", requestedModel: "fast", servedModel: "fast", inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, requestDurationMs: 100 },
    { at: "2026-01-01T00:00:00.250Z", client: "codex", kind: "response", requestId: "tool", taskId: "anonymous-1", requestedModel: "fast", servedModel: "fast", inputTokens: 200, cachedInputTokens: 180, outputTokens: 20, requestDurationMs: 120 },
    { at: "2026-01-01T00:00:00.300Z", client: "codex", result: "kept", requestId: "second", taskId: "anonymous-2" },
  ].map((event) => JSON.stringify(event)).join("\n");
  const tasks = summarizeMetrics(input).tasks;
  assert.equal(tasks.started, 2);
  assert.equal(tasks.withCompletedResponse, 1);
  assert.equal(tasks.toolContinuations, 1);
  assert.equal(tasks.inputTokens, 300);
  assert.equal(tasks.cachedInputTokens, 260);
  assert.equal(tasks.outputTokens, 30);
  assert.equal(tasks.p50RequestDurationMs, 100);
  assert.equal(tasks.p95ObservedSpanMs, 250);
});

test("a price table estimates agent cost per served model and against the reference model", () => {
  const prices = { schemaVersion: 1 as const, referenceModel: "strong", models: {
    fast: { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 10 },
    strong: { inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 100 },
  } };
  const input = [
    { client: "claude", kind: "response", requestedModel: "fast", servedModel: "fast-20251001",
      inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 },
    { client: "codex", kind: "response", requestedModel: "other", servedModel: "other", inputTokens: 10, outputTokens: 1 },
  ].map((event) => JSON.stringify(event)).join("\n");
  const cost = summarizeMetrics(input, undefined, prices).agentCost!;
  assert.ok(Math.abs(cost.estimatedUsd - 1.55) < 1e-9);
  assert.ok(Math.abs(cost.referenceUsd! - 15.5) < 1e-9);
  assert.ok(Math.abs(cost.estimatedSavingsPercent! - 90) < 1e-9);
  assert.equal(cost.unpricedResponses, 1);
  assert.equal(cost.byModel.other!.usd, null);
  assert.equal(summarizeMetrics(input).agentCost, undefined);
});

test("a high Jev error rate is reported as a warning once enough calls were attempted", () => {
  const line = (result: string) => JSON.stringify({ client: "codex", result, latencyMs: 100 });
  const failing = [...Array(3).fill(line("error")), ...Array(7).fill(line("routed")),
    JSON.stringify({ client: "codex", result: "kept", reason: "simple-turn" })].join("\n");
  const summary = summarizeMetrics(failing);
  assert.equal(summary.jevAttempts, 10);
  assert.equal(summary.jevErrorRate, 0.3);
  assert.equal(summary.warnings.length, 1);
  assert.deepEqual(summarizeMetrics([line("error"), line("routed")].join("\n")).warnings, []);
});

test("--since drops older events and shadow routes are priced on the same task's tokens", () => {
  const prices = { schemaVersion: 1 as const, models: {
    sol: { inputUsdPerMillion: 10, cachedInputUsdPerMillion: 10, outputUsdPerMillion: 0 },
    luna: { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 0 } } };
  const input = [
    { at: "2026-09-25T01:00:00Z", client: "codex", result: "kept", model: "sol", reason: "old", latencyMs: 1 },
    { at: "2026-09-25T02:00:00Z", client: "codex", result: "kept", model: "sol", taskId: "t", reason: "low-confidence", latencyMs: 1, shadowModel: "luna" },
    { at: "2026-09-25T02:00:01Z", client: "codex", kind: "response", taskId: "t", requestId: "a", requestedModel: "sol", servedModel: "sol", inputTokens: 1_000_000 },
    { at: "2026-09-25T02:00:02Z", client: "codex", kind: "response", taskId: "t", requestId: "b", requestedModel: "sol", servedModel: "sol", inputTokens: 1_000_000 },
  ].map((event) => JSON.stringify(event)).join("\n");
  const summary = summarizeMetrics(input, undefined, prices, Date.parse("2026-09-25T01:30:00Z"));
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.shadow, { decisions: 1, byModel: { luna: 1 }, tasks: 1, responses: 2, appliedUsd: 20, shadowUsd: 2 });
  assert.equal(summarizeMetrics(input).total, 2);
  assert.equal(summarizeMetrics(input).shadow.appliedUsd, null);
});
