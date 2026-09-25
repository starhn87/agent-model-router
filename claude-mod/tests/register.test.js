import assert from "node:assert/strict";
import { test } from "node:test";
import { choiceFromJev, keyFromEnvFile, register } from "../hooks/register.js";

function harness({ answer = "fast", confidence = 0.95, effortScore = 2.8, env = {} } = {}) {
  const hooks = new Map();
  const requests = [];
  const registered = [];
  const invalidated = [];
  register((event, matcher, handler) => {
    hooks.set(handler && matcher?.component ? `${event}:${matcher.component}` : event, handler ?? matcher);
  });
  const $ = {
    plugin: { root: "/router/claude-mod" },
    ui: { invalidate: (event) => invalidated.push(event) },
    env: { get: async (name) => ({ JAO_CLAUDE_AUTO: "1", ...env })[name] },
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
  const session = () => hooks.get("session.start")($, {}, forward);
  const start = async (turnId, text) => {
    await session();
    await hooks.get("turn.start")($, { turnId, text }, forward);
  };
  const render = (component, props, requestId = "m-1") =>
    hooks.get(`ui.render:${component}`)($, { surface: "terminal", component, requestId, props }, forward);
  const step = async (turnId, agentId, text, served) => {
    let sent;
    const next = async function* (request) {
      sent = request;
      if (text) yield { kind: "text", index: 0, text };
      yield { kind: "stop", usage: { model: served ?? request.model }, stopReason: "end_turn" };
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
  return { $, requests, registered, invalidated, session, start, step, render, status, complete };
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
  assert.equal(h.registered[0].name, "jao-route");
});

test("skips sensitive prompts and leaves the session model on low confidence", async () => {
  const sensitive = harness();
  await sensitive.start("turn-1", "Please inspect the secret: abcdefghijklmnop");
  assert.equal(sensitive.requests.length, 0);
  assert.equal((await sensitive.step("turn-1")).sent.model, "claude-sonnet-5");
  assert.equal((await sensitive.step("turn-1", undefined, "Kept the session model.")).chunks[0].text,
    "Kept the session model.");

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

  const disabled = harness({ env: { JAO_CLAUDE_AUTO: "0" } });
  await disabled.start("turn-2", "Investigate this difficult multi-file architecture problem.");
  assert.equal(disabled.requests.length, 0);
  assert.equal((await disabled.step("turn-2")).sent.model, "claude-sonnet-5");
  assert.match(disabled.status(), /off/);
});

test("completion displays the route once beneath the answer, with the served model only on a mismatch", async () => {
  const h = harness();
  await h.start("t", "Fix the spelling of this short example sentence.");
  await h.step("t");
  assert.equal((await h.complete("t")).text, "Jev Auto · claude-haiku-4-5 · effort xhigh ≠ claude-served");
  assert.equal((await h.complete("t")).text, "Answer");
  assert.ok(h.invalidated.includes("ui.render"));
});

test("reply text streams unchanged", async () => {
  const h = harness();
  await h.start("t", "Fix the spelling of this short example sentence.");
  assert.equal((await h.step("t", undefined, "Corrected sentence.")).chunks[0].text, "Corrected sentence.");
  assert.equal((await h.step("t", "agent-1", "Tool result.")).chunks[0].text, "Tool result.");
});

test("the prompt footer shows the requested model and effort, also on skipped turns", async () => {
  const h = harness();
  await h.session();
  assert.deepEqual((await h.render("SessionMode", { modes: ["focus"] })).props.modes, ["focus", "Jev Auto"]);
  for (const prompt of ["안녕", "Please inspect the secret: abcdefghijklmnop"]) {
    await h.start("t", prompt);
    assert.equal(h.requests.length, 0);
    const step = await h.step("t", undefined, "Hello.");
    assert.equal(step.sent.model, "claude-sonnet-5");
    assert.equal(step.sent.effort, "medium");
    assert.equal(step.chunks[0].text, "Hello.");
    assert.deepEqual((await h.render("SessionMode", { modes: [] })).props.modes,
      ["Jev Auto · claude-sonnet-5 · effort medium"]);
  }
  await h.step("t", undefined, undefined, "claude-other");
  assert.deepEqual((await h.render("SessionMode", { modes: [] })).props.modes,
    ["Jev Auto · claude-sonnet-5 · effort medium ≠ claude-other"]);
});

test("drawing is left alone while routing or the footer is off", async () => {
  for (const env of [{ JAO_CLAUDE_AUTO: "0" }, { JAO_RESPONSE_FOOTER: "0" }]) {
    const h = harness({ env });
    await h.start("t", "Fix the spelling of this short example sentence.");
    await h.step("t", undefined, "Text.");
    assert.deepEqual((await h.render("SessionMode", { modes: [] })).props.modes, []);
  }
});

test("matching and dated API model IDs do not show a mismatch; longer version numbers do", async () => {
  for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20260901"]) {
    const h = harness();
    await h.start("t", "Fix the spelling of this short example sentence.");
    await h.step("t", undefined, undefined, model);
    assert.ok(h.status().endsWith(`API served ${model}.`), h.status());
    assert.equal((await h.complete("t", { usage: { model } })).text, "Jev Auto · claude-haiku-4-5 · effort xhigh");
  }
  const h = harness();
  await h.start("t", "Fix the spelling of this short example sentence.");
  await h.step("t", undefined, undefined, "claude-haiku-4-5-5");
  assert.ok(h.status().endsWith("API served claude-haiku-4-5-5 ≠ claude-haiku-4-5."), h.status());
  assert.equal((await h.complete("t", { usage: { model: "claude-haiku-4-5-5" } })).text,
    "Jev Auto · claude-haiku-4-5 · effort xhigh ≠ claude-haiku-4-5-5");
});

test("completion leaves subagents, interruptions, disabled routing and footer opt-out alone", async () => {
  for (const extra of [{ agentId: "subagent" }, { reason: "aborted" }, { reason: "error" }, { answer: "" }]) {
    const h = harness();
    await h.start("t", "Fix the spelling of this short example sentence.");
    await h.step("t");
    assert.equal((await h.complete("t", extra)).text, "Answer");
  }
  for (const env of [{ JAO_CLAUDE_AUTO: "0" }, { JAO_RESPONSE_FOOTER: "0" }]) {
    const h = harness({ env });
    await h.start("t", "Fix the spelling of this short example sentence.");
    await h.step("t");
    assert.equal((await h.complete("t")).text, "Answer");
  }
});

test("missing served model does not claim a mismatch", async () => {
  const h = harness();
  await h.start("t", "Hi");
  await h.step("t");
  assert.equal((await h.complete("t", { usage: undefined }, "Other plugin synopsis")).text,
    "Other plugin synopsis\n\nJev Auto · claude-sonnet-5 · effort medium");
});
