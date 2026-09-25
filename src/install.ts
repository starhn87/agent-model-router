import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Client = "codex" | "claude" | "both";
export type InstallContext = {
  home: string; repo: string; platform: string; node: string;
  customConfig?: { codex?: string; claude?: string };
  run: (command: string, args: string[]) => void;
};
const LABEL = "com.agent-model-router.codex";
const PORT = 8765;
const CODEX_KEYS = /^\s*(model|model_provider)\s*=/;
const PROVIDER = `[model_providers.agent_router]\nname = "Agent Model Router"\nbase_url = "http://127.0.0.1:8765"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n`;
const ROOT_SETTINGS = 'model = "gpt-6-astra"\nmodel_provider = "agent_router"\n';
const read = (path: string): string | null => existsSync(path) ? readFileSync(path, "utf8") : null;
const present = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };
const sameLink = (path: string, target: string): boolean => {
  try { return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === target; } catch { return false; }
};
function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.amr-${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}
function restore(path: string, text: string | null): void {
  if (text === null) rmSync(path, { force: true }); else write(path, text);
}
function object(text: string | null): Record<string, any> {
  const value = text === null ? {} : JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("설정 파일이 JSON 객체가 아닙니다.");
  return value;
}
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function sections(text: string): { head: string; rest: string[]; provider?: string } {
  // Never guess boundaries inside TOML multiline strings or nonstandard provider tables.
  if (text.includes('"""') || text.includes("'''")) throw new Error("여러 줄 TOML 문자열이 있어 자동 수정을 중단했습니다. 수동 설치 안내를 사용하세요.");
  const parts = text.split(/(?=^[ \t]*\[)/m);
  const head = parts[0]?.trimStart().startsWith("[") ? "" : parts.shift() ?? "";
  const providers = parts.filter((part) => /^\s*\[model_providers\.agent_router\]\s*(?:#.*)?\n/.test(part));
  if (providers.length > 1 || parts.some((part) => /agent_router/.test(part.split("\n")[0] ?? "") && !providers.includes(part))) {
    throw new Error("agent_router 공급자 테이블 형식을 안전하게 수정할 수 없습니다.");
  }
  if (/^\s*(?:["'](?:model|model_provider)["']|model_providers(?:\s*=|\.))/m.test(head) ||
    parts.some((part) => /^\s*\[model_providers\]/.test(part) && /^\s*agent_router\s*=/m.test(part))) {
    throw new Error("인라인 또는 인용된 공급자 설정은 수동 설치가 필요합니다.");
  }
  for (const key of ["model", "model_provider"]) {
    if (head.split("\n").filter((line) => new RegExp(`^\\s*${key}\\s*=`).test(line)).length > 1) throw new Error(`중복 Codex 설정: ${key}`);
  }
  return { head, rest: parts.filter((part) => !providers.includes(part)), provider: providers[0] };
}
function headWithoutModel(head: string): string { return head.split(/(?<=\n)/).filter((line) => !CODEX_KEYS.test(line)).join(""); }
function modelLines(head: string): string { return head.split(/(?<=\n)/).filter((line) => CODEX_KEYS.test(line)).map((line) => line.endsWith("\n") ? line : `${line}\n`).join(""); }
const isOurProvider = (text: string): boolean => /^\s*base_url\s*=\s*["']http:\/\/127\.0\.0\.1:8765\/?["']\s*(?:#.*)?$/m.test(text);
export function configureCodex(text: string): string {
  const parsed = sections(text.replaceAll("\r\n", "\n"));
  if (parsed.provider && !isOurProvider(parsed.provider)) throw new Error("다른 agent_router 공급자가 있어 덮어쓰지 않았습니다.");
  return `${ROOT_SETTINGS}${headWithoutModel(parsed.head)}${parsed.rest.join("").trimEnd()}\n\n${PROVIDER}`;
}
export function unconfigureCodex(current: string, previous: string | null): string {
  const parsed = sections(current);
  const original = sections(previous ?? "");
  if (modelLines(parsed.head) !== ROOT_SETTINGS || parsed.provider?.trim() !== PROVIDER.trim()) {
    throw new Error("설치 후 Codex의 라우터 설정이 변경됐습니다. 해당 설정을 먼저 확인하세요.");
  }
  let restored = modelLines(original.head);
  const adopted = /^\s*model_provider\s*=\s*["']agent_router["']/m.test(restored);
  if (adopted) restored = restored.replace(/^\s*model_provider\s*=.*\n?/m, 'model_provider = "openai"\n');
  return `${restored}${headWithoutModel(parsed.head)}${parsed.rest.join("").trimEnd()}${!adopted && original.provider ? `\n\n${original.provider}` : ""}\n`;
}
function claudeEnv(repo: string): Record<string, string> {
  return { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1", AMR_CLAUDE_AUTO: "1", AMR_ENV_FILE: join(repo, ".env"), AMR_RESPONSE_FOOTER: "1" };
}
export function configureClaude(text: string | null, repo: string): string {
  const settings = object(text);
  if (settings.env !== undefined && (!settings.env || typeof settings.env !== "object" || Array.isArray(settings.env))) throw new Error("Claude env 설정이 객체가 아닙니다.");
  if (Object.entries(settings.enabledPlugins ?? {}).some(([name, enabled]) => name.startsWith("agent-model-router@") && enabled)) {
    throw new Error("마켓플레이스 라우터가 이미 설치되어 있습니다. 중복 설치하지 말고 해당 플러그인을 사용하세요.");
  }
  return json({ ...settings, env: { ...settings.env, ...claudeEnv(repo) } });
}
export function unconfigureClaude(current: string, previous: string | null, repo: string): string {
  const settings = object(current);
  const before = object(previous);
  for (const [key, value] of Object.entries(claudeEnv(repo))) {
    if (settings.env?.[key] !== value) throw new Error(`설치 후 Claude ${key} 설정이 변경됐습니다. 먼저 확인하세요.`);
    if (before.env && Object.hasOwn(before.env, key)) settings.env[key] = before.env[key];
    else delete settings.env[key];
  }
  // Adopt legacy AMR installs, but disabling must actually turn routing off.
  if (before.env?.AMR_CLAUDE_AUTO === "1") settings.env.AMR_CLAUDE_AUTO = "0";
  if (!Object.keys(settings.env).length) delete settings.env;
  return json(settings);
}
const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export function servicePlist(context: InstallContext): string {
  const args = [context.node, `--env-file=${join(context.repo, ".env")}`, join(context.repo, "dist/cli.js"), "serve", "--mode", "auto", "--baseline-model", "gpt-6-astra",
    "--downgrade-confidence", "0.9", "--port", String(PORT), "--metrics", join(context.repo, ".local/codex-persistent.jsonl")];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>WorkingDirectory</key><string>${xml(context.repo)}</string>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>\n<key>StandardOutPath</key><string>${xml(join(context.repo, ".local/router.stdout.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(join(context.repo, ".local/router.stderr.log"))}</string>\n</dict></plist>\n`;
}

type SavedClient = { config: string | null; service?: string | null; linkExisted?: boolean };
type InstallState = { version: 1; repo: string; codex?: SavedClient; claude?: SavedClient };
function paths(context: InstallContext) {
  return { state: join(context.home, ".agent-model-router/install.json"), codex: join(context.home, ".codex/config.toml"),
    claude: join(context.home, ".claude/settings.json"), link: join(context.home, ".claude/skills/agent-model-router"),
    target: join(context.repo, "claude-mod"), service: join(context.home, `Library/LaunchAgents/${LABEL}.plist`) };
}
function stateOf(context: InstallContext): InstallState {
  const text = read(paths(context).state);
  if (!text) return { version: 1, repo: context.repo };
  const state = JSON.parse(text) as InstallState;
  if (state.version !== 1 || state.repo !== context.repo) throw new Error("다른 경로에서 설치된 라우터가 있습니다. 기존 경로에서 먼저 해제하세요.");
  return state;
}
function selected(client: Client, name: "codex" | "claude"): boolean { return client === name || client === "both"; }
function domain(): string { return `gui/${process.getuid!()}`; }
function stop(context: InstallContext, service: string): void {
  // launchctl bootout returns nonzero when already stopped. Verify presence first.
  try { context.run("launchctl", ["print", `${domain()}/${LABEL}`]); } catch { return; }
  context.run("launchctl", ["bootout", domain(), service]);
}
function start(context: InstallContext, service: string): void { context.run("launchctl", ["bootstrap", domain(), service]); }
function backup(context: InstallContext, files: string[]): void {
  const dir = join(context.home, ".agent-model-router/backups", `${Date.now()}-${process.pid}`);
  for (const [index, file] of files.entries()) {
    const content = read(file);
    if (content !== null) write(join(dir, `${index}-${file.split("/").at(-1)}`), content);
  }
}
function checkKey(repo: string): void {
  const text = read(join(repo, ".env"));
  if (!text || !/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*["']?[^\s"'#]+/m.test(text)) {
    throw new Error("TypeSafe 키가 없습니다. 저장소의 .env.example을 .env로 복사하고 TYPESAFE_API_KEY를 입력한 뒤 다시 실행하세요.");
  }
}
function checkConfigLocations(client: Client, context: InstallContext): void {
  for (const name of ["codex", "claude"] as const) {
    if (selected(client, name) && context.customConfig?.[name]) {
      throw new Error(`${name}의 사용자 지정 설정 경로가 있습니다 (${context.customConfig[name]}). 고급 설치 안내의 수동 구성을 사용하세요.`);
    }
  }
}

export async function install(client: Client, context: InstallContext): Promise<string> {
  checkConfigLocations(client, context);
  const p = paths(context);
  const state = stateOf(context);
  checkKey(context.repo);
  const codex = selected(client, "codex");
  const claude = selected(client, "claude");
  if (codex && context.platform !== "darwin") throw new Error("Codex 백그라운드 자동 설치는 현재 macOS만 지원합니다. README의 수동 실행 방법을 사용하세요.");
  if (claude) {
    context.run("claude", ["plugin", "validate", "--strict", p.target]);
    if (present(p.link) && !sameLink(p.link, p.target)) throw new Error("Claude 설치 위치에 다른 파일이 있어 덮어쓰지 않았습니다.");
  }
  const beforeCodex = read(p.codex); const beforeClaude = read(p.claude); const beforeService = read(p.service);
  const updatedCodex = codex ? configureCodex(beforeCodex ?? "") : null;
  const updatedClaude = claude ? configureClaude(beforeClaude, context.repo) : null;
  if (codex && beforeService && !beforeService.includes(xml(join(context.repo, "dist/cli.js")))) {
    throw new Error("다른 저장소를 실행하는 라우터 서비스가 있습니다. 기존 설치를 먼저 해제하세요.");
  }
  // Check the port before any mutation; a stopped legacy service is allowed.
  if (codex) {
    let response: Response | undefined;
    try {
      response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(700) });
    } catch { /* A stopped service is expected on a fresh install. */ }
    if (response) {
      let health: { service?: string; status?: string } = {};
      try { health = await response.json() as typeof health; } catch { /* Unrecognized server. */ }
      if (!response.ok || !beforeService || health?.status !== "ok" || (health.service && health.service !== "agent-model-router")) {
        throw new Error("8765 포트를 다른 서버가 사용 중입니다.");
      }
    }
  }
  backup(context, [p.codex, p.claude, p.service, p.state]);
  const hadLink = present(p.link);
  const oldState = read(p.state);
  let serviceStopped = false;
  try {
    chmodSync(join(context.repo, ".env"), 0o600);
    if (codex) {
      stop(context, p.service); serviceStopped = true;
      mkdirSync(join(context.repo, ".local"), { recursive: true, mode: 0o700 });
      write(p.service, servicePlist(context));
      start(context, p.service);
      // Only redirect Codex once the new service is ready.
      let ready = false;
      for (let i = 0; i < 20; i++) {
        try {
          const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(500) });
          const health = await response.json() as { service?: string; responseFooter?: boolean };
          if (health.service === "agent-model-router" && health.responseFooter) { ready = true; break; }
        } catch { /* Allow launchd a moment to start. */ }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!ready) throw new Error("새 라우터 서버가 준비되지 않아 설정을 복원합니다. .local/router.stderr.log를 확인하세요.");
      write(p.codex, updatedCodex!);
      state.codex ??= { config: beforeCodex, service: beforeService };
    }
    if (claude) {
      mkdirSync(dirname(p.link), { recursive: true, mode: 0o700 });
      if (!hadLink) symlinkSync(p.target, p.link, context.platform === "win32" ? "junction" : "dir");
      write(p.claude, updatedClaude!);
      state.claude ??= { config: beforeClaude, linkExisted: hadLink };
    }
    write(p.state, json(state));
  } catch (error) {
    if (codex && serviceStopped) {
      stop(context, p.service); restore(p.service, beforeService); restore(p.codex, beforeCodex);
      if (beforeService) start(context, p.service);
    }
    if (claude) { restore(p.claude, beforeClaude); if (!hadLink && sameLink(p.link, p.target)) rmSync(p.link); }
    restore(p.state, oldState);
    throw error;
  }
  return `${client} 설치 완료. 설정 백업: ${join(context.home, ".agent-model-router/backups")}\n` +
    (codex ? "Codex: 로그인 시 서버가 자동 시작됩니다. 앱을 재시작하고 새 작업에서 Jev Auto를 선택하세요.\n" : "") +
    (claude ? "Claude: 새 CLI/Code 탭 세션부터 자동 적용됩니다. /amr-route로 확인하세요.\n" : "") +
    "최종 답변 아래에 실제 모델과 요청 effort가 표시됩니다. npm run doctor로 설치 상태를 확인하세요.\n";
}

export function uninstall(client: Client, context: InstallContext): string {
  checkConfigLocations(client, context);
  const p = paths(context); const state = stateOf(context);
  const codex = selected(client, "codex") && state.codex;
  const claude = selected(client, "claude") && state.claude;
  // Preflight all conflicts before removing anything.
  const nextCodex = codex ? unconfigureCodex(read(p.codex) ?? "", codex.config) : null;
  const nextClaude = claude ? unconfigureClaude(read(p.claude) ?? "{}", claude.config, context.repo) : null;
  if (codex && read(p.service) !== servicePlist(context)) throw new Error("라우터 서비스 파일이 변경되어 자동 해제를 중단했습니다.");
  if (claude && !sameLink(p.link, p.target)) throw new Error("Claude 플러그인 연결이 변경되어 자동 해제를 중단했습니다.");
  if (!codex && !claude) throw new Error("이 설치 도구의 설치 기록이 없습니다. 먼저 npm run setup으로 기존 설치를 등록하세요.");
  backup(context, [p.codex, p.claude, p.service, p.state]);
  if (codex) {
    // Restore the provider before stopping the service, including adopted legacy installs.
    write(p.codex, nextCodex!);
    stop(context, p.service); rmSync(p.service, { force: true }); delete state.codex;
  }
  if (claude) {
    write(p.claude, nextClaude!); rmSync(p.link); delete state.claude;
  }
  write(p.state, json(state));
  return "자동 라우팅을 해제했습니다. Codex 앱을 재시작하고 새 작업을 만드세요. Claude도 새 세션부터 반영됩니다. 키 파일은 보존했습니다.\n";
}

export async function doctor(context: InstallContext): Promise<string> {
  const p = paths(context);
  const lines = [`Agent Model Router · ${context.repo}`];
  if (context.customConfig?.codex || context.customConfig?.claude) {
    lines.push("주의: 사용자 지정 설정 경로가 감지되었습니다. 아래 결과는 기본 사용자 경로만 진단합니다.");
  }
  try { checkKey(context.repo); lines.push("TypeSafe 키: .env에 설정됨 (값은 표시하지 않음)"); } catch { lines.push("TypeSafe 키: 설정 필요 (.env)"); }
  try {
    const settings = object(read(p.claude));
    const linked = sameLink(p.link, p.target);
    const marketplace = Object.entries(settings.enabledPlugins ?? {}).some(([name, enabled]) => name.startsWith("agent-model-router@") && enabled);
    const enabled = settings.env?.AMR_CLAUDE_AUTO === "1" && settings.env?.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === "1";
    lines.push(`Claude: 플러그인 ${linked ? "로컬 연결됨" : marketplace ? "마켓플레이스에서 활성화됨" : "연결 없음"} · 자동 라우팅 ${enabled ? "설정 켜짐" : "설정 꺼짐"}`);
    lines.push(`  설정: ${p.claude}\n  확인: 새 Claude Code 세션에서 /amr-route (일반 채팅에는 적용 안 됨)`);
  } catch { lines.push(`Claude: 설정 읽기 실패 (${p.claude})`); }
  try {
    const config = sections(read(p.codex) ?? "");
    const configured = /^\s*model_provider\s*=\s*["']agent_router["']/m.test(config.head) && config.provider && isOurProvider(config.provider);
    lines.push(`Codex: 로컬 라우터 공급자 ${configured ? "연결됨" : "연결 안 됨"}`);
  } catch { lines.push("Codex: 설정 형식을 자동 진단할 수 없음"); }
  lines.push(`  설정: ${p.codex}\n  로그인 시 자동 실행: ${existsSync(p.service) ? "서비스 파일 있음" : "서비스 파일 없음"} (${p.service})`);
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(700) });
    const health = await response.json() as { status?: string; service?: string; responseFooter?: boolean };
    lines.push(`  서버: ${health.status === "ok" ? "응답 중" : "확인 필요"} · 응답 끝 표시: ${health.responseFooter ? "지원/활성" : "구버전 또는 비활성"}`);
  } catch { lines.push("  서버: 응답 없음 — npm run setup -- codex로 설치/재시작하세요."); }
  lines.push("  기존 Codex 작업은 옛 공급자를 유지할 수 있습니다. 앱 재시작 후 새 작업에서 Jev Auto를 선택하세요.");
  lines.push(`설치 도구 기록: ${existsSync(p.state) ? p.state : "없음 (기존 수동 설치일 수 있음)"}`);
  return `${lines.join("\n")}\n`;
}

export function defaultInstallContext(): InstallContext {
  const home = homedir();
  return { home, repo: resolve(dirname(fileURLToPath(import.meta.url)), ".."), platform: process.platform, node: process.execPath,
    customConfig: {
      codex: process.env.CODEX_HOME && resolve(process.env.CODEX_HOME) !== join(home, ".codex") ? process.env.CODEX_HOME : undefined,
      claude: process.env.CLAUDE_CONFIG_DIR && resolve(process.env.CLAUDE_CONFIG_DIR) !== join(home, ".claude") ? process.env.CLAUDE_CONFIG_DIR : undefined,
    },
    run(command, args) {
      const result = spawnSync(command, args, { encoding: "utf8", timeout: 15000 });
      if (result.error || result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(" ")} 실행 실패. 설치 여부와 권한을 확인하세요.`);
    } };
}
