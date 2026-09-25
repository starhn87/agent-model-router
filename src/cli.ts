#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { codexArgs, codexChildEnv } from "./codex-args.js";
import { startCodexProxy } from "./codex-proxy.js";
import { observeClaudePrompt } from "./claude-shadow.js";
import { askJev } from "./jev.js";
import { readLoginKeychainPassword } from "./keychain.js";
import { writeDecision } from "./metrics.js";
import { defaultSettings } from "./policy.js";
import { readMetricsFile } from "./report.js";
import { evaluateCases, readEvaluationCases } from "./evaluate.js";
import type { Mode, RouteChoice, RouteQuery, RouterSettings, Tier } from "./types.js";

type Parsed = { settings: RouterSettings; metricsFile?: string; port?: number;
  keychainService?: string; keychainAccount?: string; remaining: string[] };

function parseOptions(args: string[]): Parsed {
  const settings = defaultSettings();
  let metricsFile: string | undefined;
  let port: number | undefined;
  let keychainService: string | undefined;
  let keychainAccount: string | undefined;
  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--") { index += 1; break; }
    if (!flag?.startsWith("--")) break;
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === "--mode") {
      if (!["pass", "force", "shadow", "auto"].includes(value)) throw new Error(`invalid mode: ${value}`);
      settings.mode = value as Mode;
    } else if (flag === "--force-model") settings.forceModel = value;
    else if (flag === "--baseline-model") settings.baselineModel = value;
    else if (flag === "--fast-model" || flag === "--balanced-model" || flag === "--strong-model") {
      const tier = flag.slice(2, -6) as Tier;
      settings.models[tier] = value;
    } else if (flag === "--metrics") metricsFile = value;
    else if (flag === "--keychain-service") keychainService = value;
    else if (flag === "--keychain-account") keychainAccount = value;
    else if (flag === "--port") {
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${value}`);
    } else throw new Error(`unknown option: ${flag}`);
    index += 2;
  }
  if (settings.mode === "force" && !settings.forceModel) throw new Error("--force-model is required in force mode");
  return { settings, metricsFile, port, keychainService, keychainAccount, remaining: args.slice(index) };
}

function resolveCodex(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const file = join(directory, "codex");
    try { accessSync(file, constants.X_OK); return file; } catch { /* Try the next PATH entry. */ }
  }
  throw new Error("Codex CLI not found in PATH");
}

function keychainSpec(service?: string, account?: string): { service: string; account: string } | null {
  if (Boolean(service) !== Boolean(account)) throw new Error("both --keychain-service and --keychain-account are required");
  return service && account ? { service, account } : null;
}

async function keychainApiKey(service: string, account: string): Promise<string> {
  try { return await readLoginKeychainPassword(service, account); }
  catch { throw new Error("TypeSafe Keychain item unavailable"); }
}

async function keychainClassifier(spec: { service: string; account: string } | null): Promise<((query: RouteQuery) => Promise<RouteChoice>) | undefined> {
  if (!spec) return undefined;
  const apiKey = await keychainApiKey(spec.service, spec.account);
  return (query) => askJev(query, { apiKey });
}

async function runCodex(parsed: Parsed): Promise<void> {
  const spec = keychainSpec(parsed.keychainService, parsed.keychainAccount);
  const command = resolveCodex();
  const classify = parsed.settings.mode === "pass" || parsed.settings.mode === "force" ? undefined : await keychainClassifier(spec);
  const proxy = await startCodexProxy({ settings: parsed.settings, classify, onDecision: (event) => writeDecision(event, parsed.metricsFile) });
  const baseUrl = `http://127.0.0.1:${proxy.port}`;
  if (parsed.settings.mode === "auto" && !spec && !process.env.TYPESAFE_API_KEY && !process.env.JEV_API_KEY) {
    process.stderr.write("[amr] No TypeSafe key; Auto will retain the current model.\n");
  }
  process.stderr.write(`[amr] Codex ${parsed.settings.mode} mode · local proxy ${baseUrl}\n`);
  const args = codexArgs(baseUrl, parsed.remaining);
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env: codexChildEnv(process.env) });
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  });
  await proxy.close();
  process.exitCode = exitCode;
}

