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
