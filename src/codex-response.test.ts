import assert from "node:assert/strict";
import test from "node:test";
import { CodexResponseObserver } from "./codex-response.js";

test("SSE completion metadata survives split chunks without storing output text", () => {
  const observer = new CodexResponseObserver("text/event-stream; charset=utf-8", undefined);
  const stream = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"private text"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-6-luna","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},"output_tokens":5},"output":[{"text":"private text"}]}}\n\n';
  const bytes = Buffer.from(stream);
  for (let index = 0; index < bytes.length; index += 7) observer.push(bytes.subarray(index, index + 7));
  assert.deepEqual(observer.finish(), { servedModel: "gpt-6-luna", inputTokens: 100, cachedInputTokens: 80, outputTokens: 5 });
});

test("completed JSON responses are observed, while incomplete or compressed bodies are ignored", () => {
  const body = Buffer.from(JSON.stringify({ status: "completed", model: "gpt-6-sol", usage: { input_tokens: 12 } }));
  const completed = new CodexResponseObserver("application/json", undefined);
  completed.push(body);
  assert.equal(completed.finish()?.servedModel, "gpt-6-sol");
  const incomplete = new CodexResponseObserver("application/json", undefined);
  incomplete.push(Buffer.from('{"status":"incomplete","model":"gpt-6-sol"}'));
  assert.equal(incomplete.finish(), null);
  const compressed = new CodexResponseObserver("application/json", "gzip");
  compressed.push(body);
  assert.equal(compressed.finish(), null);
});

test("malformed and oversized completion metadata cannot interrupt streaming", () => {
  const malformed = new CodexResponseObserver("text/event-stream", undefined);
  malformed.push(Buffer.from('event: response.completed\ndata: {bad json}\n\n'));
  assert.equal(malformed.finish(), null);
  const oversized = new CodexResponseObserver("text/event-stream", undefined);
  oversized.push(Buffer.alloc(4 * 1024 * 1024 + 1, 97));
  assert.equal(oversized.finish(), null);
});
