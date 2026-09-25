import type { JevOptions } from "./jev.js";

export type SearchResult = { id: string; title: string; url?: string; snippet: string };
export type SearchInput = { question: string; results: SearchResult[]; candidateQueries?: string[] };
export type SearchDecision = {
  status: "ok" | "partial" | "unknown";
  decision: "answer" | "search_more" | "propose_queries" | "unknown";
  selectedIds: string[];
  flaggedIds: string[];
  nextQuery?: string;
  sufficiency: number | null;
  jevCalls: number;
  jevInputTokens: number;
  latencyMs: number;
  reason?: "small-result-set" | "sensitive-input" | "too-many-results" | "jev-unavailable" | "jev-invalid";
};

type JevReply = { answers?: Record<string, unknown>; usage?: { input_tokens?: unknown } };
export type SearchAsk = (state: Record<string, unknown>, questions: Record<string, unknown>) => Promise<JevReply>;

const MAX_RESULTS = 20;
const TOP_K = 5;
const MAX_BYTES = 64 * 1024;
const SENSITIVE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|bearer|password|secret)\s*[:=]\s*\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+?\d[\d ()-]{8,}\d|\b[a-f0-9]{32,}\b|\.env\b)/i;
const INJECTION = /(?:ignore (?:all )?(?:previous|prior) instructions|reveal (?:your|the) (?:system|developer) prompt|send .* (?:api key|password)|execute (?:this|the) command|이전 (?:모든 )?지시(?:를|사항을) 무시)/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseSearchInput(value: unknown): SearchInput {
  if (!record(value) || typeof value.question !== "string" || !value.question.trim() || value.question.length > 1500 ||
    !Array.isArray(value.results) || !value.results.length || value.results.length > 100 ||
    (value.candidateQueries !== undefined && (!Array.isArray(value.candidateQueries) || value.candidateQueries.length > 5 ||
      value.candidateQueries.some((query) => typeof query !== "string" || !query.trim() || query.length > 300)))) {
    throw new Error("invalid search input");
  }
  const ids = new Set<string>();
  for (const item of value.results) {
    if (!record(item) || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id) ||
      typeof item.title !== "string" || typeof item.snippet !== "string" ||
      item.title.length > 300 || item.snippet.length > 3000 ||
      (item.url !== undefined && (typeof item.url !== "string" || item.url.length > 2000))) {
      throw new Error("invalid search result");
    }
    ids.add(item.id);
  }
  return value as SearchInput;
}

export async function askSearchJev(state: Record<string, unknown>, questions: Record<string, unknown>, options: JevOptions = {}): Promise<JevReply> {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
  if (!apiKey) throw new Error("jev-key-missing");
  const response = await (options.fetchImpl ?? fetch)(options.endpoint ?? "https://api.typesafe.ai/v1/systemone", {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "jev-latest", state, questions }), signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
  });
  if (!response.ok) throw new Error("jev-unavailable");
  const reply: unknown = await response.json();
  if (!record(reply) || !record(reply.answers)) throw new Error("jev-invalid");
  return reply as JevReply;
}

