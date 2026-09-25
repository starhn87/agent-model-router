import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { observeClaudePrompt } from "./claude-shadow.js";

test("Claude hook records only routing metadata and never changes model", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "amr-claude-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "metrics.jsonl");
  const prompt = "비밀 아닌 테스트 문장을 정리해줘";
  const event = await observeClaudePrompt({ hook_event_name: "UserPromptSubmit", prompt }, file,
    async () => ({ tier: "fast", confidence: 0.92 }));
  assert.equal(event?.recommendedTier, "fast");
  assert.equal(event?.model, "claude-current");
  assert.equal(readFileSync(file, "utf8").includes(prompt), false);
});
