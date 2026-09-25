import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("installed skill wrapper invokes the gate with a private local metrics path", (context) => {
  const temp = mkdtempSync(join(tmpdir(), "amr-gate-wrapper-"));
  context.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = resolve(".");
  symlinkSync(join(repo, "dist"), join(temp, "dist"), "dir");
  writeFileSync(join(temp, ".env"), "# no key for fail-open verification\n");
  const environment: NodeJS.ProcessEnv = { ...process.env, JAO_ENV_FILE: join(temp, ".env") };
  delete environment.TYPESAFE_API_KEY;
  delete environment.JEV_API_KEY;
  const result = spawnSync(process.execPath, [join(repo, "claude-mod/skills/agent-context-gates/scripts/gate.mjs"),
    "search", join(repo, "fixtures/search-example.json")], { encoding: "utf8", env: environment });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "unknown");
  assert.equal(output.jevCalls, 0);
  const metrics = join(temp, ".local/search.jsonl");
  assert.equal(existsSync(metrics), true);
  assert.equal(readFileSync(metrics, "utf8").includes("synthetic service"), false);
});
