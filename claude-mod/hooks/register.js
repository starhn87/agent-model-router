const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODELS = {
  fast: "claude-haiku-4-5",
  balanced: "claude-sonnet-5",
  strong: "claude-opus-5",
};
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CONFIDENCE_FLOOR = 0.8;
const TIMEOUT_MS = 1500;
const MAX_PROMPT_CHARS = 1600;
const MAX_CACHED_TURNS = 64;
const METRICS_MAX_BYTES = 3 * 1024 * 1024;
// A model switch forfeits the session's warm prompt cache, so the local fast path
// only applies while the re-sent context is small.
const FAST_PATH_MAX_CONTEXT_TOKENS = 20_000;
export const SENSITIVE_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|bearer|password|secret)\s*[:=]\s*\S+|\.env\b)/i;

// A dated snapshot (claude-…-20251001) is the requested model; a longer version number (…-5 vs …-5-5) is not.
const DATED_SUFFIX = /^(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
function sameModel(served, requested) {
  return served === requested || (served.startsWith(`${requested}-`) && DATED_SUFFIX.test(served.slice(requested.length + 1)));
}

// Mirrors isSimpleTurn in src/policy.ts; claude-mod/tests/policy-sync.test.js keeps them in step.
export function isSimpleTurn(prompt) {
  if (/^(?:안녕(?:하세요|하십니까)?|반가워(?:요)?|hello|hi|hey)[.!~\s]*$/iu.test(prompt)) return true;
  if (prompt.length > 240 || /[\r\n]/u.test(prompt)) return false;
  const korean = prompt.match(/^(.+?)(?:의)?\s+(?:맞춤법|문법|오탈자)(?:을|를)?\s*(?:고쳐\s*줘|수정해\s*줘|교정해\s*줘)[.!?\s]*$/u);
  const english = prompt.match(/^(?:fix|correct) (?:the )?(?:spelling|grammar)(?: of| in)?\s*:\s*(.+)$/iu);
  const supplied = korean?.[1] ?? english?.[1];
  if (!supplied) return false;
  const quoted = supplied.match(/^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|“([^”\r\n]+)”|‘([^’\r\n]+)’)$/u);
  if (quoted) {
    const prose = quoted.slice(1).find((part) => part !== undefined);
    return /\p{L}/u.test(prose) && /^[\p{L}\p{N}\s,.!?…'’“-]+$/u.test(prose);
  }
  if (/^(?:this|that|it|the above|previous|above)(?:\s|$)/iu.test(supplied)) return false;
  return /^[a-z][a-z ',.!?’-]*$/iu.test(supplied) && supplied.trim().split(/\s+/u).length >= 3;
}

export function keyFromEnvFile(contents) {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const raw = match[1] ?? "";
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }
    return raw.split(/\s+#/)[0]?.trim() ?? "";
  }
  return "";
}

export function choiceFromJev(body) {
  const answer = body?.answers?.tier;
  if (answer?.type !== "choice" || !Object.hasOwn(MODELS, answer.choice)) return null;
  if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 || answer.confidence > 1) return null;
  const score = body?.answers?.effort;
  const effort = score?.type === "score" && typeof score.score === "number" &&
    Number.isFinite(score.score) && score.score >= 0 && score.score <= 4
    ? EFFORTS[Math.round(score.score)] : undefined;
  return { tier: answer.choice, confidence: answer.confidence, ...(effort ? { effort } : {}) };
}

async function envFile($) {
  return await $.env.get("JAO_ENV_FILE") || `${$.plugin.root}/../.env`;
}

async function apiKey($) {
  const direct = await $.env.get("TYPESAFE_API_KEY");
  if (direct) return direct;
  const file = await envFile($);
  try {
    return keyFromEnvFile(await $.fs.read(file));
  } catch {
    return "";
  }
}

async function modelFor($, tier) {
  const name = { fast: "JAO_CLAUDE_FAST_MODEL", balanced: "JAO_CLAUDE_BALANCED_MODEL", strong: "JAO_CLAUDE_STRONG_MODEL" }[tier];
  return await $.env.get(name) || MODELS[tier];
}

export function jevRequest(prompt) {
  return {
    model: "jev-latest",
    state: { user_turn: prompt.slice(0, MAX_PROMPT_CHARS) },
    questions: {
      tier: {
        type: "choice",
        instructions: "Choose the least expensive Claude model tier that can reliably complete this user turn. Assess the requested work, not message length. If context is insufficient, choose balanced.",
        criteria: {
          fast: "Simple formatting, direct facts, small unambiguous edits, or routine replies with low risk.",
          balanced: "Typical coding, writing, analysis, and multi-step tasks requiring sound judgment.",
          strong: "Hard debugging, architecture, high-stakes reasoning, complex cross-file changes, or ambiguous trade-offs.",
        },
      },
      effort: {
        type: "score",
        instructions: "How much reasoning does this user turn require? Judge the work independently of the model tier.",
        criteria: [
          "Immediate answer or mechanical edit; little reasoning.",
          "A few simple steps or a small choice.",
          "Several steps, ordinary coding, or a meaningful judgment.",
          "Complex debugging, planning, or interacting constraints.",
          "Open-ended or high-stakes work requiring the deepest reasoning.",
        ],
      },
    },
  };
}

