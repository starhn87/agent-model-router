import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { askJev } from "./jev.js";
import { startCodexProxy, type ProxyOptions } from "./codex-proxy.js";
import { AUTO_MODEL, defaultSettings } from "./policy.js";
import type { DecisionEvent } from "./types.js";

const prompt = "합성 요청의 처리 결과를 한 문장으로 정리해줘";
const requestBody = { model: AUTO_MODEL, prompt_cache_key: "integrity-test", input: [{ role: "user", content: prompt }] };

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function harness(context: TestContext, handler: http.RequestListener, options: Partial<ProxyOptions> = {}) {
  const upstream = http.createServer(handler);
  const port = await listen(upstream);
  const proxy = await startCodexProxy({ settings: defaultSettings("pass"), ...options,
    upstreamBaseUrl: `http://127.0.0.1:${port}/backend-api/codex` });
  const controller = new AbortController();
  context.after(async () => {
    controller.abort();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await proxy.close();
  });
  return { ...proxy, url: `http://127.0.0.1:${proxy.port}`, signal: controller.signal };
}

test("pass preserves upstream error status, headers and body without recording request secrets", async (context) => {
  const events: DecisionEvent[] = [];
  const errorBody = '{"error":{"message":"synthetic upstream error"}}';
  const proxy = await harness(context, (request, response) => {
    assert.equal(request.url, "/backend-api/codex/v1/responses?test=1");
    assert.equal(request.headers.authorization, "Bearer synthetic-test-token");
    response.writeHead(429, { "content-type": "application/json", "retry-after": "3", "x-request-id": "test-id" });
    response.end(errorBody);
  }, { onDecision: (event) => events.push(event) });
  const response = await fetch(`${proxy.url}/v1/responses?test=1`, {
    method: "POST", signal: proxy.signal,
    headers: { authorization: "Bearer synthetic-test-token" }, body: JSON.stringify(requestBody),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "3");
  assert.equal(response.headers.get("x-request-id"), "test-id");
  assert.equal(await response.text(), errorBody);
  assert.equal(events[0]?.reason, "pass-mode");
  const logged = JSON.stringify(events);
  for (const value of [prompt, "synthetic-test-token", "synthetic upstream error"]) assert.equal(logged.includes(value), false);
});

test("connection-specific headers are removed on both sides of the proxy", async (context) => {
  let received: http.IncomingHttpHeaders | undefined;
  const proxy = await harness(context, (request, response) => {
    received = request.headers;
    response.writeHead(200, { connection: "close, X-Upstream-Only", "x-upstream-only": "private-hop", "x-end-to-end": "kept" });
    response.end("ok");
  });
  // fetch rejects custom Connection tokens, so exercise HTTP directly here.
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.get(`${proxy.url}/other`, {
      signal: proxy.signal,
      headers: { connection: "keep-alive, X-Client-Only", "x-client-only": "private-hop", "x-end-to-end": "kept" },
    }, resolve);
    request.on("error", reject);
  });
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "ok");
  assert.equal(received?.["x-client-only"], undefined);
  assert.equal(received?.["x-end-to-end"], "kept");
  assert.equal(response.headers["x-upstream-only"], undefined);
  assert.equal(response.headers["x-end-to-end"], "kept");
});

test("invalid response JSON is rejected before contacting upstream", async (context) => {
  let calls = 0;
  const proxy = await harness(context, (_request, response) => { calls += 1; response.end(); });
  const response = await fetch(`${proxy.url}/responses`, { method: "POST", signal: proxy.signal, body: '{"secret":"test"' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { type: "agent_router_error", message: "invalid response request" } });
  assert.equal(calls, 0);
});

test("interrupted SSE fails the client stream and leaves the proxy healthy", { timeout: 3000 }, async (context) => {
  let stream: http.ServerResponse | undefined;
  const proxy = await harness(context, (_request, response) => {
    stream = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"response.created"}\n\n');
  });
  const deadline = AbortSignal.timeout(700);
  const response = await fetch(`${proxy.url}/responses`, {
    method: "POST", body: JSON.stringify(requestBody), signal: AbortSignal.any([proxy.signal, deadline]),
  });
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  stream!.destroy();
  await assert.rejects(reader.read());
  assert.equal(deadline.aborted, false, "upstream failure must terminate the stream before the client timeout");
  const health = await fetch(`${proxy.url}/health`, { signal: proxy.signal });
  assert.deepEqual(await health.json(), { status: "ok" });
});

test("interrupted model catalog returns a sanitized 502 instead of hanging", { timeout: 3000 }, async (context) => {
  const proxy = await harness(context, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"models":[');
    setImmediate(() => response.destroy());
  });
  const response = await fetch(`${proxy.url}/models`, { signal: AbortSignal.any([proxy.signal, AbortSignal.timeout(700)]) });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { type: "agent_router_error", message: "upstream unavailable" } });
});

test("downstream cancellation closes the active upstream response", { timeout: 3000 }, async (context) => {
  let ended!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => { ended = resolve; });
  const proxy = await harness(context, (_request, response) => {
    response.on("close", ended);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: test\n\n");
  });
  const response = await fetch(`${proxy.url}/responses`, { method: "POST", body: JSON.stringify(requestBody), signal: proxy.signal });
  await response.body!.cancel();
  await upstreamClosed;
});

test("proxy shutdown terminates active SSE connections", { timeout: 3000 }, async (context) => {
  const proxy = await harness(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: test\n\n");
  });
  const deadline = AbortSignal.timeout(700);
  const response = await fetch(`${proxy.url}/responses`, {
    method: "POST", body: JSON.stringify(requestBody), signal: AbortSignal.any([proxy.signal, deadline]),
  });
  const reader = response.body!.getReader();
  await reader.read();
  const nextChunk = reader.read();
  const stopped = proxy.close();
  await assert.rejects(nextChunk);
  await stopped;
  assert.equal(deadline.aborted, false, "shutdown must not wait for the client timeout");
});

test("Jev timeout keeps the current model and records only sanitized metadata", { timeout: 3000 }, async (context) => {
  const jev = http.createServer((_request, _response) => { /* Intentionally never answer. */ });
  const jevPort = await listen(jev);
  context.after(async () => {
    jev.closeAllConnections();
    await new Promise<void>((resolve) => jev.close(() => resolve()));
  });
  const events: DecisionEvent[] = [];
  let model: unknown;
  const proxy = await harness(context, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    model = JSON.parse(Buffer.concat(chunks).toString()).model;
    response.end("ok");
  }, {
    settings: defaultSettings("auto"), onDecision: (event) => events.push(event),
    classify: (query) => askJev(query, { apiKey: "synthetic-jev-token", endpoint: `http://127.0.0.1:${jevPort}`, timeoutMs: 30 }),
  });
  const response = await fetch(`${proxy.url}/responses`, { method: "POST", body: JSON.stringify(requestBody), signal: proxy.signal });
  assert.equal(await response.text(), "ok");
  assert.equal(model, "gpt-6-sol");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.reason, "jev-unavailable");
  for (const value of [prompt, "synthetic-jev-token", "TimeoutError"]) assert.equal(JSON.stringify(events).includes(value), false);
});
