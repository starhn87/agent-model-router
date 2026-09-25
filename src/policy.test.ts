import assert from "node:assert/strict";
import test from "node:test";
import { chooseModel, defaultSettings, routingGuard } from "./policy.js";

const settings = defaultSettings("auto");
const query = { prompt: "이 함수의 타입 오류를 수정해줘", currentModel: "gpt-6-sol", contextTokens: 2000 };

test("high-confidence choice changes model", () => {
  assert.deepEqual(chooseModel(query, { tier: "fast", confidence: 0.93 }, settings).model, "gpt-6-luna");
});

test("low confidence and unavailable Jev preserve current model", () => {
  assert.equal(chooseModel(query, { tier: "fast", confidence: 0.55 }, settings).model, "gpt-6-sol");
  assert.equal(chooseModel(query, null, settings).model, "gpt-6-sol");
});

test("uncertain new turns leave fast but preserve a stronger current model", () => {
  const fastQuery = { ...query, currentModel: "gpt-6-luna" };
  assert.equal(chooseModel(fastQuery, { tier: "balanced", confidence: 0.55 }, settings).model, "gpt-6-sol");
  assert.equal(chooseModel(fastQuery, null, settings).model, "gpt-6-sol");
  assert.equal(chooseModel(fastQuery, { tier: "strong", confidence: 0.95 }, settings, new Set(["gpt-6-sol"])).model, "gpt-6-sol");
  assert.equal(chooseModel({ ...query, currentModel: "gpt-6-astra" }, null, settings).model, "gpt-6-astra");
  assert.equal(chooseModel({ ...fastQuery, prompt: "진행해" }, null, settings).model, "gpt-6-luna");
  assert.equal(chooseModel({ ...fastQuery, contextTokens: 30_000 }, null, settings).model, "gpt-6-sol");
});

test("short follow-ups and large contexts preserve current model", () => {
  assert.equal(routingGuard({ ...query, prompt: "진행해" }, settings), "short-follow-up");
  assert.equal(routingGuard({ ...query, contextTokens: 30_000 }, settings), "large-context");
});

test("obvious credentials are never submitted to Jev", () => {
  assert.equal(routingGuard({ ...query, prompt: "Set API_KEY=abcdef1234567890 in this config" }, settings), "sensitive-prompt");
});

test("choice cannot select a model missing from the account catalog", () => {
  const allowed = new Set(["gpt-6-sol"]);
  assert.equal(chooseModel(query, { tier: "strong", confidence: 0.95 }, settings, allowed).reason, "model-unavailable");
});

test("optional downgrade confidence holds uncertain cheaper choices but never blocks upgrades", () => {
  const sticky = { ...settings, minimumDowngradeConfidence: 0.9 };
  const strong = { ...query, currentModel: "gpt-6-astra" };
  assert.deepEqual(chooseModel(strong, { tier: "fast", confidence: 0.85 }, sticky), {
    model: "gpt-6-astra", tier: "fast", confidence: 0.85, reason: "downgrade-held",
  });
  assert.equal(chooseModel(strong, { tier: "fast", confidence: 0.95 }, sticky).model, "gpt-6-luna");
  assert.equal(chooseModel({ ...query, currentModel: "gpt-6-luna" }, { tier: "strong", confidence: 0.85 }, sticky).model, "gpt-6-astra");
  assert.equal(chooseModel(strong, { tier: "fast", confidence: 0.85 }, settings).model, "gpt-6-luna");
});
