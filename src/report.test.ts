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
