import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateCases, readEvaluationCases } from "./evaluate.js";

test("evaluation reports accuracy and risky fast-tier mistakes without storing prompts", async () => {
  const cases = [
    { id: "simple", prompt: "이 문장의 오탈자를 고쳐줘", expectedTier: "fast" as const, contextTokens: 100 },
    { id: "hard", prompt: "복잡한 장애 원인을 추적해줘", expectedTier: "strong" as const, contextTokens: 8000 },
  ];
  const results = await evaluateCases(cases, async () => ({ tier: "fast", confidence: 0.9, inputTokens: 20 }));
  assert.equal(results.accuracy, 0.5);
  assert.equal(results.classifiedAccuracy, 0.5);
  assert.equal(results.total, 2);
  assert.equal(results.classified, 2);
  assert.equal(results.errorRate, 0);
  assert.equal(results.falseFast, 1);
  assert.equal(results.falseFastRate, 1);
  assert.equal(results.underRouted, 1);
  assert.equal(results.underRoutingRate, 1);
  assert.equal(results.p95JevLatencyMs !== null, true);
  assert.equal(results.totalJevInputTokens, 40);
  assert.equal(results.estimatedJevUsd, 40 * 0.042 / 1_000_000);
  assert.equal(JSON.stringify(results).includes("오탈자"), false);
});

test("evaluation counts failed Jev calls as misses and does not hide risky fast choices", async () => {
  const cases = [
    { id: "easy", prompt: "문장 교정", expectedTier: "fast" as const, contextTokens: 100 },
    { id: "hard", prompt: "복잡한 장애 분석", expectedTier: "strong" as const, contextTokens: 8000 },
    { id: "normal", prompt: "단일 컴포넌트 수정", expectedTier: "balanced" as const, contextTokens: 2000 },
  ];
  let calls = 0;
  const result = await evaluateCases(cases, async () => {
    calls += 1;
    if (calls === 3) throw new Error("synthetic private upstream error");
    return { tier: "fast", confidence: 0.9, inputTokens: 10 };
  });
  assert.equal(result.total, 3);
  assert.equal(result.classified, 2);
  assert.equal(result.errors, 1);
  assert.equal(result.accuracy, 1 / 3);
  assert.equal(result.classifiedAccuracy, 0.5);
  assert.equal(result.errorRate, 1 / 3);
  assert.equal(result.riskyCases, 2);
  assert.equal(result.falseFastRate, 0.5);
  assert.equal(result.underRouted, 1);
  assert.equal(result.underRoutingRate, 0.5);
  assert.equal(result.results[2]?.error, "jev-unavailable");
  assert.equal(JSON.stringify(result).includes("synthetic private upstream error"), false);
});

test("evaluation detects strong-to-balanced downgrades even when no fast tier is selected", async () => {
  const cases = [
    { id: "complex", prompt: "복잡한 복구 절차를 설계해줘", expectedTier: "strong" as const, contextTokens: 9000 },
    { id: "routine", prompt: "단일 컴포넌트를 수정해줘", expectedTier: "balanced" as const, contextTokens: 2000 },
  ];
  const result = await evaluateCases(cases, async () => ({ tier: "balanced", confidence: 0.9 }));
  assert.equal(result.falseFast, 0);
  assert.equal(result.falseFastRate, 0);
  assert.equal(result.underRouted, 1);
  assert.equal(result.underRoutingRate, 0.5);
});

test("case validation blocks excess calls, missing labels and duplicate IDs before evaluation", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "amr-evaluate-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "cases.json");
  const valid = { id: "case-1", prompt: "합성 테스트 문장", expectedTier: "fast", contextTokens: 100 };
  writeFileSync(file, JSON.stringify([valid, { ...valid, id: "case-2" }]));
  assert.throws(() => readEvaluationCases(file, 1), /max-calls/);
  assert.equal(readEvaluationCases(file, 2).length, 2);
  writeFileSync(file, JSON.stringify([valid, { ...valid }]));
  assert.throws(() => readEvaluationCases(file, 2), /invalid evaluation case/);
  writeFileSync(file, JSON.stringify([{ id: "unrated", prompt: "합성 테스트 문장", contextTokens: 100 }]));
  assert.throws(() => readEvaluationCases(file, 1), /invalid evaluation case/);
});
