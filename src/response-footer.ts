import { Transform, type TransformCallback } from "node:stream";

const LIMIT = 4 * 1024 * 1024;
type RecordValue = Record<string, any>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const safeModel = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
// A dated snapshot (claude-…-20251001, gpt-…-2025-08-07) is the requested model; a longer version number (…-5 vs …-5-5) is not.
const DATED_SUFFIX = /^(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
export function sameModel(served: string, requested: string): boolean {
  return served === requested || (served.startsWith(`${requested}-`) && DATED_SUFFIX.test(served.slice(requested.length + 1)));
}
function lastIndex(items: unknown[], predicate: (value: unknown) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (predicate(items[index])) return index;
  return -1;
}

export function responseFooter(model: unknown, effort?: string, requestedModel?: string): string {
  if (!safeModel(model) || !safeModel(requestedModel) || sameModel(model, requestedModel)) return "";
  return `\n\n— 모델: ${model} · 요청 effort: ${effort && /^[a-z]+$/.test(effort) ? effort : "기본값"} · 요청 모델: ${requestedModel} ≠`;
}

export function responseRoute(model?: string, effort?: string): string {
  return safeModel(model)
    ? `> ✳️ 선택 모델: ${model} · 요청 effort: ${effort && /^[a-z]+$/.test(effort) ? effort : "기본값"}\n\n---\n\n`
    : "";
}

const ROUTE_START = /^> ✳️ 선택 모델: [A-Za-z0-9][A-Za-z0-9._:/-]{0,127} · 요청 effort: (?:[a-z]+|기본값)\r?\n\r?\n---\r?\n\r?\n/;
export function stripResponseRoute(text: string): string { return text.replace(ROUTE_START, ""); }

const FOOTER_START = "— 모델: ";
const FOOTER_BOUNDARY = `\n\n${FOOTER_START}`;
const FOOTER_END = /(?:^|\r?\n\r?\n)— 모델: (?:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}|확인 불가) · 요청 effort: (?:[a-z]+|기본값)(?: · 요청 모델: [A-Za-z0-9][A-Za-z0-9._:/-]{0,127} ≠)?[ \t]*(?:\r?\n)*$/;

export function stripResponseFooters(text: string): string {
  for (;;) {
    const stripped = text.replace(FOOTER_END, "");
    if (stripped === text) return text;
    text = stripped;
  }
}

// A displayed router footer is transport metadata, not an example for the model
// to imitate on its next turn. Only remove our exact trailer from assistant text.
export function withoutResponseFooters(body: RecordValue): RecordValue {
  if (!Array.isArray(body.input)) return body;
  return { ...body, input: body.input.map((item: unknown) => {
    if (!record(item) || item.role !== "assistant") return item;
    if (typeof item.content === "string") return { ...item, content: stripResponseFooters(stripResponseRoute(item.content)) };
    if (!Array.isArray(item.content)) return item;
    return { ...item, content: item.content.map((part: unknown, index: number) =>
      record(part) && ["text", "output_text"].includes(part.type) && typeof part.text === "string"
        ? { ...part, text: index === item.content.length - 1
          ? stripResponseFooters(stripResponseRoute(part.text)) : stripResponseRoute(part.text) } : part) };
  }) };
}

class FooterTail {
  text = "";
  private atStart = true;

  push(delta: string): string {
    const text = this.text + delta;
    const marker = this.atStart && text.startsWith(FOOTER_START) ? 0 : text.indexOf(FOOTER_BOUNDARY);
    let keep = marker >= 0 ? text.length - marker : 0;
    if (marker < 0) {
      for (let length = 1; length < FOOTER_BOUNDARY.length && length <= text.length; length++) {
        if (FOOTER_BOUNDARY.startsWith(text.slice(-length))) keep = length;
      }
      if (this.atStart && FOOTER_START.startsWith(text)) keep = text.length;
    }
    this.text = text.slice(text.length - keep);
    const visible = text.slice(0, text.length - keep);
    if (visible) this.atStart = false;
    return visible;
  }

  take(strip = false): string {
    const text = strip ? stripResponseFooters(this.text) : this.text;
    this.text = "";
    return text;
  }
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
  private lastSequence?: number;
  private hasToolCall = false;
  private tails = new Map<string, { tail: FooterTail; event: RecordValue }>();
  private commentary = new Set<number>();
  private finalItems = new Set<number>();
  private prefixed = new Set<string>();
  private announced = false;
  private format: "sse" | "json" | "unknown";

