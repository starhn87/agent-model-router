import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { CodexRouter, startCodexProxy } from "./codex-proxy.js";
import { AUTO_MODEL, defaultSettings } from "./policy.js";
import type { CodexBody } from "./codex-request.js";

const catalog = {
  models: [
    { slug: "gpt-6-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "medium" }, { effort: "ultra" }] },
    { slug: "gpt-6-luna", display_name: "Luna", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium" }] },
    { slug: "gpt-6-astra", display_name: "Astra", supported_reasoning_levels: [{ effort: "medium" }, { effort: "ultra" }] },
  ],
};

function userBody(prompt = "이 오류의 원인과 수정 방법을 분석해줘", key = "conversation-1"): CodexBody {
  return { model: AUTO_MODEL, client_metadata: { thread_id: key }, prompt_cache_key: key, input: [
    { role: "user", content: [{ type: "input_text", text: prompt }] },
    { type: "additional_tools" },
  ], reasoning: { effort: "ultra" } };
}

test("force mode forwards ChatGPT headers, injects Auto model, and preserves SSE", async (context) => {
  const requests: { path: string; authorization?: string; body: string }[] = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (request.url?.endsWith("/models")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(catalog));
    } else {
      response.setHeader("content-type", "text/event-stream");
      response.write("event: response.created\n");
      response.end('data: {"type":"response.created"}\n\n');
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const settings = defaultSettings("force");
  settings.forceModel = "gpt-6-luna";
  const proxy = await startCodexProxy({ settings, upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/backend-api/codex` });
  context.after(() => proxy.close());

  const modelsResponse = await fetch(`http://127.0.0.1:${proxy.port}/models`, { headers: { authorization: "Bearer test-only" } });
  const models = await modelsResponse.json() as typeof catalog;
  assert.equal(models.models[0]?.slug, AUTO_MODEL);

  const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, {
    method: "POST", headers: { authorization: "Bearer test-only", "content-type": "application/json" }, body: JSON.stringify(userBody()),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'event: response.created\ndata: {"type":"response.created"}\n\n');
  assert.equal(requests[0]?.path, "/backend-api/codex/models");
  assert.equal(requests[1]?.authorization, "Bearer test-only");
  assert.equal(JSON.parse(requests[1]?.body ?? "{}").model, "gpt-6-luna");
  assert.equal(JSON.parse(requests[1]?.body ?? "{}").reasoning.effort, "medium");
});

test("auto mode classifies each new turn once and pins tool continuations", async () => {
  let calls = 0;
  const router = new CodexRouter({ settings: defaultSettings("auto"), classify: async () => {
    calls += 1;
    return { tier: calls === 1 ? "strong" : "fast", confidence: 0.95 };
  } });
  router.ingestCatalog(catalog);
  assert.equal((await router.route(userBody())).model, "gpt-6-astra");
  const continuation = { model: AUTO_MODEL, client_metadata: { thread_id: "conversation-1" }, prompt_cache_key: "conversation-1", input: [{ type: "function_call_output", output: "done" }] };
  assert.equal((await router.route(continuation)).model, "gpt-6-astra");
  assert.equal(calls, 1);
  assert.equal((await router.route(userBody("다음 버그도 분석하고 수정해줘"))).model, "gpt-6-luna");
  assert.equal(calls, 2);
});

test("shadow mode never blocks the upstream request or changes its model", async () => {
  const router = new CodexRouter({ settings: defaultSettings("shadow"), classify: () => new Promise(() => {}) });
  const result = await Promise.race([
    router.route(userBody()),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shadow blocked")), 100)),
  ]);
  assert.equal(result.model, "gpt-6-sol");
});

test("Jev failures keep the current model and manually selected models bypass routing", async () => {
  let calls = 0;
  const router = new CodexRouter({ settings: defaultSettings("auto"), classify: async () => { calls += 1; throw new Error("secret message"); } });
  assert.equal((await router.route(userBody())).model, "gpt-6-sol");
  const manual = { ...userBody(), model: "gpt-6-astra" };
  assert.deepEqual(await router.route(manual), manual);
  assert.equal(calls, 1);
});

test("multimodal turn stays on current model and never reaches Jev", async () => {
  const router = new CodexRouter({ settings: defaultSettings("auto"), classify: async () => { throw new Error("called"); } });
  const body = userBody();
  body.input = [{ role: "user", content: [{ type: "input_text", text: "이 사진의 오류를 분석해줘" }, { type: "input_image", image_url: "data:secret" }] }];
  assert.equal((await router.route(body)).model, "gpt-6-sol");
});

test("force mode pins tool continuations without contacting Jev", async () => {
  const settings = { ...defaultSettings("force"), forceModel: "gpt-6-luna" };
  let calls = 0;
  const router = new CodexRouter({ settings, classify: async () => { calls += 1; throw new Error("unexpected classification"); } });
  router.ingestCatalog(catalog);
  assert.equal((await router.route(userBody())).model, "gpt-6-luna");
  const continuation = { model: AUTO_MODEL, client_metadata: { thread_id: "conversation-1" }, prompt_cache_key: "conversation-1", input: [{ type: "custom_tool_call_output", output: "done" }] };
  assert.equal((await router.route(continuation)).model, "gpt-6-luna");
  assert.equal(calls, 0);
});

test("auto transitions balanced to fast to balanced while keeping sessions isolated", async () => {
  const tiers = ["balanced", "fast", "balanced"] as const;
  let calls = 0;
  const router = new CodexRouter({ settings: defaultSettings("auto"), classify: async () => ({ tier: tiers[calls++]!, confidence: 0.95 }) });
  router.ingestCatalog(catalog);
  assert.equal((await router.route(userBody())).model, "gpt-6-sol");
  assert.equal((await router.route(userBody("이 세 문장을 한 문장으로 요약해줘"))).model, "gpt-6-luna");
  const continuation = { model: AUTO_MODEL, client_metadata: { thread_id: "conversation-1" }, prompt_cache_key: "conversation-1", input: [{ type: "function_call_output", output: "done" }] };
  assert.equal((await router.route({ ...continuation, client_metadata: { thread_id: "conversation-2" } })).model, "gpt-6-sol");
  assert.equal((await router.route(continuation)).model, "gpt-6-luna");
  assert.equal((await router.route(userBody("이 오류의 원인과 수정 방법을 분석해줘"))).model, "gpt-6-sol");
  assert.equal(calls, 3);
});

test("shared cache keys and missing conversation IDs cannot inherit another thread's model", async () => {
  const router = new CodexRouter({ settings: defaultSettings("auto"), classify: async () => ({ tier: "fast", confidence: 0.95 }) });
  const first = { ...userBody(), prompt_cache_key: "shared-cache" };
  const second = { ...userBody(), client_metadata: { thread_id: "conversation-2" }, prompt_cache_key: "shared-cache" };
  const continuation = { model: AUTO_MODEL, prompt_cache_key: "shared-cache", input: [{ type: "function_call_output", output: "done" }] };
  assert.equal((await router.route(first)).model, "gpt-6-luna");
  assert.equal((await router.route({ ...continuation, client_metadata: second.client_metadata })).model, "gpt-6-sol");
  assert.equal((await router.route({ ...continuation, client_metadata: { thread_id: "conversation-1" } })).model, "gpt-6-luna");
  assert.equal((await router.route(continuation)).model, "gpt-6-sol");
});

test("uncertain turns after fast return to baseline while tool continuations stay pinned", async () => {
  let calls = 0;
  const router = new CodexRouter({ settings: defaultSettings("auto"), classify: async () => {
    calls += 1;
    if (calls === 2) return { tier: "balanced", confidence: 0.5 };
    if (calls === 4) throw new Error("synthetic outage");
    return { tier: "fast", confidence: 0.95 };
  } });
  const continuation = { model: AUTO_MODEL, client_metadata: { thread_id: "conversation-1" }, prompt_cache_key: "conversation-1", input: [{ type: "function_call_output", output: "done" }] };
  assert.equal((await router.route(userBody())).model, "gpt-6-luna");
  assert.equal((await router.route(continuation)).model, "gpt-6-luna");
  assert.equal((await router.route(userBody("복잡한 결제 오류의 원인과 대응을 분석해줘"))).model, "gpt-6-sol");
  assert.equal((await router.route(userBody())).model, "gpt-6-luna");
  assert.equal((await router.route(userBody("복잡한 결제 오류의 원인과 대응을 분석해줘"))).model, "gpt-6-sol");
  assert.equal(calls, 4);
});

test("large, sensitive, and multimodal turns leave fast without calling Jev", async () => {
  let calls = 0;
  const router = new CodexRouter({ settings: defaultSettings("auto"), classify: async () => {
    calls += 1;
    return { tier: "fast", confidence: 0.95 };
  } });
  const multimodal = userBody();
  multimodal.input = [{ role: "user", content: [{ type: "input_text", text: "이 사진의 오류를 분석해줘" }, { type: "input_image", image_url: "data:secret" }] }];
  assert.equal((await router.route(userBody())).model, "gpt-6-luna");
  assert.equal((await router.route(userBody("x".repeat(100_000)))).model, "gpt-6-sol");
  assert.equal((await router.route(userBody())).model, "gpt-6-luna");
  assert.equal((await router.route(userBody("이 설정에서 API_KEY=synthetic-secret 값을 확인해줘"))).model, "gpt-6-sol");
  assert.equal((await router.route(userBody())).model, "gpt-6-luna");
  assert.equal((await router.route(multimodal)).model, "gpt-6-sol");
  assert.equal(calls, 3);
});

test("short, large-context and sensitive turns preserve a stronger model without classification", async () => {
  let calls = 0;
  const router = new CodexRouter({ settings: defaultSettings("auto"), classify: async () => { calls += 1; return { tier: "strong", confidence: 0.95 }; } });
  assert.equal((await router.route(userBody())).model, "gpt-6-astra");
  for (const prompt of ["진행해", "x".repeat(100_000), "이 설정에서 API_KEY=synthetic-secret 값을 확인해줘"]) {
    assert.equal((await router.route(userBody(prompt))).model, "gpt-6-astra");
  }
  assert.equal(calls, 1);
});
