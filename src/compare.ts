import { readFileSync, statSync } from "node:fs";

export type RunResult = {
  completed: boolean;
  qualityScore: number;
  elapsedMs: number;
  billedUsd: number | null;
  manualCorrections: number;
};

export type PairedCase = { id: string; fixed: RunResult; auto: RunResult };
export type ComparisonInput = { schemaVersion: 1; fixedPolicy: string; autoPolicy: string; cases: PairedCase[] };

type ArmSummary = {
  completed: number;
  completionRate: number;
  meanQualityScore: number;
  totalElapsedMs: number;
  p50ElapsedMs: number;
  p95ElapsedMs: number;
  totalBilledUsd: number | null;
  totalManualCorrections: number;
};

export type ComparisonSummary = {
  kind: "paired-observed-runs";
  cases: number;
  fixedPolicy: string;
  autoPolicy: string;
  fixed: ArmSummary;
  auto: ArmSummary;
  paired: {
    autoFaster: number;
    autoCheaper: number | null;
    autoLowerQuality: number;
    autoFailedWhenFixedCompleted: number;
  };
  elapsedChangePercent: number | null;
  billedCostChangePercent: number | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function runResult(value: unknown): value is RunResult {
  if (!record(value) || !exactKeys(value, ["completed", "qualityScore", "elapsedMs", "billedUsd", "manualCorrections"])) return false;
  return typeof value.completed === "boolean" && Number.isInteger(value.qualityScore) &&
    (value.qualityScore as number) >= 0 && (value.qualityScore as number) <= 5 &&
    Number.isSafeInteger(value.elapsedMs) && (value.elapsedMs as number) >= 0 &&
    (value.billedUsd === null || nonnegativeNumber(value.billedUsd)) && Number.isSafeInteger(value.manualCorrections) &&
    (value.manualCorrections as number) >= 0;
}

export function parseComparisonInput(value: unknown): ComparisonInput {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "fixedPolicy", "autoPolicy", "cases"]) ||
    value.schemaVersion !== 1 || typeof value.fixedPolicy !== "string" || !value.fixedPolicy.trim() ||
    typeof value.autoPolicy !== "string" || !value.autoPolicy.trim() ||
    !Array.isArray(value.cases) || !value.cases.length || value.cases.length > 1000) {
    throw new Error("invalid comparison input");
  }
  const ids = new Set<string>();
  for (const item of value.cases) {
    if (!record(item) || !exactKeys(item, ["id", "fixed", "auto"]) ||
      typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id) ||
      !runResult(item.fixed) || !runResult(item.auto)) {
      const unfilled = record(item) && [item.fixed, item.auto].some((run) => record(run) &&
        (run.qualityScore === null || run.manualCorrections === null));
      throw new Error(unfilled && typeof item.id === "string"
        ? `comparison case ${item.id}: fill in qualityScore (0-5) and manualCorrections for both runs`
        : "invalid comparison case");
    }
    ids.add(item.id);
  }
  return value as ComparisonInput;
}

export function readComparisonInput(path: string): ComparisonInput {
  if (statSync(path).size > 1024 * 1024) throw new Error("comparison file too large");
  return parseComparisonInput(JSON.parse(readFileSync(path, "utf8")));
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

function summarizeArm(runs: RunResult[]): ArmSummary {
  const sum = (field: "elapsedMs" | "manualCorrections") => runs.reduce((total, run) => total + run[field], 0);
  return {
    completed: runs.filter((run) => run.completed).length,
    completionRate: runs.filter((run) => run.completed).length / runs.length,
    meanQualityScore: runs.reduce((total, run) => total + run.qualityScore, 0) / runs.length,
    totalElapsedMs: sum("elapsedMs"),
    p50ElapsedMs: percentile(runs.map((run) => run.elapsedMs), 0.5),
    p95ElapsedMs: percentile(runs.map((run) => run.elapsedMs), 0.95),
    totalBilledUsd: runs.every((run) => run.billedUsd !== null)
      ? runs.reduce((total, run) => total + run.billedUsd!, 0) : null,
    totalManualCorrections: sum("manualCorrections"),
  };
}

export function compareRuns(input: ComparisonInput): ComparisonSummary {
  const valid = parseComparisonInput(input);
  const fixed = summarizeArm(valid.cases.map((item) => item.fixed));
  const auto = summarizeArm(valid.cases.map((item) => item.auto));
  const change = (current: number | null, baseline: number | null) => current !== null && baseline !== null && baseline > 0
    ? (current - baseline) / baseline * 100 : null;
  return {
    kind: "paired-observed-runs", cases: valid.cases.length,
    fixedPolicy: valid.fixedPolicy, autoPolicy: valid.autoPolicy, fixed, auto,
    paired: {
      autoFaster: valid.cases.filter((item) => item.auto.elapsedMs < item.fixed.elapsedMs).length,
      autoCheaper: valid.cases.every((item) => item.auto.billedUsd !== null && item.fixed.billedUsd !== null)
        ? valid.cases.filter((item) => item.auto.billedUsd! < item.fixed.billedUsd!).length : null,
      autoLowerQuality: valid.cases.filter((item) => item.auto.qualityScore < item.fixed.qualityScore).length,
      autoFailedWhenFixedCompleted: valid.cases.filter((item) => item.fixed.completed && !item.auto.completed).length,
    },
    elapsedChangePercent: change(auto.totalElapsedMs, fixed.totalElapsedMs),
    billedCostChangePercent: change(auto.totalBilledUsd, fixed.totalBilledUsd),
  };
}
