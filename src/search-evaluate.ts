import { readFileSync, statSync } from "node:fs";

export type SearchEvaluationCase = {
  id: string;
  resultIds: string[];
  neededIds: string[];
  selectedIds: string[];
};

export function readSearchEvaluation(file: string): SearchEvaluationCase[] {
  if (statSync(file).size > 1024 * 1024) throw new Error("search evaluation file too large");
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new Error("invalid search evaluation");
  const caseIds = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid search evaluation case");
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).sort().join() !== "id,neededIds,resultIds,selectedIds" ||
      typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(entry.id) || caseIds.has(entry.id)) {
      throw new Error("invalid search evaluation case");
    }
    caseIds.add(entry.id);
    for (const field of ["resultIds", "neededIds", "selectedIds"] as const) {
      const ids = entry[field];
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) ||
        new Set(ids).size !== ids.length) throw new Error("invalid search evaluation case");
    }
    const results = new Set(entry.resultIds as string[]);
    if (!results.size || !(entry.neededIds as string[]).every((id) => results.has(id)) ||
      !(entry.selectedIds as string[]).every((id) => results.has(id))) throw new Error("invalid search evaluation case");
  }
  return value as SearchEvaluationCase[];
}

export function evaluateSearchSelections(cases: SearchEvaluationCase[]) {
  if (!cases.length) throw new Error("search evaluation cases required");
  let needed = 0;
  let baselineFound = 0;
  let selectedFound = 0;
  let baselineComplete = 0;
  let selectedComplete = 0;
  let regressed = 0;
  let improved = 0;
  let selectedCount = 0;
  let baselineCount = 0;
  for (const item of cases) {
    const baseline = new Set(item.resultIds.slice(0, 5));
    const selected = new Set(item.selectedIds);
    const baseFound = item.neededIds.filter((id) => baseline.has(id)).length;
    const gateFound = item.neededIds.filter((id) => selected.has(id)).length;
    needed += item.neededIds.length;
    baselineFound += baseFound;
    selectedFound += gateFound;
    baselineComplete += Number(baseFound === item.neededIds.length);
    selectedComplete += Number(gateFound === item.neededIds.length);
    regressed += Number(gateFound < baseFound);
    improved += Number(gateFound > baseFound);
    selectedCount += item.selectedIds.length;
    baselineCount += baseline.size;
  }
  return { cases: cases.length, neededSources: needed,
    baselineNeededRecall: needed ? baselineFound / needed : null,
    selectedNeededRecall: needed ? selectedFound / needed : null,
    baselineCompleteCases: baselineComplete, selectedCompleteCases: selectedComplete,
    regressedCases: regressed, improvedCases: improved,
    baselineReadCount: baselineCount, selectedReadCount: selectedCount };
}
