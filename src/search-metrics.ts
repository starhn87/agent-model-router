import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SearchDecision } from "./search-gate.js";

export type SearchMetric = {
  at: string;
  kind: "search";
  status: SearchDecision["status"];
  decision: SearchDecision["decision"];
  reason?: SearchDecision["reason"];
  resultCount: number;
  selectedCount: number;
  flaggedCount: number;
  jevCalls: number;
  jevInputTokens: number;
  latencyMs: number;
};

export function writeSearchMetric(file: string, resultCount: number, decision: SearchDecision): void {
  const event: SearchMetric = { at: new Date().toISOString(), kind: "search", status: decision.status,
    decision: decision.decision, ...(decision.reason ? { reason: decision.reason } : {}), resultCount,
    selectedCount: decision.selectedIds.length, flaggedCount: decision.flaggedIds.length, jevCalls: decision.jevCalls,
    jevInputTokens: decision.jevInputTokens, latencyMs: decision.latencyMs };
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.ceil(values.length * fraction) - 1] ?? null;
}

export function summarizeSearchMetrics(text: string) {
  const events = text.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || (value as SearchMetric).kind !== "search") return [];
      const event = value as SearchMetric;
      if (!Number.isSafeInteger(event.resultCount) || !Number.isSafeInteger(event.selectedCount) ||
        !Number.isSafeInteger(event.jevCalls) || !Number.isSafeInteger(event.jevInputTokens) ||
        !Number.isFinite(event.latencyMs)) return [];
      return [event];
    } catch { return []; }
  });
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.decision] = (counts[event.decision] ?? 0) + 1;
  return {
    rounds: events.length,
    byDecision: counts,
    fullyJudged: events.filter((event) => event.status === "ok").length,
    partial: events.filter((event) => event.status === "partial").length,
    unknown: events.filter((event) => event.status === "unknown").length,
    resultsSeen: events.reduce((sum, event) => sum + event.resultCount, 0),
    resultsSelected: events.reduce((sum, event) => sum + event.selectedCount, 0),
    locallyFlagged: events.reduce((sum, event) => sum + (event.flaggedCount ?? 0), 0),
    jevCalls: events.reduce((sum, event) => sum + event.jevCalls, 0),
    jevInputTokens: events.reduce((sum, event) => sum + event.jevInputTokens, 0),
    p50LatencyMs: percentile(events.map((event) => event.latencyMs), 0.5),
    p95LatencyMs: percentile(events.map((event) => event.latencyMs), 0.95),
  };
}

export function readSearchMetrics(file: string) { return summarizeSearchMetrics(readFileSync(file, "utf8")); }
