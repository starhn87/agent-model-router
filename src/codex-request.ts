import { createHash } from "node:crypto";

export type CodexBody = Record<string, unknown>;
export type UserTurn = { prompt: string; hasNonText: boolean };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function latestUserTurn(body: CodexBody): UserTurn | null {
  if (!Array.isArray(body.input)) return null;
  const items = body.input as unknown[];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = asRecord(items[index]);
    if (!item || item.type === "additional_tools") continue;
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") return null;
    if (item.role !== "user") return null;

    const content = item.content;
    const parts = Array.isArray(content) ? content : [content];
    const text: string[] = [];
    let hasNonText = false;
    for (const part of parts) {
      if (typeof part === "string") { text.push(part); continue; }
      const element = asRecord(part);
      if (!element) continue;
      if (element.type === "text" || element.type === "input_text") {
        if (typeof element.text === "string") text.push(element.text);
      } else {
        hasNonText = true;
      }
    }
    const prompt = text.join("\n").trim();
    if (!prompt || /^Generate a concise, single-line task title\b/i.test(prompt)) return null;
    return { prompt, hasNonText };
  }
  return null;
}

export function codexSessionKey(body: CodexBody): string | undefined {
  const metadata = asRecord(body.client_metadata);
  const stable = [metadata?.thread_id, metadata?.session_id, metadata?.root_turn_id, metadata?.turn_id]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  if (!stable) return undefined;
  return createHash("sha256").update(stable).digest("hex").slice(0, 20);
}

export function estimateContextTokens(body: CodexBody): number {
  if (!Array.isArray(body.input)) return Math.ceil(JSON.stringify(body.input ?? "").length / 4);
  const dynamicItems = body.input.filter((item) => {
    const record = asRecord(item);
    return !record || (record.type !== "additional_tools" && record.role !== "developer" && record.role !== "system");
  });
  return Math.ceil(JSON.stringify(dynamicItems).length / 4);
}
