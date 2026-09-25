import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { MemoryDecision } from "./memory-filter.js";

type MemoryMetric = { at: string; kind: "memory"; status: MemoryDecision["status"];
  candidateCount: number; selectedCount: number; flaggedCount: number; unjudgedCount: number; clippedCount: number;
  jevCalls: number; jevInputTokens: number; latencyMs: number; reason?: MemoryDecision["reason"] };

export function writeMemoryMetric(file: string, candidateCount: number, decision: MemoryDecision): void {
  const event: MemoryMetric = { at: new Date().toISOString(), kind: "memory", status: decision.status,
    candidateCount, selectedCount: decision.selectedIds.length, flaggedCount: decision.flaggedIds.length,
    unjudgedCount: decision.unjudgedIds.length, clippedCount: decision.clippedIds.length,
    jevCalls: decision.jevCalls, jevInputTokens: decision.jevInputTokens, latencyMs: decision.latencyMs,
    ...(decision.reason ? { reason: decision.reason } : {}) };
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.ceil(values.length * fraction) - 1] ?? null;
}

export function summarizeMemoryMetrics(text: string) {
  const events = text.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || (value as MemoryMetric).kind !== "memory") return [];
      const event = value as MemoryMetric;
      if (![event.candidateCount, event.selectedCount, event.flaggedCount, event.unjudgedCount,
        event.clippedCount, event.jevCalls, event.jevInputTokens].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        !Number.isFinite(event.latencyMs) || event.latencyMs < 0) return [];
      return [event];
    } catch { return []; }
  });
  return { rounds: events.length, fullyJudged: events.filter((event) => event.status === "ok").length,
    unknown: events.filter((event) => event.status === "unknown").length,
    candidatesSeen: events.reduce((sum, event) => sum + event.candidateCount, 0),
    candidatesSelected: events.reduce((sum, event) => sum + event.selectedCount, 0),
    locallyOrJevFlagged: events.reduce((sum, event) => sum + event.flaggedCount, 0),
    unjudged: events.reduce((sum, event) => sum + event.unjudgedCount, 0),
    clipped: events.reduce((sum, event) => sum + event.clippedCount, 0),
    jevCalls: events.reduce((sum, event) => sum + event.jevCalls, 0),
    jevInputTokens: events.reduce((sum, event) => sum + event.jevInputTokens, 0),
    p50LatencyMs: percentile(events.map((event) => event.latencyMs), 0.5),
    p95LatencyMs: percentile(events.map((event) => event.latencyMs), 0.95) };
}

export function readMemoryMetrics(file: string) { return summarizeMemoryMetrics(readFileSync(file, "utf8")); }
