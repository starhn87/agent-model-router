import assert from "node:assert/strict";
import test from "node:test";
import { codexArgs, codexChildEnv } from "./codex-args.js";

test("Codex CLI uses a real supported model with the subscription-authenticated provider", () => {
  const args = codexArgs("http://127.0.0.1:5555", "gpt-6-astra", ["exec", "hello"]);
  assert.deepEqual(args.slice(0, 2), ["--model", "gpt-6-astra"]);
  assert.ok(args.includes("model_providers.agent_router.requires_openai_auth=true"));
  assert.ok(args.includes('model_providers.agent_router.base_url="http://127.0.0.1:5555"'));
});

test("manual model argument wins over the baseline", () => {
  const args = codexArgs("http://127.0.0.1:5555", "gpt-6-astra", ["--model", "gpt-6-sol", "exec", "hello"]);
  assert.equal(args.includes("agent-auto"), false);
  assert.deepEqual(args.slice(0, 2), ["--config", 'model_provider="agent_router"']);
});

test("Codex child never inherits TypeSafe credentials needed only by the proxy", () => {
  const parent = { PATH: "/usr/bin", TYPESAFE_API_KEY: "synthetic-current", JEV_API_KEY: "synthetic-legacy" };
  const child = codexChildEnv(parent);
  assert.equal(child.TYPESAFE_API_KEY, undefined);
  assert.equal(child.JEV_API_KEY, undefined);
  assert.equal(child.PATH, parent.PATH);
  assert.equal(parent.TYPESAFE_API_KEY, "synthetic-current");
});
