import assert from "node:assert/strict";
import test from "node:test";
import { codexSessionKey, estimateContextTokens, latestUserTurn } from "./codex-request.js";

test("detects new user turn and ignores tool continuation", () => {
  const body = { input: [{ role: "user", content: [{ type: "input_text", text: "이 에러를 수정해줘" }] }, { type: "additional_tools" }] };
  assert.deepEqual(latestUserTurn(body), { prompt: "이 에러를 수정해줘", hasNonText: false });
  assert.equal(latestUserTurn({ input: [...body.input, { type: "function_call_output", output: "done" }] }), null);
});

test("multimodal turn is identified without sending image data", () => {
  const body = { input: [{ role: "user", content: [{ type: "input_text", text: "이 그림을 설명해줘" }, { type: "input_image", image_url: "data:secret" }] }] };
  assert.deepEqual(latestUserTurn(body), { prompt: "이 그림을 설명해줘", hasNonText: true });
});

test("session key follows the thread ID and never reveals raw metadata", () => {
  const key = codexSessionKey({ client_metadata: { thread_id: "sensitive-session-id", turn_id: "first" } });
  assert.ok(key);
  assert.equal(key, codexSessionKey({ client_metadata: { thread_id: "sensitive-session-id", turn_id: "second" } }));
  assert.equal(key.includes("sensitive"), false);
  assert.notEqual(key, codexSessionKey({ client_metadata: { thread_id: "another-thread" }, prompt_cache_key: "same-cache" }));
  assert.equal(codexSessionKey({ prompt_cache_key: "same-cache", instructions: "shared instructions" }), undefined);
});

test("context guard counts conversation content without static tool schemas and developer instructions", () => {
  const scaffolding = [
    { role: "developer", type: "additional_tools", tools: "x".repeat(100_000) },
    { role: "developer", type: "message", content: "y".repeat(100_000) },
  ];
  const shortTurn = { role: "user", type: "message", content: "이 문장의 맞춤법을 고쳐줘" };
  assert.ok(estimateContextTokens({ input: [...scaffolding, shortTurn] }) < 100);
  assert.ok(estimateContextTokens({ input: [...scaffolding, { ...shortTurn, content: "z".repeat(100_000) }] }) > 24_000);
  assert.ok(estimateContextTokens({ input: [...scaffolding, shortTurn, { type: "function_call_output", output: "z".repeat(100_000) }] }) > 24_000);
});
