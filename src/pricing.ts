import { readFileSync, statSync } from "node:fs";
import { sameModel } from "./response-footer.js";

export type ModelPrice = { inputUsdPerMillion: number; cachedInputUsdPerMillion: number; outputUsdPerMillion: number };
// Prices are supplied by the user; this project does not ship or guess list prices.
export type PriceTable = { schemaVersion: 1; referenceModel?: string; models: Record<string, ModelPrice> };
export type TokenUsage = { servedModel: string; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };

export type AgentCost = {
  estimatedUsd: number;
  pricedResponses: number;
  unpricedResponses: number;
  byModel: Record<string, { responses: number; usd: number | null }>;
  referenceModel: string | null;
  // The same observed tokens priced at the reference model. Another model would not
  // have produced the same tokens, so this is an estimate, not a measured saving.
  referenceUsd: number | null;
  estimatedSavingsUsd: number | null;
  estimatedSavingsPercent: number | null;
};

function price(value: unknown): value is ModelPrice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ["inputUsdPerMillion", "cachedInputUsdPerMillion", "outputUsdPerMillion"]
    .every((key) => typeof record[key] === "number" && Number.isFinite(record[key]) && (record[key] as number) >= 0);
}

export function parsePriceTable(value: unknown): PriceTable {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid price table");
  const record = value as Record<string, unknown>;
  const models = record.models as Record<string, unknown> | undefined;
  if (record.schemaVersion !== 1 || !models || typeof models !== "object" || Array.isArray(models) ||
    !Object.keys(models).length || !Object.values(models).every(price)) throw new Error("invalid price table");
  if (record.referenceModel !== undefined &&
    (typeof record.referenceModel !== "string" || !Object.hasOwn(models, record.referenceModel))) {
    throw new Error("price table referenceModel must be one of its models");
  }
  return value as PriceTable;
}

export function readPriceTable(path: string): PriceTable {
  if (statSync(path).size > 256 * 1024) throw new Error("price table too large");
  return parsePriceTable(JSON.parse(readFileSync(path, "utf8")));
}

export function priceFor(table: PriceTable, model: string): ModelPrice | undefined {
  return table.models[model] ?? Object.entries(table.models).find(([id]) => sameModel(model, id))?.[1];
}

export function usageUsd(rate: ModelPrice, usage: TokenUsage): number {
  const input = usage.inputTokens ?? 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  return ((input - cached) * rate.inputUsdPerMillion + cached * rate.cachedInputUsdPerMillion +
    (usage.outputTokens ?? 0) * rate.outputUsdPerMillion) / 1_000_000;
}

export function agentCost(table: PriceTable, responses: TokenUsage[]): AgentCost {
  const byModel: AgentCost["byModel"] = {};
  const reference = table.referenceModel ? table.models[table.referenceModel] : undefined;
  let estimatedUsd = 0, referenceUsd = 0, priced = 0;
  for (const response of responses) {
    const rate = priceFor(table, response.servedModel);
    const entry = byModel[response.servedModel] ??= { responses: 0, usd: rate ? 0 : null };
    entry.responses += 1;
    if (!rate) continue;
    const usd = usageUsd(rate, response);
    entry.usd! += usd;
    estimatedUsd += usd;
    if (reference) referenceUsd += usageUsd(reference, response);
    priced += 1;
  }
  const comparable = reference && priced ? referenceUsd : null;
  return { estimatedUsd, pricedResponses: priced, unpricedResponses: responses.length - priced, byModel,
    referenceModel: table.referenceModel ?? null, referenceUsd: comparable,
    estimatedSavingsUsd: comparable === null ? null : comparable - estimatedUsd,
    estimatedSavingsPercent: comparable ? (comparable - estimatedUsd) / comparable * 100 : null };
}
