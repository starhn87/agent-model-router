import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { CodexRouter, startCodexProxy } from "./codex-proxy.js";
import { defaultSettings } from "./policy.js";
import type { CodexBody } from "./codex-request.js";
import type { DecisionEvent, ResponseObservationEvent } from "./types.js";

const catalog = {
  models: [
    { slug: "gpt-6-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "medium" }, { effort: "ultra" }] },
    { slug: "gpt-6-luna", display_name: "Luna", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium" }] },
    { slug: "gpt-6-astra", display_name: "Astra", supported_reasoning_levels: [{ effort: "medium" }, { effort: "ultra" }] },
  ],
};

function userBody(prompt = "이 오류의 원인과 수정 방법을 분석해줘", key = "conversation-1"): CodexBody {
  return { model: "gpt-6-sol", client_metadata: { thread_id: key }, prompt_cache_key: key, input: [
    { role: "user", content: [{ type: "input_text", text: prompt }] },
    { type: "additional_tools" },
  ], reasoning: { effort: "ultra" } };
}

test("force mode forwards ChatGPT headers, keeps the real model catalog, and preserves SSE", async (context) => {
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
  assert.deepEqual(models, catalog);

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

test("auto mode labels the supported baseline model without adding an unsupported alias", () => {
  const router = new CodexRouter({ settings: defaultSettings("auto") });
  const models = router.ingestCatalog(catalog) as typeof catalog;
  assert.deepEqual(models.models.map((model) => model.slug), catalog.models.map((model) => model.slug));
  assert.equal(models.models.find((model) => model.slug === "gpt-6-sol")?.display_name, "Jev Auto");
  assert.equal(catalog.models.find((model) => model.slug === "gpt-6-sol")?.display_name, "Sol");
});

test("auto mode classifies each new turn once and pins tool continuations", async () => {
  let calls = 0;
  const router = new CodexRouter({ settings: defaultSettings("auto"), classify: async () => {
    calls += 1;
    return { tier: calls === 1 ? "strong" : "fast", confidence: 0.95 };
  } });
  router.ingestCatalog(catalog);
  assert.equal((await router.route(userBody())).model, "gpt-6-astra");
  const continuation = { model: "gpt-6-sol", client_metadata: { thread_id: "conversation-1" }, prompt_cache_key: "conversation-1", input: [{ type: "function_call_output", output: "done" }] };
  assert.equal((await router.route(continuation)).model, "gpt-6-astra");
  assert.equal(calls, 1);
  assert.equal((await router.route(userBody("다음 버그도 분석하고 수정해줘"))).model, "gpt-6-luna");
  assert.equal(calls, 2);
});

test("anonymous task IDs join tool responses but separate new turns and sessions", async () => {
  const decisions: DecisionEvent[] = [];
  const observations: ResponseObservationEvent[] = [];
  const router = new CodexRouter({ settings: defaultSettings("pass"), onDecision: (event) => decisions.push(event),
    onObservation: (event) => observations.push(event) });
  const continuation = { model: "gpt-6-sol", client_metadata: { thread_id: "conversation-1" },
    input: [{ type: "function_call_output", output: "private tool output" }] };
  await router.route(userBody(), "first");
  await router.route(continuation, "tool");
  router.recordObservation("tool", "gpt-6-sol", "medium", { servedModel: "gpt-6-sol", inputTokens: 20 }, 42);
  await router.route(userBody("다른 작업"), "second");
  await router.route({ ...continuation, client_metadata: { thread_id: "conversation-2" } }, "other");
  router.recordObservation("other", "gpt-6-sol", undefined, { servedModel: "gpt-6-sol" });
  assert.ok(decisions[0]?.taskId);
  assert.equal(observations[0]?.taskId, decisions[0]?.taskId);
  assert.equal(observations[0]?.requestDurationMs, 42);
  assert.notEqual(decisions[1]?.taskId, decisions[0]?.taskId);
  assert.equal(observations[1]?.taskId, undefined);
  assert.equal(JSON.stringify([...decisions, ...observations]).includes("private tool output"), false);
});

test("auto mode chooses supported effort with Jev and pins it through tool calls", async () => {
  let calls = 0;
  const decisions: { effort?: string; model: string }[] = [];
  const router = new CodexRouter({ settings: defaultSettings("auto"), classify: async () => {
    calls += 1;
    return calls === 1
      ? { tier: "fast", confidence: 0.99, effortScore: 0.2 }
      : { tier: "strong", confidence: 0.99, effortScore: 3.8 };
  }, onDecision: (event) => decisions.push({ model: event.model, effort: event.effort }) });
  router.ingestCatalog({ models: [
    { slug: "gpt-6-sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] },
    { slug: "gpt-6-luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] },
    { slug: "gpt-6-astra", supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }] },
  ] });
  const first = await router.route(userBody());
  assert.equal(first.model, "gpt-6-luna");
  assert.equal((first.reasoning as { effort: string }).effort, "low");
  const continuation = { model: "gpt-6-sol", client_metadata: { thread_id: "conversation-1" },
    input: [{ type: "function_call_output", output: "done" }], reasoning: { effort: "xhigh" } };
  const continued = await router.route(continuation);
  assert.equal(continued.model, "gpt-6-luna");
  assert.equal((continued.reasoning as { effort: string }).effort, "low");
  const second = await router.route(userBody("이 복잡한 오류의 원인을 분석해줘"));
  assert.equal(second.model, "gpt-6-astra");
  assert.equal((second.reasoning as { effort: string }).effort, "max");
  assert.equal(calls, 2);
  assert.deepEqual(decisions, [{ model: "gpt-6-luna", effort: "low" }, { model: "gpt-6-astra", effort: "max" }]);
});

test("shadow mode never blocks the upstream request or changes its model", async () => {
  const router = new CodexRouter({ settings: defaultSettings("shadow"), classify: () => new Promise(() => {}) });
  const result = await Promise.race([
    router.route(userBody()),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shadow blocked")), 100)),
  ]);
  assert.equal(result.model, "gpt-6-sol");
});

test("pass and shadow preserve the requested effort without catalog adjustment", async () => {
  for (const mode of ["pass", "shadow"] as const) {
    const router = new CodexRouter({ settings: defaultSettings(mode), classify: () => new Promise(() => {}) });
    router.ingestCatalog(catalog);
    const body = { ...userBody(), reasoning: { effort: "xhigh" } };
    assert.deepEqual(await router.route(body), body);
  }
});

test("Jev failures keep the current model and manually selected models bypass routing", async () => {
  let calls = 0;
  const router = new CodexRouter({ settings: defaultSettings("auto"), classify: async () => { calls += 1; throw new Error("secret message"); } });
  assert.equal((await router.route(userBody())).model, "gpt-6-sol");
  const manual = { ...userBody(), model: "gpt-6-astra" };
  assert.deepEqual(await router.route(manual), manual);
  assert.equal(calls, 1);
});

test("manual model selection clears stale automatic routing state", async () => {
  const router = new CodexRouter({ settings: defaultSettings("auto"),
    classify: async () => ({ tier: "fast", confidence: 0.99, effortScore: 0 }) });
  assert.equal((await router.route(userBody())).model, "gpt-6-luna");
  const manual = { ...userBody(), model: "gpt-6-astra" };
  assert.deepEqual(await router.route(manual), manual);
  const continuation = { model: "gpt-6-sol", client_metadata: { thread_id: "conversation-1" },
    input: [{ type: "function_call_output", output: "done" }] };
  assert.equal((await router.route(continuation)).model, "gpt-6-sol");
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
  const continuation = { model: "gpt-6-sol", client_metadata: { thread_id: "conversation-1" }, prompt_cache_key: "conversation-1", input: [{ type: "custom_tool_call_output", output: "done" }] };
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
  const continuation = { model: "gpt-6-sol", client_metadata: { thread_id: "conversation-1" }, prompt_cache_key: "conversation-1", input: [{ type: "function_call_output", output: "done" }] };
  assert.equal((await router.route({ ...continuation, client_metadata: { thread_id: "conversation-2" } })).model, "gpt-6-sol");
  assert.equal((await router.route(continuation)).model, "gpt-6-luna");
  assert.equal((await router.route(userBody("이 오류의 원인과 수정 방법을 분석해줘"))).model, "gpt-6-sol");
  assert.equal(calls, 3);
});

test("shared cache keys and missing conversation IDs cannot inherit another thread's model", async () => {
  const router = new CodexRouter({ settings: defaultSettings("auto"), classify: async () => ({ tier: "fast", confidence: 0.95 }) });
  const first = { ...userBody(), prompt_cache_key: "shared-cache" };
  const second = { ...userBody(), client_metadata: { thread_id: "conversation-2" }, prompt_cache_key: "shared-cache" };
  const continuation = { model: "gpt-6-sol", prompt_cache_key: "shared-cache", input: [{ type: "function_call_output", output: "done" }] };
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
  const continuation = { model: "gpt-6-sol", client_metadata: { thread_id: "conversation-1" }, prompt_cache_key: "conversation-1", input: [{ type: "function_call_output", output: "done" }] };
  assert.equal((await router.route(userBody())).model, "gpt-6-luna");
  assert.equal((await router.route(continuation)).model, "gpt-6-luna");
  assert.equal((await router.route(userBody("복잡한 결제 오류의 원인과 대응을 분석해줘"))).model, "gpt-6-sol");
  assert.equal((await router.route(userBody())).model, "gpt-6-luna");
  assert.equal((await router.route(userBody("복잡한 결제 오류의 원인과 대응을 분석해줘"))).model, "gpt-6-sol");
  assert.equal(calls, 4);
});

test("oversized, sensitive, and multimodal turns leave fast without calling Jev", async () => {
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

test("only explicit follow-ups preserve strong; protected new tasks fall back to balanced", async () => {
  let calls = 0;
  const router = new CodexRouter({ settings: defaultSettings("auto"), classify: async () => { calls += 1; return { tier: "strong", confidence: 0.95 }; } });
  assert.equal((await router.route(userBody())).model, "gpt-6-astra");
  assert.equal((await router.route(userBody("진행해"))).model, "gpt-6-astra");
  for (const prompt of ["x".repeat(100_000), "이 설정에서 API_KEY=synthetic-secret 값을 확인해줘"]) {
    assert.equal((await router.route(userBody(prompt))).model, "gpt-6-sol");
  }
  assert.equal(calls, 1);
});

const installedSettings = { ...defaultSettings("auto"), baselineModel: "gpt-6-astra", minimumDowngradeConfidence: 0.9 };
function installedBody(prompt: string): CodexBody {
  return { ...userBody(prompt), model: installedSettings.baselineModel };
}

test("Astra Auto selector starts on balanced and failures reset model and effort", async () => {
  const currentModels: string[] = [];
  const router = new CodexRouter({ settings: installedSettings, classify: async (query) => {
    currentModels.push(query.currentModel);
    if (currentModels.length === 1) return { tier: "strong", confidence: 0.99, effortScore: 4 };
    if (currentModels.length === 2) return { tier: "strong", confidence: 0.4, effortScore: 4 };
    throw new Error("synthetic outage");
  } });
  for (const expected of [["gpt-6-astra", "max"], ["gpt-6-sol", "medium"], ["gpt-6-sol", "medium"]]) {
    const routed = await router.route(installedBody("이 복잡한 오류를 분석해줘"));
    assert.equal(routed.model, expected[0]);
    assert.equal((routed.reasoning as any).effort, expected[1]);
  }
  assert.deepEqual(currentModels, ["gpt-6-sol", "gpt-6-astra", "gpt-6-sol"]);
  const catalogResult = router.ingestCatalog(catalog) as typeof catalog;
  assert.equal(catalogResult.models.find((model) => model.slug === "gpt-6-astra")?.display_name, "Jev Auto");
  const manual = { ...installedBody("안녕"), model: "gpt-6-sol" };
  assert.deepEqual(await router.route(manual), manual);
});

test("independent simple turns after long history use Luna low; continuations retain route and effort", async () => {
  let calls = 0;
  const router = new CodexRouter({ settings: installedSettings, classify: async () => {
    calls += 1;
    return { tier: "strong", confidence: 0.99, effortScore: 3 };
  } });
  assert.equal((await router.route(installedBody("이 복잡한 오류를 분석해줘"))).model, "gpt-6-astra");
  const continued = await router.route(installedBody("계속해"));
  assert.equal(continued.model, "gpt-6-astra");
  assert.equal((continued.reasoning as any).effort, "xhigh");
  for (const prompt of ["안녕", "i has apple 맞춤법 고쳐줘"]) {
    const body = installedBody(prompt);
    body.input = [{ role: "assistant", content: "history ".repeat(20_000) }, ...(body.input as unknown[])];
    const routed = await router.route(body);
    assert.equal(routed.model, "gpt-6-luna");
    assert.equal((routed.reasoning as any).effort, "low");
  }
  const followUp = await router.route(installedBody("진행해"));
  assert.equal(followUp.model, "gpt-6-luna");
  assert.equal((followUp.reasoning as any).effort, "low");
  const tools = await router.route({ ...installedBody(""), input: [{ type: "function_call_output", output: "done" }] });
  assert.equal(tools.model, "gpt-6-luna");
  assert.equal((tools.reasoning as any).effort, "low");
  assert.equal(calls, 1);
});

test("long history and short independent requests still reach the classifier", async () => {
  let calls = 0;
  const router = new CodexRouter({ settings: installedSettings, classify: async (query) => {
    calls += 1;
    if (calls === 1) return { tier: "strong", confidence: 0.99, effortScore: 3 };
    assert.equal(query.prompt, "2+2는?");
    assert.ok(query.contextTokens > 24_000);
    return { tier: "fast", confidence: 0.85, effortScore: 0 };
  } });
  await router.route(installedBody("이 복잡한 오류를 분석해줘"));
  const body = installedBody("2+2는?");
  body.input = [{ role: "assistant", content: "history ".repeat(20_000) }, ...(body.input as unknown[])];
  const result = await router.route(body);
  assert.equal(result.model, "gpt-6-sol");
  assert.equal((result.reasoning as any).effort, "medium");
  assert.equal(calls, 2);
});

test("fresh continuations use balanced medium and autoEffort opt-out preserves requested effort", async () => {
  for (const autoEffort of [true, false]) {
    const router = new CodexRouter({ settings: { ...installedSettings, autoEffort }, classify: async () => { throw new Error("must skip"); } });
    const continuation = await router.route(installedBody("계속해"));
    assert.equal(continuation.model, "gpt-6-sol");
    assert.equal((continuation.reasoning as any).effort, autoEffort ? "medium" : "ultra");
    const simple = await router.route(installedBody("안녕"));
    assert.equal(simple.model, "gpt-6-luna");
    assert.equal((simple.reasoning as any).effort, autoEffort ? "low" : "ultra");
  }
});

test("local routes do not mutate pass or shadow requests, and force still wins", async () => {
  for (const mode of ["pass", "shadow", "force"] as const) {
    const router = new CodexRouter({ settings: { ...installedSettings, mode, forceModel: "gpt-6-luna" },
      classify: async () => { throw new Error("must skip"); } });
    for (const prompt of ["안녕", "계속해", "secret=x", "x".repeat(1601)]) {
      const body = installedBody(prompt);
      assert.deepEqual(await router.route(body), mode === "force" ? { ...body, model: "gpt-6-luna" } : body);
    }
  }
});

test("auto mode logs the shadow fast route while sending the balanced model", async () => {
  const events: DecisionEvent[] = [];
  const router = new CodexRouter({ settings: { ...defaultSettings("auto"), shadowConfidence: { fast: 0.7 } },
    classify: async () => ({ tier: "fast", confidence: 0.75, effortScore: 0 }), onDecision: (event) => events.push(event) });
  router.ingestCatalog(catalog);
  assert.equal((await router.route(userBody())).model, "gpt-6-sol");
  assert.equal(events[0]!.reason, "low-confidence");
  assert.equal(events[0]!.shadowModel, "gpt-6-luna");
  assert.equal(events[0]!.shadowEffort, "medium");
});
