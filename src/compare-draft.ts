import { readFileSync, statSync } from "node:fs";
import { priceFor, usageUsd, type PriceTable } from "./pricing.js";
import type { MetricsEvent } from "./types.js";

export type DraftRun = {
  completed: boolean;
  qualityScore: null;
  elapsedMs: number;
  billedUsd: number | null;
  manualCorrections: null;
};
export type ComparisonDraft = {
  schemaVersion: 1;
  fixedPolicy: string;
  autoPolicy: string;
  cases: { id: string; fixed: DraftRun; auto: DraftRun }[];
};

type Task = { startedAt?: number; endedAt?: number; responses: number; usd: number | null };

// Tasks in the order they started, from one policy's metrics log.
export function tasksFromMetrics(text: string, prices?: PriceTable): Task[] {
  const tasks = new Map<string, Task>();
  for (const line of text.split("\n")) {
    let event: MetricsEvent;
    try { event = JSON.parse(line) as MetricsEvent; } catch { continue; }
    if (!event || typeof event !== "object" || typeof event.taskId !== "string") continue;
    const task = tasks.get(event.taskId) ?? { responses: 0, usd: prices ? 0 : null };
    tasks.set(event.taskId, task);
    const at = Date.parse(event.at);
    if (!("kind" in event)) {
      if (Number.isFinite(at)) task.startedAt = Math.min(task.startedAt ?? at, at);
      continue;
    }
    task.responses += 1;
    if (Number.isFinite(at)) task.endedAt = Math.max(task.endedAt ?? at, at);
    const rate = prices ? priceFor(prices, event.servedModel) : undefined;
    task.usd = rate && task.usd !== null ? task.usd + usageUsd(rate, event) : null;
  }
  return [...tasks.values()].filter((task) => task.startedAt !== undefined)
    .sort((a, b) => a.startedAt! - b.startedAt!);
}

function draftRun(task: Task): DraftRun {
  return { completed: task.responses > 0, qualityScore: null,
    elapsedMs: task.endedAt !== undefined ? Math.max(0, Math.round(task.endedAt - task.startedAt!)) : 0,
    billedUsd: task.usd === null ? null : Number(task.usd.toFixed(6)), manualCorrections: null };
}

// Pairs the n-th task of each log. Both runs must have worked through the same task list
// in the same order; quality and corrections are left for a blind reviewer to fill in.
export function draftComparison(fixedText: string, autoText: string, fixedPolicy: string, autoPolicy: string,
  prices?: PriceTable): ComparisonDraft {
  const fixed = tasksFromMetrics(fixedText, prices);
  const auto = tasksFromMetrics(autoText, prices);
  if (!fixed.length || !auto.length) throw new Error("both metrics files need at least one task");
  if (fixed.length !== auto.length) throw new Error(`task counts differ: fixed ${fixed.length}, auto ${auto.length}`);
  return { schemaVersion: 1, fixedPolicy, autoPolicy,
    cases: fixed.map((task, index) => ({ id: `task-${index + 1}`, fixed: draftRun(task), auto: draftRun(auto[index]!) })) };
}

export function readMetricsText(path: string): string {
  if (statSync(path).size > 64 * 1024 * 1024) throw new Error("metrics file too large");
  return readFileSync(path, "utf8");
}
