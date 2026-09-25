import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSearchSelections } from "./search-evaluate.js";
import { summarizeSearchMetrics } from "./search-metrics.js";

test("needed-source evaluation exposes a recall regression even when fewer results are read", () => {
  const result = evaluateSearchSelections([{ id: "case-1", resultIds: ["a", "b", "c", "d", "e", "f"],
    neededIds: ["b", "f"], selectedIds: ["f"] }]);
  assert.equal(result.baselineNeededRecall, 0.5);
  assert.equal(result.selectedNeededRecall, 0.5);
  assert.equal(result.regressedCases, 0);
  assert.equal(result.selectedReadCount, 1);
  const regression = evaluateSearchSelections([{ id: "case-2", resultIds: ["a", "b", "c", "d", "e", "f"],
    neededIds: ["b"], selectedIds: ["f"] }]);
  assert.equal(regression.regressedCases, 1);
  assert.equal(regression.selectedCompleteCases, 0);
});

test("search metric summary stores counts and latency without question or source text", () => {
  const event = { kind: "search", status: "ok", decision: "answer", resultCount: 7, selectedCount: 2,
    flaggedCount: 1, jevCalls: 2, jevInputTokens: 100, latencyMs: 1200 };
  const summary = summarizeSearchMetrics(`${JSON.stringify(event)}\n`);
  assert.equal(summary.rounds, 1);
  assert.equal(summary.resultsSelected, 2);
  assert.equal(summary.locallyFlagged, 1);
  assert.equal(summary.p95LatencyMs, 1200);
  assert.equal(JSON.stringify(summary).includes("question"), false);
});