function usage(reply: JevReply): number {
  const value = reply.usage?.input_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validScore(value: unknown): number | null {
  if (!record(value) || value.type !== "score" || typeof value.score !== "number" ||
    !Number.isFinite(value.score) || value.score < 0 || value.score > 4) return null;
  return value.score;
}

function validNoul(value: unknown): number | null {
  if (!record(value) || value.type !== "noul" || typeof value.noul !== "number" ||
    !Number.isFinite(value.noul) || value.noul < 0 || value.noul > 1) return null;
  return value.noul;
}

export async function searchGate(raw: SearchInput, ask: SearchAsk = askSearchJev): Promise<SearchDecision> {
  const input = parseSearchInput(raw);
  const started = Date.now();
  const flaggedIds = input.results.filter((item) => INJECTION.test(`${item.title}\n${item.snippet}`)).map((item) => item.id);
  const candidates = input.results.filter((item) => !flaggedIds.includes(item.id));
  const head = candidates.slice(0, TOP_K).map((item) => item.id);
  const base = (reason: SearchDecision["reason"]): SearchDecision => ({ status: "unknown", decision: "unknown",
    selectedIds: head, flaggedIds, sufficiency: null, jevCalls: 0, jevInputTokens: 0, latencyMs: Date.now() - started, reason });
  if (candidates.length <= TOP_K) return base("small-result-set");
  if (input.results.length > MAX_RESULTS) return base("too-many-results");
  const pieces = [input.question, ...(input.candidateQueries ?? []), ...candidates.flatMap((item) => [item.title, item.snippet, item.url ?? ""])];
  if (pieces.some((value) => SENSITIVE.test(value))) return base("sensitive-input");

  // Only snippets and titles reach Jev. Local IDs, full URLs, query strings and source paths stay here.
  const passages = candidates.map((item, index) => ({ key: `p${index}`, text: `${item.title}\n${item.snippet}`.slice(0, 900) }));
  const state = { question: input.question, passages: Object.fromEntries(passages.map((item) => [item.key, item.text])) };
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES) return base("too-many-results");
  const scores: number[] = [];
  let first: JevReply;
  try {
    first = await ask(state, Object.fromEntries(passages.map((item) => [item.key, {
      type: "score", instructions: "How relevant is this search result to answering the question?",
      criteria: ["Irrelevant", "Weak lead", "Possibly useful", "Relevant evidence", "Essential evidence"],
    }])));
    for (const item of passages) {
      const score = validScore(first.answers?.[item.key]);
      if (score === null) throw new Error("jev-invalid");
      scores.push(score);
    }
  } catch (error) {
    const missingKey = error instanceof Error && /^(?:jev-key-missing|TypeSafe Keychain item unavailable)$/.test(error.message);
    return { ...base(error instanceof Error && error.message === "jev-invalid" ? "jev-invalid" : "jev-unavailable"),
      latencyMs: Date.now() - started, jevCalls: missingKey ? 0 : 1 };
  }
  const ranked = scores.map((score, index) => ({ score, index })).filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, TOP_K);
  const selectedIds = ranked.map((item) => candidates[item.index]!.id);
  const selectedPassages = Object.fromEntries(ranked.map((item) => [`p${item.index}`, passages[item.index]!.text]));
  const candidateQueries = input.candidateQueries ?? [];
  const questions: Record<string, unknown> = {};
  if (ranked.length) questions.enough = { type: "noul", instructions:
    "Taken together, do these search snippets identify enough evidence to answer the question after reading the selected sources? If a fact or source is still missing, answer no." };
  if (candidateQueries.length) questions.next = { type: "choice", instructions:
    "If more evidence is needed, which proposed query is most likely to find it? Choose none if none would help.",
    criteria: Object.fromEntries([...candidateQueries.map((query, index) => [`q${index}`, query]), ["none", "None would help"]]) };
  if (!Object.keys(questions).length) return { status: "ok", decision: "propose_queries", selectedIds, flaggedIds,
    sufficiency: 0, jevCalls: 1, jevInputTokens: usage(first), latencyMs: Date.now() - started };
  try {
    const second = await ask({ question: input.question, passages: selectedPassages }, questions);
    const sufficiency = ranked.length ? validNoul(second.answers?.enough) : 0;
    if (sufficiency === null) throw new Error("jev-invalid");
    let nextQuery: string | undefined;
    if (candidateQueries.length) {
      const answer = second.answers?.next;
      if (!record(answer) || answer.type !== "choice" || typeof answer.choice !== "string" ||
        ![...candidateQueries.map((_, index) => `q${index}`), "none"].includes(answer.choice)) throw new Error("jev-invalid");
      if (answer.choice !== "none") nextQuery = candidateQueries[Number(answer.choice.slice(1))];
    }
    return { status: "ok", decision: sufficiency >= 0.5 ? "answer" : nextQuery ? "search_more" : "propose_queries",
      selectedIds, flaggedIds, ...(sufficiency < 0.5 && nextQuery ? { nextQuery } : {}), sufficiency,
      jevCalls: 2, jevInputTokens: usage(first) + usage(second), latencyMs: Date.now() - started };
  } catch (error) {
    return { status: "partial", decision: "unknown", selectedIds, flaggedIds, sufficiency: null, jevCalls: 2,
      jevInputTokens: usage(first), latencyMs: Date.now() - started,
      reason: error instanceof Error && error.message === "jev-invalid" ? "jev-invalid" : "jev-unavailable" };
  }
}
