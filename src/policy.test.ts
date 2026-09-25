import assert from "node:assert/strict";
import test from "node:test";
import { chooseModel, defaultSettings, localRoute, routingGuard, shadowRoute } from "./policy.js";

const settings = defaultSettings("auto");
const query = { prompt: "이 함수의 타입 오류를 수정해줘", currentModel: "gpt-6-sol", contextTokens: 2000 };

test("high-confidence choice changes model", () => {
  assert.deepEqual(chooseModel(query, { tier: "fast", confidence: 0.93 }, settings).model, "gpt-6-luna");
});

test("low confidence and unavailable Jev preserve current model", () => {
  assert.equal(chooseModel(query, { tier: "fast", confidence: 0.55 }, settings).model, "gpt-6-sol");
  assert.equal(chooseModel(query, null, settings).model, "gpt-6-sol");
});

test("uncertain new turns return to balanced even with an Astra Auto selector", () => {
  const installed = { ...settings, baselineModel: "gpt-6-astra" };
  const fastQuery = { ...query, currentModel: "gpt-6-luna" };
  assert.equal(chooseModel(fastQuery, { tier: "balanced", confidence: 0.55 }, settings).model, "gpt-6-sol");
  assert.equal(chooseModel(fastQuery, null, settings).model, "gpt-6-sol");
  assert.equal(chooseModel(fastQuery, { tier: "strong", confidence: 0.95 }, settings, new Set(["gpt-6-sol"])).model, "gpt-6-sol");
  for (const currentModel of ["gpt-6-luna", "gpt-6-astra"]) {
    assert.equal(chooseModel({ ...query, currentModel }, null, installed).model, "gpt-6-sol");
    assert.equal(chooseModel({ ...query, currentModel }, { tier: "strong", confidence: 0.5 }, installed).model, "gpt-6-sol");
  }
  assert.equal(chooseModel({ ...fastQuery, prompt: "진행해" }, null, settings).model, "gpt-6-luna");
  assert.equal(chooseModel({ ...fastQuery, contextTokens: 30_000 }, null, settings).model, "gpt-6-sol");
});

test("explicit follow-ups inherit, while short new tasks and long history are classified", () => {
  for (const prompt of ["진행해", "계속해", "계속해줘", "그대로 진행해주세요", "응 진행해", "오케이. 좋아!", "그 문장 고쳐줘", "Continue.", "Please go ahead!"]) {
    assert.equal(routingGuard({ ...query, prompt }), "context-follow-up", prompt);
  }
  for (const prompt of ["안녕", "2+2는?", "왜 죽어?", "계속해, 그리고 분산 트랜잭션 설계도 검토해줘"]) {
    assert.equal(routingGuard({ ...query, prompt }), null, prompt);
  }
  assert.equal(routingGuard({ ...query, contextTokens: 300_000 }), null);
  assert.equal(routingGuard({ ...query, prompt: "x".repeat(1601) }), "oversized-prompt");
});

test("obvious credentials are never submitted to Jev", () => {
  for (const prompt of ["Set API_KEY=abcdef1234567890 in this config", "secret=x", "\"password=secret\" 맞춤법 고쳐줘", `안녕${" ".repeat(1600)}API_KEY=synthetic`]) {
    assert.equal(routingGuard({ ...query, prompt }), "sensitive-prompt");
    assert.equal(localRoute({ ...query, prompt }, settings)?.model, "gpt-6-sol");
  }
});

test("choice cannot select a model missing from the account catalog", () => {
  const allowed = new Set(["gpt-6-sol"]);
  assert.equal(chooseModel(query, { tier: "strong", confidence: 0.95 }, settings, allowed).reason, "model-unavailable");
});

