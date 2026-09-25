#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { codexArgs, codexChildEnv } from "./codex-args.js";
import { startCodexProxy } from "./codex-proxy.js";
import { observeClaudePrompt } from "./claude-shadow.js";
import { askJev } from "./jev.js";
import { readLoginKeychainPassword } from "./keychain.js";
import { writeMetric } from "./metrics.js";
import { defaultSettings } from "./policy.js";
import { readMetricsFile } from "./report.js";
import { readPriceTable } from "./pricing.js";
import { evaluateCases, readEvaluationCases } from "./evaluate.js";
import { compareRuns, readComparisonInput } from "./compare.js";
import { draftComparison, readMetricsText } from "./compare-draft.js";
import { askSearchJev, searchGate, type SearchInput } from "./search-gate.js";
import { readSearchMetrics, writeSearchMetric } from "./search-metrics.js";
import { evaluateSearchSelections, readSearchEvaluation } from "./search-evaluate.js";
import { filterMemory, type MemoryInput } from "./memory-filter.js";
import { readMemoryMetrics, writeMemoryMetric } from "./memory-metrics.js";
import { defaultInstallContext, doctor, install, uninstall, type Client } from "./install.js";
import type { Mode, RouteChoice, RouteQuery, RouterSettings, Tier } from "./types.js";

type Parsed = { settings: RouterSettings; metricsFile?: string; port?: number;
  keychainService?: string; keychainAccount?: string; responseFooter?: boolean; remaining: string[] };

