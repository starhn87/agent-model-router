import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compareRuns, parseComparisonInput } from "./compare.js";

const example = JSON.parse(readFileSync("fixtures/comparison-example.json", "utf8"));

test("paired comparison keeps quality regressions visible beside time and billed cost", () => {
  const result = compareRuns(parseComparisonInput(example));
  assert.equal(result.kind, "paired-observed-runs");
  assert.equal(result.cases, 2);
  assert.equal(result.fixed.completionRate, 1);
  assert.equal(result.auto.completionRate, 0.5);
  assert.equal(result.paired.autoFaster, 1);
  assert.equal(result.paired.autoCheaper, 2);
  assert.equal(result.paired.autoLowerQuality, 1);
  assert.equal(result.paired.autoFailedWhenFixedCompleted, 1);
  assert.equal(result.elapsedChangePercent, (290000 - 300000) / 300000 * 100);
  assert.ok(Math.abs(result.billedCostChangePercent! - (0.25 - 0.36) / 0.36 * 100) < 1e-9);
  assert.equal(JSON.stringify(result).includes("example-1"), false);
});

test("comparison rejects missing observations, duplicate IDs and prompt-bearing fields", () => {
  assert.throws(() => parseComparisonInput({ ...example, cases: [example.cases[0], example.cases[0]] }), /invalid comparison case/);
  assert.throws(() => parseComparisonInput({ ...example, cases: [{ ...example.cases[0], prompt: "private task" }] }), /invalid comparison case/);
  assert.throws(() => parseComparisonInput({ ...example, cases: [{ id: "missing", fixed: example.cases[0].fixed }] }), /invalid comparison case/);
  assert.throws(() => parseComparisonInput({ ...example, cases: [{ ...example.cases[0], auto: { ...example.cases[0].auto, billedUsd: -1 } }] }), /invalid comparison case/);
  assert.throws(() => parseComparisonInput({ ...example, cases: [{ ...example.cases[0], auto: { ...example.cases[0].auto, qualityScore: null } }] }), /invalid comparison case/);
});

test("unavailable billed cost stays unknown while time and quality remain comparable", () => {
  const input = parseComparisonInput({ ...example, cases: [{ ...example.cases[0], auto: { ...example.cases[0].auto, billedUsd: null } }] });
  const result = compareRuns(input);
  assert.equal(result.auto.totalBilledUsd, null);
  assert.equal(result.paired.autoCheaper, null);
  assert.equal(result.billedCostChangePercent, null);
  assert.equal(result.paired.autoFaster, 1);
});

test("zero fixed cost reports no percentage rather than invented savings", () => {
  const input = parseComparisonInput({ ...example, cases: [{ ...example.cases[0], fixed: { ...example.cases[0].fixed, billedUsd: 0 } }] });
  assert.equal(compareRuns(input).billedCostChangePercent, null);
});
