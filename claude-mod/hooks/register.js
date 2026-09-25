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
const SENSITIVE_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|bearer|password|secret)\s*[:=]\s*\S+|\.env\b)/i;

// A dated snapshot (claude-…-20251001) is the requested model; a longer version number (…-5 vs …-5-5) is not.
const DATED_SUFFIX = /^(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
function sameModel(served, requested) {
  return served === requested || (served.startsWith(`${requested}-`) && DATED_SUFFIX.test(served.slice(requested.length + 1)));
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

async function apiKey($) {
  const direct = await $.env.get("TYPESAFE_API_KEY");
  if (direct) return direct;
  const file = await $.env.get("JAO_ENV_FILE") || `${$.plugin.root}/../.env`;
  try {
    return keyFromEnvFile(await $.fs.read(file));
  } catch {
    return "";
  }
}

async function routeTurn($, text) {
  const prompt = text.trim();
  if (prompt.length < 12) return { reason: "short or empty prompt" };
  if (SENSITIVE_PATTERN.test(prompt)) return { reason: "sensitive prompt" };

  const key = await apiKey($);
  if (!key) return { reason: "TypeSafe key unavailable" };

  const endpoint = await $.env.get("JAO_TYPESAFE_ENDPOINT") || ENDPOINT;
  const request = {
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
    if (response === timeout) return { reason: "Jev timeout" };
    if (!response.ok) return { reason: `Jev HTTP ${response.status}` };
    const choice = choiceFromJev(JSON.parse(response.text));
    if (!choice) return { reason: "Jev answer invalid" };
    if (choice.confidence < CONFIDENCE_FLOOR) {
      return { tier: choice.tier, confidence: choice.confidence, effort: choice.effort,
        reason: "Jev tier confidence below 0.8" };
    }
    const model = choice.tier === "fast"
      ? await $.env.get("JAO_CLAUDE_FAST_MODEL") || MODELS.fast
      : choice.tier === "balanced"
        ? await $.env.get("JAO_CLAUDE_BALANCED_MODEL") || MODELS.balanced
        : await $.env.get("JAO_CLAUDE_STRONG_MODEL") || MODELS.strong;
    return { ...choice, model, reason: "Jev choice" };
  } catch {
    return { reason: "Jev request failed" };
  }
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

export function register(on) {
  const routes = new Map();
  let enabled = false;
  let footerEnabled = true;
  let last = null;

  on("session.start", async ($, e, next) => {
    enabled = (await $.env.get("JAO_CLAUDE_AUTO")) === "1";
    footerEnabled = (await $.env.get("JAO_RESPONSE_FOOTER")) !== "0";
    await $.command.register({ name: "jao-route", description: "Show the last Jev route and API model" });
    return next(e);
  });

  on("command.run", { command: "jao-route" }, () => ({ text: statusOf(enabled, last) }));

  on("turn.start", async ($, e, next) => {
    if (enabled) {
      let route;
      try {
        route = await routeTurn($, e.text);
      } catch {
        route = { reason: "router error" };
      }
      routes.set(e.turnId, route);
      last = route;
      while (routes.size > MAX_CACHED_TURNS) routes.delete(routes.keys().next().value);
    }
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    const route = e.agentId === undefined ? routes.get(e.turnId) : undefined;
    const request = route?.model || route?.effort
      ? { ...e, ...(route.model ? { model: route.model } : {}), ...(route.effort ? { effort: route.effort } : {}) } : e;
    if (route) route.requestedEffort = request.effort;
    for await (const chunk of next(request)) {
      if (route && footerEnabled && !route.announced && chunk.kind === "text" && chunk.text) {
        route.announced = true;
        const model = typeof request.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(request.model)
          ? request.model : "확인 불가";
        const effort = typeof request.effort === "string" && /^[a-z]+$/.test(request.effort) ? request.effort : "기본값";
        yield { ...chunk, text: `> ✳️ 선택 모델: ${model} · 요청 effort: ${effort}\n\n---\n\n${chunk.text}` };
        continue;
      }
      if (route && chunk.kind === "stop" && chunk.usage?.model) {
        route.servedModel = chunk.usage.model;
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
    const model = e.usage?.model;
    if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) ||
      typeof route.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(route.model) ||
      sameModel(model, route.model)) return result;
    const effort = route.requestedEffort;
    const label = typeof effort === "number" && Number.isFinite(effort) ? String(effort)
      : typeof effort === "string" && /^[a-z]+$/.test(effort) ? effort : "기본값";
    // turn.complete displays a synopsis beneath the answer without rewriting its transcript.
    const footer = `모델: ${model} · 요청 effort: ${label} · 요청 모델: ${route.model} ≠`;
    return { ...result, text: result.text && result.text !== e.answer ? `${result.text}\n\n${footer}` : footer };
  });
}
