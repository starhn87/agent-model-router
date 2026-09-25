import assert from "node:assert/strict";
import { test } from "node:test";
import { choiceFromJev, keyFromEnvFile, register } from "../hooks/register.js";

function harness({ answer = "fast", confidence = 0.95, effortScore = 2.8, env = {} } = {}) {
  const hooks = new Map();
  const requests = [];
  const registered = [];
  register((event, matcher, handler) => {
    hooks.set(event, handler ?? matcher);
  });
  const $ = {
    plugin: { root: "/router/claude-mod" },
    env: { get: async (name) => ({ AMR_CLAUDE_AUTO: "1", ...env })[name] },
    fs: { read: async () => "TYPESAFE_API_KEY=test-key\n" },
    clock: { sleep: () => new Promise(() => {}) },
    command: { register: async (spec) => registered.push(spec) },
    http: {
      fetch: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, text: JSON.stringify({ answers: {
          tier: { type: "choice", choice: answer, confidence },
          effort: { type: "score", score: effortScore, confidence: 0.91 },
        } }) };
      },
    },
  };
  const forward = async (input) => input;
  const start = async (turnId, text) => {
    await hooks.get("session.start")($, {}, forward);
    await hooks.get("turn.start")($, { turnId, text }, forward);
  };
  const step = async (turnId, agentId) => {
    let sent;
    const next = async function* (request) {
      sent = request;
      yield { kind: "stop", usage: { model: request.model }, stopReason: "end_turn" };
    };
    const chunks = [];
    for await (const chunk of hooks.get("turn.step")($, {
      turnId, index: 0, model: "claude-sonnet-5", effort: "medium", messageCount: 1, agentId,
    }, next)) chunks.push(chunk);
    return { sent, chunks };
  };
  const status = () => hooks.get("command.run")().text;
  const complete = (turnId, extra = {}, text = "Answer") => hooks.get("turn.complete")($, {
    turnId, reason: "answer", answer: "Answer", usage: { model: "claude-served" }, ...extra,
  }, async () => ({ text }));
  return { $, requests, registered, start, step, status, complete };
}

test("parses a local env file without exposing other entries", () => {
  assert.equal(keyFromEnvFile("# comment\nTYPESAFE_API_KEY='abc=def'\nOTHER=secret\n"), "abc=def");
  assert.equal(keyFromEnvFile("TYPESAFE_API_KEY=abc # note"), "abc");
  assert.equal(keyFromEnvFile("OTHER=value"), "");
});

test("rejects malformed answers while preserving independent effort on low tier confidence", () => {
  assert.deepEqual(choiceFromJev({ answers: { tier: { type: "choice", choice: "fast", confidence: 0.79 },
    effort: { type: "score", score: 4 } } }), { tier: "fast", confidence: 0.79, effort: "max" });
  assert.equal(choiceFromJev({ answers: { tier: { type: "choice", choice: "unknown", confidence: 0.9 } } }), null);
});

test("routes every main-loop step in one turn and records the served model", async () => {
  const h = harness();
  await h.start("turn-1", "Fix the spelling of this sentence: goodd morning.");
  assert.equal(h.requests.length, 1);
  const body = JSON.parse(h.requests[0].init.body);
  assert.equal(body.model, "jev-latest");
  assert.equal(body.state.user_turn, "Fix the spelling of this sentence: goodd morning.");
  assert.equal(body.questions.effort.type, "score");
  assert.equal((await h.step("turn-1")).sent.model, "claude-haiku-4-5");
  assert.equal((await h.step("turn-1")).sent.effort, "xhigh");
  assert.equal((await h.step("turn-1")).sent.model, "claude-haiku-4-5");
  assert.equal(h.requests.length, 1);
  assert.equal((await h.step("turn-1", "agent-1")).sent.model, "claude-sonnet-5");
  assert.equal((await h.step("turn-1", "agent-1")).sent.effort, "medium");
  assert.match(h.status(), /API served claude-haiku-4-5/);
  assert.match(h.status(), /Jev recommended effort xhigh; requested effort xhigh/);
  assert.match(h.status(), /requested effort xhigh/);
  assert.equal(h.registered[0].name, "amr-route");
});

test("skips sensitive prompts and leaves the session model on low confidence", async () => {
  const sensitive = harness();
  await sensitive.start("turn-1", "Please inspect the secret: abcdefghijklmnop");
  assert.equal(sensitive.requests.length, 0);
  assert.equal((await sensitive.step("turn-1")).sent.model, "claude-sonnet-5");

  const uncertain = harness({ confidence: 0.5 });
  await uncertain.start("turn-2", "Please implement this straightforward little change.");
  assert.equal(uncertain.requests.length, 1);
  assert.equal((await uncertain.step("turn-2")).sent.model, "claude-sonnet-5");
  assert.equal((await uncertain.step("turn-2")).sent.effort, "xhigh");
  assert.match(uncertain.status(), /Jev recommended effort xhigh; requested effort xhigh/);
});

test("maps a strong decision to Opus and can be disabled for a new session", async () => {
  const strong = harness({ answer: "strong" });
  await strong.start("turn-1", "Investigate this difficult multi-file architecture problem.");
  assert.equal((await strong.step("turn-1")).sent.model, "claude-opus-5");

  const disabled = harness({ env: { AMR_CLAUDE_AUTO: "0" } });
  await disabled.start("turn-2", "Investigate this difficult multi-file architecture problem.");
  assert.equal(disabled.requests.length, 0);
  assert.equal((await disabled.step("turn-2")).sent.model, "claude-sonnet-5");
  assert.match(disabled.status(), /off/);
});

test("completion displays actual model and requested effort once, without replacing the answer", async () => {
  const h = harness();
  await h.start("t", "Fix the spelling of this short example sentence.");
  await h.step("t");
  assert.equal((await h.complete("t")).text, "모델: claude-served · 요청 effort: xhigh · 요청 모델: claude-haiku-4-5 ≠");
  assert.equal((await h.complete("t")).text, "Answer");
});

test("matching and dated API model IDs do not show a mismatch", async () => {
  for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20260901"]) {
    const h = harness();
    await h.start("t", "Fix the spelling of this short example sentence.");
    await h.step("t");
    assert.equal((await h.complete("t", { usage: { model } })).text,
      `모델: ${model} · 요청 effort: xhigh`);
  }
});

test("completion leaves subagents, interruptions, disabled routing and footer opt-out alone", async () => {
  for (const extra of [{ agentId: "subagent" }, { reason: "aborted" }, { reason: "error" }, { answer: "" }]) {
    const h = harness();
    await h.start("t", "Fix the spelling of this short example sentence.");
    await h.step("t");
    assert.equal((await h.complete("t", extra)).text, "Answer");
  }
  for (const env of [{ AMR_CLAUDE_AUTO: "0" }, { AMR_RESPONSE_FOOTER: "0" }]) {
    const h = harness({ env });
    await h.start("t", "Fix the spelling of this short example sentence.");
    await h.step("t");
    assert.equal((await h.complete("t")).text, "Answer");
  }
});

test("guarded turns report their effective effort; missing model is not replaced with a guess", async () => {
  const h = harness();
  await h.start("t", "Hi");
  await h.step("t");
  assert.equal((await h.complete("t", { usage: undefined }, "Other plugin synopsis")).text,
    "Other plugin synopsis\n\n모델: 확인 불가 · 요청 effort: medium");
});