async function routeTurn($, text, contextTokens) {
  const prompt = text.trim();
  if (SENSITIVE_PATTERN.test(prompt)) return { reason: "sensitive prompt" };
  if (isSimpleTurn(prompt)) {
    if (contextTokens > FAST_PATH_MAX_CONTEXT_TOKENS) return { reason: "simple turn; kept warm cache" };
    return { tier: "fast", confidence: 1, effort: "low", model: await modelFor($, "fast"), reason: "simple turn" };
  }
  if (prompt.length < 12) return { reason: "short or empty prompt" };

  const key = await apiKey($);
  if (!key) return { reason: "TypeSafe key unavailable" };

  const endpoint = await $.env.get("JAO_TYPESAFE_ENDPOINT") || ENDPOINT;
  const request = jevRequest(prompt);
  const started = await now($);

  try {
    const timeout = Symbol("timeout");
    const response = await Promise.race([
      $.http.fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
      $.clock.sleep(TIMEOUT_MS).then(() => timeout),
    ]);
    const latencyMs = (await now($)) - started;
    if (response === timeout) return { reason: "Jev timeout", jevError: true, latencyMs };
    if (!response.ok) return { reason: `Jev HTTP ${response.status}`, jevError: true, latencyMs };
    const body = JSON.parse(response.text);
    const choice = choiceFromJev(body);
    const tokens = body?.usage?.input_tokens;
    const jevInputTokens = Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : undefined;
    const measured = { latencyMs, ...(jevInputTokens === undefined ? {} : { jevInputTokens }) };
    if (!choice) return { reason: "Jev answer invalid", jevError: true, ...measured };
    if (choice.confidence < CONFIDENCE_FLOOR) {
      return { tier: choice.tier, confidence: choice.confidence, effort: choice.effort,
        reason: "Jev tier confidence below 0.8", ...measured };
    }
    return { ...choice, model: await modelFor($, choice.tier), reason: "Jev choice", ...measured };
  } catch {
    return { reason: "Jev request failed", jevError: true };
  }
}

async function now($) {
  return typeof $.clock.now === "function" ? $.clock.now() : Date.now();
}

// Appends one JSONL event per call in the same shape `jao report` reads for Codex.
// Only models, reasons, counts and timings are written, never prompt or answer text.
function metricsWriter($) {
  let chain = Promise.resolve();
  return (event) => {
    chain = chain.then(async () => {
      if ((await $.env.get("JAO_CLAUDE_METRICS")) === "0") return;
      const file = (await envFile($)).replace(/[^/\\]*$/, ".local/claude.jsonl");
      let text = "";
      try { text = await $.fs.read(file); } catch { /* A missing log starts empty. */ }
      text += `${JSON.stringify(event)}\n`;
      if (text.length > METRICS_MAX_BYTES) text = text.slice(text.indexOf("\n", text.length - METRICS_MAX_BYTES) + 1);
      await $.fs.write(file, text);
    }).catch(() => { /* Metrics must never block a turn. */ });
    return chain;
  };
}

function decisionEvent(at, turnId, route) {
  const result = route.jevError ? "error" : route.model ? "routed" : "kept";
  return { at, client: "claude", mode: "auto", result, model: route.model ?? "claude-session",
    ...(route.effort ? { effort: route.effort, recommendedEffort: route.effort } : {}),
    ...(route.tier ? { recommendedTier: route.tier } : {}),
    ...(typeof route.confidence === "number" ? { confidence: route.confidence } : {}),
    ...(typeof route.latencyMs === "number" ? { latencyMs: route.latencyMs } : {}),
    ...(typeof route.jevInputTokens === "number" ? { jevInputTokens: route.jevInputTokens } : {}),
    requestId: `${turnId}:decision`, taskId: turnId, reason: route.reason };
}

function statusOf(enabled, last) {
  if (!enabled) return "Jev Agent Optimizer: off (set JAO_CLAUDE_AUTO=1 and restart Claude Code).";
  if (!last) return "Jev Agent Optimizer: on; no user turn classified yet.";
  const picked = last.model ? `${last.tier} → ${last.model} (${last.confidence})` : last.reason;
  const recommended = last.effort ? `; Jev recommended effort ${last.effort}` : "";
  const requested = last.requestedEffort ? `; requested effort ${last.requestedEffort}` : "";
  const mismatch = last.model && last.servedModel && !sameModel(last.servedModel, last.model) ? ` ≠ ${last.model}` : "";
  const served = last.servedModel ? `; API served ${last.servedModel}${mismatch}` : "";
  return `Jev Agent Optimizer: ${picked}${recommended}${requested}${served}.`;
}

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