  constructor(contentType?: string, private readonly effort?: string, private readonly requestedModel?: string) {
    super();
    this.format = contentType?.includes("application/json") ? "json" : contentType?.includes("text/event-stream") ? "sse" : "unknown";
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.bypass && this.format !== "sse") { this.push(chunk); callback(); return; }
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
    const heldBytes = [...this.tails.values()].reduce((size, { tail }) => size + Buffer.byteLength(tail.text), 0);
    if (this.buffer.length + this.pendingSize + heldBytes > LIMIT) this.flushUnchanged();
    callback();
  }

  private emitEvent(event: RecordValue): void {
    if (typeof event.sequence_number === "number") event.sequence_number += this.sequenceOffset;
    if (typeof event.sequence_number === "number") this.lastSequence = event.sequence_number;
    this.push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private textKey(event: RecordValue): string { return `${event.output_index}:${event.content_index}`; }

  private decorateRoute(event: RecordValue): void {
    const route = responseRoute(this.requestedModel, this.effort);
    const text = (value: string, key: string) => this.prefixed.has(key) ? route + stripResponseRoute(value) : value;
    if (event.type === "response.output_text.done" && typeof event.text === "string")
      event.text = text(event.text, this.textKey(event));
    if (event.type === "response.content_part.done" && record(event.part) && typeof event.part.text === "string")
      event.part.text = text(event.part.text, this.textKey(event));
    if (event.type === "response.output_item.done" && record(event.item) && Array.isArray(event.item.content)) {
      for (let i = 0; i < event.item.content.length; i++) {
        const part = event.item.content[i];
        if (record(part) && typeof part.text === "string") part.text = text(part.text, `${event.output_index}:${i}`);
      }
    }
  }

  private decorateResponse(response: RecordValue): void {
    if (!Array.isArray(response.output)) return;
    const route = responseRoute(this.requestedModel, this.effort);
    for (let outputIndex = 0; outputIndex < response.output.length; outputIndex++) {
      const item = response.output[outputIndex];
      if (!record(item) || !Array.isArray(item.content)) continue;
      for (let contentIndex = 0; contentIndex < item.content.length; contentIndex++) {
        const part = item.content[contentIndex];
        if (record(part) && typeof part.text === "string" && this.prefixed.has(`${outputIndex}:${contentIndex}`))
          part.text = route + stripResponseRoute(part.text);
      }
    }
  }

  private emitFrame(raw: Buffer, event: RecordValue | null): void {
    if (event?.type === "response.output_text.delta" && typeof event.delta === "string" && !this.commentary.has(event.output_index)) {
      const key = this.textKey(event);
      const state = this.tails.get(key) ?? { tail: new FooterTail(), event };
      this.tails.set(key, state);
      const delta = state.tail.push(event.delta);
      const selectedRoute = responseRoute(this.requestedModel, this.effort);
      const alreadyPrefixed = Boolean(selectedRoute && delta.startsWith(selectedRoute));
      const route = delta && this.finalItems.has(event.output_index) && !this.announced && !alreadyPrefixed
        ? selectedRoute : "";
      if (alreadyPrefixed) { this.prefixed.add(key); this.announced = true; }
      if (route) { this.prefixed.add(key); this.announced = true; }
      if (route || delta !== event.delta) { this.emitEvent({ ...event, delta: route + delta }); return; }
    }
    if (this.sequenceOffset && event) this.emitEvent(event);
    else {
      if (typeof event?.sequence_number === "number") this.lastSequence = event.sequence_number;
      this.push(raw);
    }
  }

  private releaseText(event: RecordValue, suffix?: string): void {
    const key = this.textKey(event);
    const held = this.tails.get(key)?.tail.take(suffix !== undefined) ?? "";
    this.tails.delete(key);
    const route = suffix !== undefined && !this.announced ? responseRoute(this.requestedModel, this.effort) : "";
    if (route) { this.prefixed.add(key); this.announced = true; }
    const delta = route + held + (suffix ?? "");
    if (!delta) return;
    this.emitEvent({ type: "response.output_text.delta", item_id: event.item_id, output_index: event.output_index,
      content_index: event.content_index, delta, ...(typeof event.sequence_number === "number" ? { sequence_number: event.sequence_number } : {}) });
    this.sequenceOffset += 1;
  }

  private frame(raw: Buffer): void {
    const event = parseFrame(raw);
    if (this.bypass) {
      if (this.sequenceOffset && event) this.emitEvent(event); else this.push(raw);
      return;
    }
    if (record(event?.item) && event.item.phase === "commentary") this.commentary.add(event.output_index);
    if (event?.type === "response.output_item.added" && record(event.item) &&
      event.item.type === "message" && event.item.role === "assistant" &&
      (event.item.phase === undefined || event.item.phase === "final_answer")) this.finalItems.add(event.output_index);
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
        return part?.type === "response.output_text.done" && typeof part.text === "string" &&
          part.output_index === selected.outputIndex && part.content_index === selected.contentIndex;
      });
      if (selected && done) {
        const suffix = responseFooter(response.model, this.effort, this.requestedModel);
        const selectedKey = `${selected.outputIndex}:${selected.contentIndex}`;
        for (const frame of this.pending) {
          const part = parseFrame(frame);
          if (!part) { this.push(frame); continue; }
          const matches = part.output_index === selected.outputIndex;
          if (matches && part.type === "response.output_text.done" && part.content_index === selected.contentIndex && typeof part.text === "string") {
            this.releaseText(part, suffix);
            this.decorateRoute(part);
            part.text = stripResponseFooters(part.text) + suffix;
          } else if (matches && part.type === "response.content_part.done" && part.content_index === selected.contentIndex &&
            record(part.part) && typeof part.part.text === "string") {
            this.decorateRoute(part);
            part.part.text = stripResponseFooters(part.part.text) + suffix;
          } else if (matches && part.type === "response.output_item.done" && record(part.item) && Array.isArray(part.item.content)) {
            this.decorateRoute(part);
            const text = part.item.content[selected.contentIndex];
            if (record(text) && typeof text.text === "string") text.text = stripResponseFooters(text.text) + suffix;
          } else if (part.type === "response.output_text.done") {
            this.releaseText(part);
            this.decorateRoute(part);
          } else if (part.type === "response.output_text.delta") {
            this.emitFrame(frame, part);
            continue;
          } else this.decorateRoute(part);
          this.emitEvent(part);
        }
        this.decorateResponse(response);
        if (!this.prefixed.has(selectedKey)) selected.part.text = stripResponseRoute(selected.part.text);
        selected.part.text = stripResponseFooters(selected.part.text) + suffix;
        this.emitEvent(event);
      } else {
        this.drainPending();
        if (record(response) && this.prefixed.size) { this.decorateResponse(response); this.emitEvent(event); }
        else this.emitFrame(raw, event);
      }
      this.pending = []; this.pendingSize = 0;
      // Only one completed response per stream; preserve any transport trailers.
      this.bypass = true;
      return;
    }
    if (this.pending.length || event?.type === "response.output_text.done") {
      this.pending.push(raw); this.pendingSize += raw.length;
    } else if (event?.type === "error" || event?.type === "response.failed" || event?.type === "response.incomplete") {
      this.releaseAll();
      if (event?.type === "response.incomplete" && record(event.response) && this.prefixed.size) {
        this.decorateResponse(event.response); this.emitEvent(event);
      } else this.emitFrame(raw, event);
    } else this.emitFrame(raw, event);
  }

  private drainPending(): void {
    for (const frame of this.pending) {
      const event = parseFrame(frame);
      if (event?.type === "response.output_text.done") this.releaseText(event);
      if (event && this.prefixed.size && ["response.output_text.done", "response.content_part.done", "response.output_item.done"].includes(event.type)) {
        this.decorateRoute(event);
        this.emitEvent(event);
      } else if (event?.type === "response.incomplete" && record(event.response) && this.prefixed.size) {
        this.decorateResponse(event.response);
        this.emitEvent(event);
      } else this.emitFrame(frame, event);
    }
    this.pending = []; this.pendingSize = 0;
  }

  private releaseAll(): void {
    for (const { tail, event } of this.tails.values()) {
      const delta = tail.take();
      if (delta) {
        this.emitEvent({ ...event, sequence_number: this.lastSequence === undefined ? undefined : this.lastSequence + 1 - this.sequenceOffset, delta });
        this.sequenceOffset += 1;
      }
    }
    this.tails.clear();
  }

  private flushUnchanged(ending = false): void {
    this.drainPending();
    this.releaseAll();
    if (ending || this.format !== "sse" || this.buffer.length > LIMIT) {
      this.push(this.buffer); this.buffer = Buffer.alloc(0);
    }
    this.pending = []; this.pendingSize = 0; this.bypass = true;
  }

  override _flush(callback: TransformCallback): void {
    if (!this.bypass && this.format === "json") {
      try {
        const response = JSON.parse(this.buffer.toString("utf8"));
        const selected = record(response) ? target(response) : null;
        if (selected) {
          const first = selected.item.content.find((part: unknown) => record(part) && part.type === "output_text" && typeof part.text === "string" && part.text.length > 0);
          if (record(first) && typeof first.text === "string")
            first.text = responseRoute(this.requestedModel, this.effort) + stripResponseRoute(first.text);
          selected.part.text = stripResponseFooters(selected.part.text) + responseFooter(response.model, this.effort, this.requestedModel);
          this.buffer = Buffer.from(JSON.stringify(response));
        }
      } catch { /* Unknown responses are forwarded unchanged. */ }
    }
    this.flushUnchanged(true); callback();
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