function parseOptions(args: string[]): Parsed {
  const settings = defaultSettings();
  let metricsFile: string | undefined;
  let port: number | undefined;
  let keychainService: string | undefined;
  let keychainAccount: string | undefined;
  let responseFooter: boolean | undefined;
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
    else if (flag === "--response-footer") {
      if (value !== "on" && value !== "off") throw new Error("--response-footer must be on or off");
      responseFooter = value === "on";
    }
    else if (flag === "--baseline-model") settings.baselineModel = value;
    else if (flag === "--fast-model" || flag === "--balanced-model" || flag === "--strong-model") {
      const tier = flag.slice(2, -6) as Tier;
      settings.models[tier] = value;
    } else if (flag === "--metrics") metricsFile = value;
    else if (flag === "--downgrade-confidence") {
      const confidence = Number(value);
      if (!Number.isFinite(confidence) || confidence <= 0 || confidence > 1) throw new Error(`invalid downgrade confidence: ${value}`);
      settings.minimumDowngradeConfidence = confidence;
    }
    else if (flag === "--shadow-fast-confidence") {
      const confidence = Number(value);
      if (!Number.isFinite(confidence) || confidence <= 0 || confidence > 1) throw new Error(`invalid shadow confidence: ${value}`);
      settings.shadowConfidence = { ...settings.shadowConfidence, fast: confidence };
    }
    else if (flag === "--keychain-service") keychainService = value;
    else if (flag === "--keychain-account") keychainAccount = value;
    else if (flag === "--port") {
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${value}`);
    } else throw new Error(`unknown option: ${flag}`);
    index += 2;
  }
  if (settings.mode === "force" && !settings.forceModel) throw new Error("--force-model is required in force mode");
  if (settings.minimumDowngradeConfidence !== undefined && settings.minimumDowngradeConfidence < settings.minimumConfidence) {
    throw new Error("--downgrade-confidence must be at least the minimum routing confidence");
  }
  return { settings, metricsFile, port, keychainService, keychainAccount, responseFooter, remaining: args.slice(index) };
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
  const proxy = await startCodexProxy({ settings: parsed.settings, classify,
    responseFooter: parsed.responseFooter,
    statusFile: parsed.metricsFile,
    onDecision: (event) => writeMetric(event, parsed.metricsFile), onObservation: (event) => writeMetric(event, parsed.metricsFile) });
  const baseUrl = `http://127.0.0.1:${proxy.port}`;
  if (parsed.settings.mode === "auto" && !spec && !process.env.TYPESAFE_API_KEY && !process.env.JEV_API_KEY) {
    process.stderr.write("[jao] No TypeSafe key; Auto will retain the current model.\n");
  }
  process.stderr.write(`[jao] Codex ${parsed.settings.mode} mode · local proxy ${baseUrl}\n`);
  const args = codexArgs(baseUrl, parsed.settings.baselineModel, parsed.remaining);
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
    responseFooter: parsed.responseFooter,
    statusFile: parsed.metricsFile,
    classify, onDecision: (event) => writeMetric(event, parsed.metricsFile), onObservation: (event) => writeMetric(event, parsed.metricsFile) });
  process.stdout.write(`Jev Agent Optimizer listening on http://127.0.0.1:${proxy.port}\n`);
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
  process.stdout.write(`Jev Agent Optimizer\n\n` +
    `Jev key: TYPESAFE_API_KEY in the process environment.\n` +
    `         For a local .env file, run: node --env-file=.env dist/cli.js ...\n` +
    `         macOS login Keychain is optional via the flags below.\n\n` +
    `  jao install [both|codex|claude]  (Codex background setup: macOS)\n` +
    `  jao doctor\n` +
    `  jao uninstall [both|codex|claude]\n\n` +
    `  jao codex [router options] -- [codex arguments]\n` +
    `  jao serve [router options]  (for Codex desktop; default port 8765; /status with --metrics)\n` +
    `  jao claude-shadow-hook --metrics FILE [--keychain-service NAME --keychain-account USER]\n` +
    `  jao report FILE [--prices PRICES.json] [--since ISO-TIME]  (agent cost and savings estimate from your price table)\n\n` +
    `  jao compare FILE  (paired fixed and auto results; no model calls)\n` +
    `  jao compare-draft FIXED.jsonl AUTO.jsonl [--prices FILE]  (prefill compare input from two metrics logs)\n` +
    `  jao search FILE|- [--metrics FILE]  (search-result decision; up to two paid Jev calls)\n` +
    `  jao search-report FILE\n` +
    `  jao search-evaluate FILE  (human-labelled needed-source recall)\n` +
    `  jao memory-filter FILE|- [--metrics FILE]  (passage selection; up to one paid Jev call)\n` +
    `  jao memory-report FILE\n` +
    `  jao memory-evaluate FILE  (human-labelled needed-passage recall)\n` +
    `Router options: --mode pass|force|shadow|auto, --force-model ID,\n` +
    `  --baseline-model ID, --fast-model ID, --balanced-model ID,\n` +
    `  --strong-model ID, --downgrade-confidence 0..1, --shadow-fast-confidence 0..1 (log only),\n` +
    `  --metrics FILE, --port PORT,\n` +
    `  --keychain-service NAME, --keychain-account USER, --response-footer on|off\n`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") return help();
  if (command === "install" || command === "uninstall" || command === "doctor") {
    const client = args[0] ?? "both";
    if ((command === "doctor" && args.length) || args.length > 1 || !["both", "codex", "claude"].includes(client)) {
      throw new Error("사용법: jao install|uninstall [both|codex|claude], jao doctor");
    }
    const context = defaultInstallContext();
    process.stdout.write(command === "doctor" ? await doctor(context)
      : command === "install" ? await install(client as Client, context) : uninstall(client as Client, context));
    return;
  }
  if (command === "report") {
    const usage = "usage: jao report FILE [--prices PRICES.json] [--since ISO-TIME]";
    const options = new Map<string, string>();
    for (let index = 1; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (!flag || !["--prices", "--since"].includes(flag) || !value || options.has(flag)) throw new Error(usage);
      options.set(flag, value);
    }
    if (!args[0]) throw new Error(usage);
    const since = options.has("--since") ? Date.parse(options.get("--since")!) : undefined;
    if (since !== undefined && !Number.isFinite(since)) throw new Error("--since must be a date or ISO time, e.g. 2026-09-25T20:49:00+09:00");
    const summary = readMetricsFile(args[0], options.has("--prices") ? readPriceTable(options.get("--prices")!) : undefined, since);
    for (const warning of summary.warnings) process.stderr.write(`[jao] warning: ${warning}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  if (command === "compare") {
    if (args.length !== 1) throw new Error("compare requires one results file");
    process.stdout.write(`${JSON.stringify(compareRuns(readComparisonInput(args[0]!)), null, 2)}\n`);
    return;
  }
  if (command === "compare-draft") {
    const [fixedFile, autoFile, ...rest] = args;
    const options = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const flag = rest[index], value = rest[index + 1];
      if (!flag || !["--prices", "--fixed-policy", "--auto-policy"].includes(flag) || !value || options.has(flag)) {
        throw new Error("usage: jao compare-draft FIXED.jsonl AUTO.jsonl [--prices FILE] [--fixed-policy NAME] [--auto-policy NAME]");
      }
      options.set(flag, value);
    }
    if (!fixedFile || !autoFile) throw new Error("compare-draft requires fixed and auto metrics files");
    const prices = options.has("--prices") ? readPriceTable(options.get("--prices")!) : undefined;
    const draft = draftComparison(readMetricsText(fixedFile), readMetricsText(autoFile),
      options.get("--fixed-policy") ?? "fixed", options.get("--auto-policy") ?? "Jev Auto", prices);
    process.stdout.write(`${JSON.stringify(draft, null, 2)}\n`);
    return;
  }
  if (command === "search") {
    if (!args[0]) throw new Error("search requires a JSON file or - for stdin");
    const options = new Map<string, string>();
    for (let index = 1; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (!flag || !["--metrics", "--keychain-service", "--keychain-account"].includes(flag) || !value || options.has(flag)) {
        throw new Error("invalid search options");
      }
      options.set(flag, value);
    }
    const source = args[0] === "-" ? await readHookInput() : (() => {
      if (statSync(args[0]!).size > 1024 * 1024) throw new Error("search input file too large");
      return JSON.parse(readFileSync(args[0]!, "utf8")) as unknown;
    })();
    const spec = keychainSpec(options.get("--keychain-service"), options.get("--keychain-account"));
    const ask = spec ? async (state: Record<string, unknown>, questions: Record<string, unknown>) =>
      askSearchJev(state, questions, { apiKey: await keychainApiKey(spec.service, spec.account) }) : askSearchJev;
    const input = source as SearchInput;
    const result = await searchGate(input, ask);
    if (options.has("--metrics")) {
      try { writeSearchMetric(options.get("--metrics")!, input.results.length, result); }
      catch { process.stderr.write("[jao] search metrics sink unavailable\n"); }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "search-report") {
    if (args.length !== 1) throw new Error("search-report requires one metrics file");
    process.stdout.write(`${JSON.stringify(readSearchMetrics(args[0]!), null, 2)}\n`);
    return;
  }
  if (command === "search-evaluate") {
    if (args.length !== 1) throw new Error("search-evaluate requires one labelled file");
    process.stdout.write(`${JSON.stringify(evaluateSearchSelections(readSearchEvaluation(args[0]!)), null, 2)}\n`);
    return;
  }
  if (command === "memory-filter") {
    if (!args[0]) throw new Error("memory-filter requires a JSON file or - for stdin");
    const options = new Map<string, string>();
    for (let index = 1; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (!flag || !["--metrics", "--keychain-service", "--keychain-account"].includes(flag) || !value || options.has(flag)) {
        throw new Error("invalid memory-filter options");
      }
      options.set(flag, value);
    }
    const source = args[0] === "-" ? await readHookInput() : (() => {
      if (statSync(args[0]!).size > 4 * 1024 * 1024) throw new Error("memory input file too large");
      return JSON.parse(readFileSync(args[0]!, "utf8")) as unknown;
    })();
    const spec = keychainSpec(options.get("--keychain-service"), options.get("--keychain-account"));
    const ask = spec ? async (state: Record<string, unknown>, questions: Record<string, unknown>) =>
      askSearchJev(state, questions, { apiKey: await keychainApiKey(spec.service, spec.account) }) : askSearchJev;
    const input = source as MemoryInput;
    const result = await filterMemory(input, ask);
    if (options.has("--metrics")) {
      try { writeMemoryMetric(options.get("--metrics")!, input.candidates.length, result); }
      catch { process.stderr.write("[jao] memory metrics sink unavailable\n"); }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "memory-report") {
    if (args.length !== 1) throw new Error("memory-report requires one metrics file");
    process.stdout.write(`${JSON.stringify(readMemoryMetrics(args[0]!), null, 2)}\n`);
    return;
  }
  if (command === "memory-evaluate") {
    if (args.length !== 1) throw new Error("memory-evaluate requires one labelled file");
    process.stdout.write(`${JSON.stringify(evaluateSearchSelections(readSearchEvaluation(args[0]!), 8), null, 2)}\n`);
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
  process.stderr.write(`[jao] ${error instanceof Error ? error.message : "unexpected error"}\n`);
  process.exitCode = 1;
});
