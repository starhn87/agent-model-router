import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startCodexProxy } from "./codex-proxy.js";
import { defaultSettings } from "./policy.js";
import { recentStatusFromMetrics, renderStatusPage } from "./status.js";

test("status pairs a routing decision with the completed model and escapes untrusted values", () => {
  const content = [
    { at: "2026-09-25T08:00:00Z", requestId: "request-1", result: "routed", model: "gpt-6-luna",
      effort: "low", recommendedTier: "fast", confidence: 1, prompt: "PRIVATE USER PROMPT" },
    { at: "2026-09-25T08:00:01Z", requestId: "request-1", kind: "response", requestedModel: "gpt-6-luna",
      requestedEffort: "low", servedModel: "gpt-6-luna" },
    { at: "2026-09-25T08:00:02Z", requestId: "request-2", kind: "response", requestedModel: "<script>",
      servedModel: "gpt-6-sol", requestedEffort: "high" },
  ].map((event) => JSON.stringify(event)).join("\n");
  const entries = recentStatusFromMetrics(content);
  assert.equal(entries.length, 2);
  assert.equal(entries[1]?.servedModel, "gpt-6-luna");
  assert.equal(entries[1]?.requestedEffort, "low");
  const html = renderStatusPage(entries, true);
  assert.match(html, /gpt-6-luna/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /PRIVATE USER PROMPT|<script>/);
});

test("local status endpoint shows completed routing without contacting the model upstream", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "amr-status-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "metrics.jsonl");
  writeFileSync(file, [
    JSON.stringify({ at: "2026-09-25T08:00:00Z", requestId: "request-1", result: "routed",
      model: "gpt-6-luna", effort: "low", recommendedTier: "fast" }),
    JSON.stringify({ at: "2026-09-25T08:00:01Z", requestId: "request-1", kind: "response",
      requestedModel: "gpt-6-luna", requestedEffort: "low", servedModel: "gpt-6-luna" }),
  ].join("\n") + "\n");
  const proxy = await startCodexProxy({ settings: defaultSettings("auto"), statusFile: file,
    upstreamBaseUrl: "http://127.0.0.1:1" });
  context.after(() => proxy.close());
  const page = await fetch(`http://127.0.0.1:${proxy.port}/status`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await page.text(), /실제 응답 모델/);
  const json = await fetch(`http://127.0.0.1:${proxy.port}/status.json`);
  assert.deepEqual(await json.json(), { entries: [{ at: "2026-09-25T08:00:01Z", result: "routed",
    tier: "fast", requestedModel: "gpt-6-luna", requestedEffort: "low", servedModel: "gpt-6-luna" }] });
});
