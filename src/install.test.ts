import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { configureClaude, configureCodex, doctor, install, servicePlist, unconfigureClaude, unconfigureCodex, uninstall, type InstallContext } from "./install.js";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "amr-install-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const calls: string[][] = [];
  const context: InstallContext = { home: join(dir, "home"), repo: join(dir, "repo space & test"), platform: "darwin", node: process.execPath,
    run: (command, args) => { calls.push([command, ...args]); } };
  mkdirSync(context.repo, { recursive: true });
  writeFileSync(join(context.repo, ".env"), "TYPESAFE_API_KEY=synthetic-key\n");
  const put = (path: string, content: string) => { const file = join(context.home, path); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, content); };
  const get = (path: string) => readFileSync(join(context.home, path), "utf8");
  return { context, calls, put, get };
}

test("Codex setup preserves unrelated TOML sections, including later edits on removal", () => {
  const original = '# comment\nmodel = "custom"\nmodel_provider = "existing"\nmodel_reasoning_effort = "high"\n\n[model_providers.existing]\nname = "Existing"\n\n[projects."/work"]\ntrust_level = "trusted"\n';
  const changed = configureCodex(original);
  assert.match(changed, /model_reasoning_effort = "high"/);
  assert.match(changed, /\[model_providers.existing\]/);
  assert.equal((changed.match(/\[model_providers.agent_router\]/g) ?? []).length, 1);
  const removed = unconfigureCodex(`${changed}\n[new_feature]\nenabled = true\n`, original);
  assert.match(removed, /^model = "custom"\nmodel_provider = "existing"/);
  assert.match(removed, /\[new_feature\]\nenabled = true/);
  assert.equal(removed.includes("agent_router"), false);
  assert.equal(configureCodex(changed), changed);
});

test("adopted Codex install actually disables routing and conflicts never get overwritten", () => {
  const original = configureCodex('model = "gpt-6-astra"\n');
  assert.match(unconfigureCodex(original, original), /model_provider = "openai"/);
  assert.throws(() => unconfigureCodex(original.replace('model = "gpt-6-astra"', 'model = "manual"'), null), /変更|변경/);
  assert.throws(() => configureCodex('[model_providers.agent_router]\nbase_url = "https://other.example"\n'), /다른/);
  assert.throws(() => configureCodex('instructions = """\n[anything]\n"""\n'), /TOML/);
  assert.throws(() => configureCodex('"model" = "something"\n'), /수동/);
});

test("Claude setup and removal merge only managed env keys and adopt existing auto settings", () => {
  const original = JSON.stringify({ env: { OTHER: "preserved", AMR_CLAUDE_AUTO: "1" }, permissions: { allow: ["Read"] } });
  const updated = configureClaude(original, "/repo");
  const later = JSON.parse(updated); later.theme = "dark";
  const removed = JSON.parse(unconfigureClaude(JSON.stringify(later), original, "/repo"));
  assert.equal(removed.env.OTHER, "preserved");
  assert.equal(removed.env.AMR_CLAUDE_AUTO, "0");
  assert.equal(removed.theme, "dark");
  assert.deepEqual(removed.permissions, { allow: ["Read"] });
  assert.throws(() => configureClaude('{"enabledPlugins":{"agent-model-router@amr":true}}', "/repo"), /마켓플레이스/);
});

test("Claude install is idempotent, stores private backups and removes cleanly", async (t) => {
  const h = fixture(t);
  h.put(".claude/settings.json", '{"env":{"OTHER":"preserved"}}');
  await install("claude", h.context);
  const firstState = h.get(".agent-model-router/install.json");
  await install("claude", h.context);
  assert.equal(h.get(".agent-model-router/install.json"), firstState);
  assert.ok(lstatSync(join(h.context.home, ".claude/skills/agent-model-router")).isSymbolicLink());
  assert.equal(lstatSync(join(h.context.home, ".agent-model-router/install.json")).mode & 0o777, 0o600);
  const settings = JSON.parse(h.get(".claude/settings.json")); settings.theme = "dark";
  h.put(".claude/settings.json", JSON.stringify(settings));
  uninstall("claude", h.context);
  assert.deepEqual(JSON.parse(h.get(".claude/settings.json")), { env: { OTHER: "preserved" }, theme: "dark" });
  assert.equal(existsSync(join(h.context.home, ".claude/skills/agent-model-router")), false);
});

