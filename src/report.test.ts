import assert from "node:assert/strict";
import test from "node:test";
import { summarizeMetrics } from "./report.js";

test("summary computes latency, decisions, and Jev-only input cost", () => {
  const input = [
    { client: "codex", result: "routed", recommendedTier: "fast", latencyMs: 100, jevInputTokens: 1000 },
    { client: "claude", result: "shadow", recommendedTier: "strong", latencyMs: 300, jevInputTokens: 2000 },
  ].map((event) => JSON.stringify(event)).join("\n");
  const summary = summarizeMetrics(input);
  assert.equal(summary.total, 2);
  assert.equal(summary.averageJevLatencyMs, 200);
  assert.equal(summary.p95JevLatencyMs, 300);
  assert.equal(summary.jevInputTokens, 3000);
  assert.ok(Math.abs(summary.estimatedJevUsd - 0.000126) < 1e-10);
});
