import { Transform, type TransformCallback } from "node:stream";

const LIMIT = 4 * 1024 * 1024;
type RecordValue = Record<string, any>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const safeModel = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
function lastIndex(items: unknown[], predicate: (value: unknown) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (predicate(items[index])) return index;
  return -1;
}

export function responseFooter(model: unknown, effort?: string): string {
  return `\n\n— 모델: ${safeModel(model) ? model : "확인 불가"} · 요청 effort: ${effort && /^[a-z]+$/.test(effort) ? effort : "기본값"}`;
}

function target(response: RecordValue): { item: RecordValue; part: RecordValue; outputIndex: number; contentIndex: number } | null {
  if (response.status !== "completed" || !Array.isArray(response.output)) return null;
  // Tool requests and commentary are intermediate steps, even when the API response completed.
  if (response.output.some((item: unknown) => record(item) && /(?:call|call_output)$/.test(item.type ?? ""))) return null;
  const outputIndex = lastIndex(response.output, (item: unknown) => record(item) && item.type === "message" &&
    item.role === "assistant" && (item.phase === undefined || item.phase === "final_answer"));
  const item = response.output[outputIndex];
  if (!record(item) || !Array.isArray(item.content)) return null;
  const contentIndex = lastIndex(item.content, (part: unknown) => record(part) && part.type === "output_text" && typeof part.text === "string" && part.text.length > 0);
  return contentIndex < 0 ? null : { item, part: item.content[contentIndex], outputIndex, contentIndex };
}

function parseFrame(raw: Buffer): RecordValue | null {
  const data = raw.toString("utf8").split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart()).join("\n");
  try { const value: unknown = JSON.parse(data); return record(value) ? value : null; } catch { return null; }
}

/** Stream text immediately; hold terminal events until the actual serving model is known. */
export class ResponseFooter extends Transform {
  private buffer = Buffer.alloc(0);
  private pending: Buffer[] = [];
  private pendingSize = 0;
  private bypass = false;
  private sequenceOffset = 0;
  private hasToolCall = false;
  private format: "sse" | "json" | "unknown";

  constructor(contentType?: string, private readonly effort?: string) {
    super();
    this.format = contentType?.includes("application/json") ? "json" : contentType?.includes("text/event-stream") ? "sse" : "unknown";
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.bypass) { this.push(chunk); callback(); return; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.format === "unknown") {
      const start = this.buffer.subarray(0, 64).toString("utf8").trimStart();
      if (/^(event:|data:|:)/.test(start)) this.format = "sse";
      else if (start.startsWith("{")) this.format = "json";
    }
    if (this.format === "sse") {
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(this.buffer.toString("utf8"));
        if (!boundary) break;
        const bytes = Buffer.byteLength(this.buffer.toString("utf8").slice(0, boundary.index)) + boundary[0].length;
        const frame = this.buffer.subarray(0, bytes);
        this.buffer = this.buffer.subarray(bytes);
        this.frame(frame);
      }
    }
    if (this.buffer.length + this.pendingSize > LIMIT) this.flushUnchanged();
    callback();
  }

  private emitEvent(event: RecordValue): void {
    if (typeof event.sequence_number === "number") event.sequence_number += this.sequenceOffset;
    this.push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private frame(raw: Buffer): void {
    if (this.bypass) { this.push(raw); return; }
    const event = parseFrame(raw);
    if (record(event?.item) && /(?:call|call_output)$/.test(event.item.type ?? "")) this.hasToolCall = true;
    if (event?.type === "response.completed") {
      const response = event.response;
      let selected = record(response) && !this.hasToolCall ? target(response) : null;
      if (!selected && record(response) && !this.hasToolCall &&
        (response.output === undefined || (Array.isArray(response.output) && response.output.length === 0))) {
        // The ChatGPT Codex backend sends final items in output_item.done and an
        // empty output array in response.completed. Keep the original wire index:
        // reasoning items may already have passed through before text.done.
        const items = this.pending.map(parseFrame).filter((part): part is RecordValue =>
          part?.type === "response.output_item.done" && record(part.item) &&
          Number.isSafeInteger(part.output_index) && part.output_index >= 0);
        selected = target({ ...response, output: items.map((part) => part.item) });
        if (selected) selected.outputIndex = items[selected.outputIndex]!.output_index;
      }
      const done = selected && this.pending.find((frame) => {
        const part = parseFrame(frame);
        return part?.type === "response.output_text.done" && part.output_index === selected.outputIndex && part.content_index === selected.contentIndex;
      });
      if (selected && done) {
        const suffix = responseFooter(response.model, this.effort);
        for (const frame of this.pending) {
          const part = parseFrame(frame);
          if (!part) { this.push(frame); continue; }
          const matches = part.output_index === selected.outputIndex;
          if (matches && part.type === "response.output_text.done" && part.content_index === selected.contentIndex) {
            this.emitEvent({ type: "response.output_text.delta", item_id: selected.item.id, output_index: selected.outputIndex,
              content_index: selected.contentIndex, delta: suffix, ...(typeof part.sequence_number === "number" ? { sequence_number: part.sequence_number } : {}) });
            this.sequenceOffset += 1;
            part.text += suffix;
          } else if (matches && part.type === "response.content_part.done" && part.content_index === selected.contentIndex && record(part.part)) {
            part.part.text += suffix;
          } else if (matches && part.type === "response.output_item.done" && record(part.item) && Array.isArray(part.item.content)) {
            const text = part.item.content[selected.contentIndex];
            if (record(text) && typeof text.text === "string") text.text += suffix;
          }
          this.emitEvent(part);
        }
        selected.part.text += suffix;
        this.emitEvent(event);
      } else {
        for (const frame of this.pending) this.push(frame);
        this.push(raw);
      }
      this.pending = []; this.pendingSize = 0;
      // Only one completed response per stream; preserve any transport trailers.
      this.bypass = true;
      return;
    }
    if (this.pending.length || event?.type === "response.output_text.done") {
      this.pending.push(raw); this.pendingSize += raw.length;
      if (this.pendingSize > LIMIT) this.flushUnchanged();
    } else this.push(raw);
  }

  private flushUnchanged(): void {
    for (const frame of this.pending) this.push(frame);
    this.push(this.buffer);
    this.pending = []; this.pendingSize = 0; this.buffer = Buffer.alloc(0); this.bypass = true;
  }

  override _flush(callback: TransformCallback): void {
    if (!this.bypass && this.format === "json") {
      try {
        const response = JSON.parse(this.buffer.toString("utf8"));
        const selected = record(response) ? target(response) : null;
        if (selected) {
          selected.part.text += responseFooter(response.model, this.effort);
          this.buffer = Buffer.from(JSON.stringify(response));
        }
      } catch { /* Unknown responses are forwarded unchanged. */ }
    }
    this.flushUnchanged(); callback();
  }
}

export function allowsResponseFooter(body: RecordValue): boolean {
  const format = body.text?.format?.type ?? body.response_format?.type;
  if (format && format !== "text") return false;
  const last = Array.isArray(body.input) ? body.input.at(-1) : null;
  const content = typeof last?.content === "string" ? last.content : Array.isArray(last?.content)
    ? last.content.map((part: RecordValue) => part?.text ?? "").join("\n") : "";
  return !/^Generate a concise, single-line task title\b/i.test(content.trim());
}