test("both install validates before mutations and handles an existing unrelated plugin safely", async (t) => {
  const h = fixture(t);
  h.put(".claude/skills/agent-model-router/user-file", "keep me");
  await assert.rejects(install("both", h.context), /다른 파일/);
  assert.equal(h.get(".claude/skills/agent-model-router/user-file"), "keep me");
  assert.equal(existsSync(join(h.context.home, ".codex/config.toml")), false);
  assert.equal(h.calls.some((args) => args[0] === "launchctl"), false);
});

test("both install runs service before redirecting Codex, and disable preserves unrelated changes", async (t) => {
  const h = fixture(t);
  let started = false;
  h.context.run = (command, args) => {
    h.calls.push([command, ...args]);
    if (args[0] === "bootstrap") {
      assert.equal(existsSync(join(h.context.home, ".codex/config.toml")), false);
      started = true;
    }
  };
  t.mock.method(globalThis, "fetch", async () => {
    if (!started) throw new Error("offline");
    return new Response('{"service":"agent-model-router","status":"ok","responseFooter":true}');
  });
  await install("both", h.context);
  assert.match(h.get(".codex/config.toml"), /model_provider = "agent_router"/);
  assert.match(servicePlist(h.context), /repo space &amp; test/);
  assert.match(await doctor(h.context), /연결됨/);
  h.put(".codex/config.toml", `${h.get(".codex/config.toml")}\n[unrelated]\nvalue = 42\n`);
  uninstall("both", h.context);
  assert.match(h.get(".codex/config.toml"), /\[unrelated\]\nvalue = 42/);
  assert.equal(h.get(".codex/config.toml").includes("agent_router"), false);
  assert.equal(existsSync(join(h.context.home, "Library/LaunchAgents/com.agent-model-router.codex.plist")), false);
});

test("a failed service start rolls back configuration and leaves Claude untouched", async (t) => {
  const h = fixture(t);
  h.put(".codex/config.toml", 'model = "original"\n');
  h.put(".claude/settings.json", '{"theme":"original"}');
  h.context.run = (_command, args) => { if (args[0] === "bootstrap") throw new Error("synthetic failure"); };
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  await assert.rejects(install("both", h.context), /synthetic failure/);
  assert.equal(h.get(".codex/config.toml"), 'model = "original"\n');
  assert.equal(h.get(".claude/settings.json"), '{"theme":"original"}');
  assert.equal(existsSync(join(h.context.home, "Library/LaunchAgents/com.agent-model-router.codex.plist")), false);
});

test("a conflicting port or missing key fails before modifying user settings", async (t) => {
  const h = fixture(t);
  t.mock.method(globalThis, "fetch", async () => new Response('{"status":"ok"}'));
  await assert.rejects(install("codex", h.context), /다른 서버/);
  assert.equal(existsSync(join(h.context.home, ".codex/config.toml")), false);
  writeFileSync(join(h.context.repo, ".env"), "TYPESAFE_API_KEY=\n");
  await assert.rejects(install("claude", h.context), /키가 없습니다/);
});

test("custom config locations are rejected before editing the default location", async (t) => {
  const h = fixture(t);
  h.context.customConfig = { codex: "/custom/codex" };
  await assert.rejects(install("codex", h.context), /사용자 지정/);
  assert.equal(existsSync(join(h.context.home, ".codex/config.toml")), false);
  await install("claude", h.context);
  assert.ok(existsSync(join(h.context.home, ".claude/settings.json")));
});
