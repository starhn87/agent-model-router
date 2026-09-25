import assert from "node:assert/strict";
import test from "node:test";
import { draftComparison } from "./compare-draft.js";
import { parseComparisonInput } from "./compare.js";

const log = (events: object[]) => events.map((event) => JSON.stringify(event)).join("\n");
const prices = { schemaVersion: 1 as const, models: {
  m: { inputUsdPerMillion: 1_000_000, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0 } } };

test("pairs tasks in start order with observed elapsed time and priced cost", () => {
  const fixed = log([
    { at: "2026-09-25T00:01:00Z", client: "codex", result: "kept", model: "m", taskId: "b", reason: "x" },
    { at: "2026-09-25T00:00:00Z", client: "codex", result: "kept", model: "m", taskId: "a", reason: "x" },
    { at: "2026-09-25T00:00:05Z", client: "codex", kind: "response", taskId: "a", requestId: "1", requestedModel: "m", servedModel: "m", inputTokens: 2 },
  ]);
  const auto = log([
    { at: "2026-09-25T01:00:00Z", client: "codex", result: "routed", model: "m", taskId: "c", reason: "x" },
    { at: "2026-09-25T01:00:03Z", client: "codex", kind: "response", taskId: "c", requestId: "2", requestedModel: "m", servedModel: "m", inputTokens: 1 },
    { at: "2026-09-25T01:01:00Z", client: "codex", result: "routed", model: "m", taskId: "d", reason: "x" },
  ]);
  const draft = draftComparison(fixed, auto, "sol", "auto", prices);
  assert.deepEqual(draft.cases[0], { id: "task-1",
    fixed: { completed: true, qualityScore: null, elapsedMs: 5000, billedUsd: 2, manualCorrections: null },
    auto: { completed: true, qualityScore: null, elapsedMs: 3000, billedUsd: 1, manualCorrections: null } });
  assert.equal(draft.cases[1]!.fixed.completed, false);
  assert.throws(() => parseComparisonInput(draft), /task-1: fill in qualityScore/);
  assert.throws(() => draftComparison(fixed, log([]), "a", "b"), /at least one task/);
});