async function runServer(parsed: Parsed): Promise<void> {
  const spec = keychainSpec(parsed.keychainService, parsed.keychainAccount);
  const classify = parsed.settings.mode === "pass" || parsed.settings.mode === "force" ? undefined : await keychainClassifier(spec);
  const proxy = await startCodexProxy({ settings: parsed.settings, port: parsed.port ?? 8765,
    classify, onDecision: (event) => writeDecision(event, parsed.metricsFile) });
  process.stdout.write(`Agent Model Router listening on http://127.0.0.1:${proxy.port}\n`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await proxy.close();
}

async function readHookInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of process.stdin) {
    const buffer = Buffer.from(part);
    size += buffer.length;
    if (size > 4 * 1024 * 1024) throw new Error("hook input too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function runClaudeShadowHook(parsed: Parsed): Promise<void> {
  if (!parsed.metricsFile) throw new Error("--metrics FILE is required for claude-shadow-hook");
  const spec = keychainSpec(parsed.keychainService, parsed.keychainAccount);
  try {
    const input = await readHookInput();
    if (input && typeof input === "object") {
      const classify = spec
        ? async (query: Parameters<typeof askJev>[0]) =>
          askJev(query, { apiKey: await keychainApiKey(spec.service, spec.account) })
        : askJev;
      await observeClaudePrompt(input, parsed.metricsFile, classify);
    }
  } catch {
    // Hooks are observational only. A failure must never block a user prompt.
  }
}

function help(): void {
  process.stdout.write(`Agent Model Router\n\n` +
    `Jev key: TYPESAFE_API_KEY in the process environment.\n` +
    `         For a local .env file, run: node --env-file=.env dist/cli.js ...\n` +
    `         macOS login Keychain is optional via the flags below.\n\n` +
    `  amr codex [router options] -- [codex arguments]\n` +
    `  amr serve [router options]  (for Codex desktop; default port 8765)\n` +
    `  amr claude-shadow-hook --metrics FILE [--keychain-service NAME --keychain-account USER]\n` +
    `  amr report FILE\n\n` +
    `  amr evaluate FILE --max-calls N [--keychain-service NAME --keychain-account USER]  (paid Jev calls)\n\n` +
    `Router options: --mode pass|force|shadow|auto, --force-model ID,\n` +
    `  --baseline-model ID, --fast-model ID, --balanced-model ID,\n` +
    `  --strong-model ID, --metrics FILE, --port PORT,\n` +
    `  --keychain-service NAME, --keychain-account USER\n`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") return help();
  if (command === "report") {
    if (!args[0]) throw new Error("metrics file required");
    process.stdout.write(`${JSON.stringify(readMetricsFile(args[0]), null, 2)}\n`);
    return;
  }
  if (command === "evaluate") {
    if (!args[0]) throw new Error("evaluation fixture file required");
    const options = new Map<string, string>();
    for (let index = 1; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (!flag || !["--max-calls", "--keychain-service", "--keychain-account"].includes(flag) || !value || options.has(flag)) {
        throw new Error("invalid evaluate options");
      }
      options.set(flag, value);
    }
    const maxCallsRaw = options.get("--max-calls");
    if (!/^\d+$/.test(maxCallsRaw ?? "") || !Number.isSafeInteger(Number(maxCallsRaw)) || Number(maxCallsRaw) < 1) {
      throw new Error("evaluate requires --max-calls N");
    }
    const cases = readEvaluationCases(args[0], Number(maxCallsRaw));
    const spec = keychainSpec(options.get("--keychain-service"), options.get("--keychain-account"));
    const classify = await keychainClassifier(spec);
    if (!classify && !process.env.TYPESAFE_API_KEY && !process.env.JEV_API_KEY) throw new Error("TypeSafe API key required for evaluation");
    process.stdout.write(`${JSON.stringify(await evaluateCases(cases, classify), null, 2)}\n`);
    return;
  }
  const parsed = parseOptions(args);
  if (command === "codex") return runCodex(parsed);
  if (command === "serve") return runServer(parsed);
  if (command === "claude-shadow-hook") return runClaudeShadowHook(parsed);
  throw new Error(`unknown command: ${command}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`[amr] ${error instanceof Error ? error.message : "unexpected error"}\n`);
  process.exitCode = 1;
});
