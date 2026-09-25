import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function evaluate(file: string, maxCalls: string, keychain = false) {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.JEV_API_KEY;
  return spawnSync(process.execPath, ["dist/cli.js", "evaluate", file, "--max-calls", maxCalls,
    ...(keychain ? ["--keychain-service", "synthetic-missing-service", "--keychain-account", "synthetic-account"] : [])], {
    cwd: process.cwd(), env, encoding: "utf8",
  });
}

test("evaluation CLI rejects excess calls before looking for a TypeSafe key", () => {
  const result = evaluate("fixtures/routing-cases.json", "9");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /evaluation case count exceeds --max-calls/);
  assert.equal(result.stdout, "");
});

test("evaluation CLI rejects unlabeled candidates before looking for a TypeSafe key", () => {
  const result = evaluate("fixtures/routing-candidates.json", "30", true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid evaluation case/);
  assert.equal(result.stdout, "");
});

test("evaluation with an unavailable Keychain item stops before paid requests", () => {
  const result = evaluate("fixtures/routing-cases.json", "10", true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TypeSafe Keychain item unavailable/);
  assert.equal(result.stdout, "");
});

test("server rejects an incomplete Keychain specification before listening", () => {
  const result = spawnSync(process.execPath, ["dist/cli.js", "serve", "--mode", "shadow", "--port", "0",
    "--keychain-service", "synthetic-missing-service"], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /both --keychain-service and --keychain-account are required/);
  assert.equal(result.stdout, "");
});

test("Claude hook skips Keychain lookup for guarded prompts", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "amr-claude-keychain-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const metrics = join(directory, "metrics.jsonl");
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.JEV_API_KEY;
  const result = spawnSync(process.execPath, ["dist/cli.js", "claude-shadow-hook", "--metrics", metrics,
    "--keychain-service", "synthetic-missing-service", "--keychain-account", "synthetic-account"], {
    cwd: process.cwd(), env, encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "안녕" }),
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  const event = JSON.parse(readFileSync(metrics, "utf8"));
  assert.equal(event.result, "kept");
  assert.equal(event.reason, "short-follow-up");
  assert.equal(readFileSync(metrics, "utf8").includes("안녕"), false);
});