// What the prompt footer and the turn's closing notice show: the model and effort the
// plugin actually requested, and the served model only when it differs.
function routeLabel(route, { served = false } = {}) {
  const model = typeof route.requestedModel === "string" && SAFE_MODEL.test(route.requestedModel) ? route.requestedModel : "확인 불가";
  const requested = route.requestedEffort;
  const effort = typeof requested === "number" && Number.isFinite(requested) ? String(requested)
    : typeof requested === "string" && /^[a-z]+$/.test(requested) ? requested : "기본값";
  const mismatch = served && typeof route.servedModel === "string" && SAFE_MODEL.test(route.servedModel) &&
    model !== "확인 불가" && !sameModel(route.servedModel, model) ? ` ≠ ${route.servedModel}` : "";
  return `Jev Auto · ${model} · effort ${effort}${mismatch}`;
}

export function register(on) {
  const routes = new Map();
  let enabled = false;
  let footerEnabled = true;
  let last = null;
  let contextTokens = 0;
  let record = null;

  // Drawn only: the prompt footer's mode label never enters the transcript, so the
  // model cannot imitate it on a later turn. (Terminal and desktop surfaces.)
  on("ui.render", { component: "SessionMode" }, ($, e, next) => {
    if (!enabled || !footerEnabled) return next(e);
    const label = last?.requestedModel ? routeLabel(last, { served: true }) : "Jev Auto";
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } });
  });

  on("session.start", async ($, e, next) => {
    enabled = (await $.env.get("JAO_CLAUDE_AUTO")) === "1";
    footerEnabled = (await $.env.get("JAO_RESPONSE_FOOTER")) !== "0";
    record = metricsWriter($);
    await $.command.register({ name: "jao-route", description: "Show the last Jev route and API model" });
    return next(e);
  });

  on("command.run", { command: "jao-route" }, () => ({ text: statusOf(enabled, last) }));

  on("turn.start", async ($, e, next) => {
    if (enabled) {
      let route;
      try {
        route = await routeTurn($, e.text, contextTokens);
      } catch {
        route = { reason: "router error" };
      }
      route.startedAt = await now($);
      route.steps = 0;
      routes.set(e.turnId, route);
      void record?.(decisionEvent(new Date(route.startedAt).toISOString(), e.turnId, route));
      last = route;
      while (routes.size > MAX_CACHED_TURNS) routes.delete(routes.keys().next().value);
    }
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    const route = e.agentId === undefined ? routes.get(e.turnId) : undefined;
    const request = route?.model || route?.effort
      ? { ...e, ...(route.model ? { model: route.model } : {}), ...(route.effort ? { effort: route.effort } : {}) } : e;
    if (route) {
      route.requestedModel = request.model;
      route.requestedEffort = request.effort;
      $.ui.invalidate("ui.render");
    }
    const stepStarted = route ? await now($) : 0;
    for await (const chunk of next(request)) {
      if (chunk.kind === "stop" && chunk.usage && e.agentId === undefined) {
        const usage = chunk.usage;
        const cached = usage.cache_read_input_tokens ?? 0;
        const input = (usage.input_tokens ?? 0) + cached + (usage.cache_creation_input_tokens ?? 0);
        contextTokens = input + (usage.output_tokens ?? 0);
        if (route && typeof usage.model === "string") {
          route.servedModel = usage.model;
          $.ui.invalidate("ui.render");
          const at = await now($);
          void record?.({ at: new Date(at).toISOString(), client: "claude", kind: "response",
            requestId: `${e.turnId}:${route.steps++}`, taskId: e.turnId, requestDurationMs: at - stepStarted,
            requestedModel: request.model, ...(typeof request.effort === "string" ? { requestedEffort: request.effort } : {}),
            servedModel: usage.model, inputTokens: input, cachedInputTokens: cached, outputTokens: usage.output_tokens ?? 0 });
        }
      }
      yield chunk;
    }
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined) return result;
    const route = routes.get(e.turnId);
    routes.delete(e.turnId);
    if (!enabled || !footerEnabled || !route || e.reason !== "answer" || !e.answer) return result;
    if (typeof e.usage?.model === "string") route.servedModel = e.usage.model;
    // turn.complete displays a synopsis beneath the answer without rewriting its transcript:
    // the one channel every surface shows (a stream-json host gets it as a system notice).
    const footer = routeLabel(route, { served: true });
    return { ...result, text: result.text && result.text !== e.answer ? `${result.text}\n\n${footer}` : footer };
  });
}