test("uncertain downgrades use balanced instead of sticking to strong", () => {
  const sticky = { ...settings, minimumDowngradeConfidence: 0.9 };
  const strong = { ...query, currentModel: "gpt-6-astra" };
  assert.deepEqual(chooseModel(strong, { tier: "fast", confidence: 0.85 }, sticky), {
    model: "gpt-6-sol", effort: "medium", tier: "fast", confidence: 0.85, reason: "downgrade-fallback",
  });
  assert.equal(chooseModel(strong, { tier: "fast", confidence: 0.95 }, sticky).model, "gpt-6-luna");
  assert.equal(chooseModel({ ...query, currentModel: "gpt-6-luna" }, { tier: "strong", confidence: 0.85 }, sticky).model, "gpt-6-astra");
  assert.equal(chooseModel(strong, { tier: "fast", confidence: 0.85 }, settings).model, "gpt-6-luna");
});

test("only unambiguous independent greetings and supplied correction text get local fast routing", () => {
  const strong = { ...query, currentModel: "gpt-6-astra", contextTokens: 300_000 };
  for (const prompt of ["안녕", "안녕하세요!", "Hi!", "i has apple 맞춤법 고쳐줘", "i has one apple의 맞춤법 고쳐줘", '"나는 사과을 먹었다" 맞춤법 고쳐줘', "Fix grammar: i has apple"]) {
    const route = localRoute({ ...strong, prompt }, settings);
    assert.equal(route?.model, "gpt-6-luna", prompt);
    assert.equal(route?.effort, "low", prompt);
  }
  for (const prompt of ["그 문장 맞춤법 고쳐줘", "맞춤법 교정기를 설계해줘", "이 코드 문법 고쳐줘", '"src/app.ts" 문법 고쳐줘', "this sentence 맞춤법 고쳐줘", "안녕. 분산 시스템의 장애 원인을 분석해줘", '"i has apple" 맞춤법 고쳐줘. 관련 코드도 고쳐줘', `Fix grammar: ${"word ".repeat(50)}`]) {
    assert.equal(localRoute({ ...strong, prompt }, settings), null, prompt);
  }
  assert.equal(localRoute({ ...strong, prompt: "안녕" }, settings, new Set(["gpt-6-sol"]))?.model, "gpt-6-sol");
});

test("fallback respects catalog availability and tier effort defaults", () => {
  assert.equal(chooseModel(query, null, settings, new Set(["gpt-6-luna"])).model, "gpt-6-luna");
  assert.equal(chooseModel(query, { tier: "fast", confidence: 0.95 }, settings).effort, "low");
  assert.equal(chooseModel(query, { tier: "balanced", confidence: 0.95, effortScore: 4, effortConfidence: 0.2 }, settings).effort, "medium");
  assert.equal(chooseModel(query, { tier: "strong", confidence: 0.95, effortScore: 3, effortConfidence: 0.99 }, settings).effort, "xhigh");
});

test("a shadow fast confidence reports the route it would take without changing the applied one", () => {
  const shadowed = { ...settings, minimumDowngradeConfidence: 0.9, shadowConfidence: { fast: 0.7 } };
  const lowFast = { tier: "fast" as const, confidence: 0.75, effortScore: 0 };
  const applied = chooseModel(query, lowFast, shadowed);
  assert.equal(applied.model, "gpt-6-sol");
  assert.equal(shadowRoute(query, lowFast, applied, shadowed)?.model, "gpt-6-luna");
  const downgrade = { tier: "fast" as const, confidence: 0.86 };
  assert.equal(shadowRoute(query, downgrade, chooseModel(query, downgrade, shadowed), shadowed)?.model, "gpt-6-luna");
  const tooLow = { tier: "fast" as const, confidence: 0.6 };
  assert.equal(shadowRoute(query, tooLow, chooseModel(query, tooLow, shadowed), shadowed), null);
  const balanced = { tier: "balanced" as const, confidence: 0.75 };
  assert.equal(shadowRoute(query, balanced, chooseModel(query, balanced, shadowed), shadowed), null);
});
