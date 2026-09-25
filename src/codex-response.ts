const MAX_OBSERVATION_BYTES = 4 * 1024 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type ObservedResponse = {
  servedModel: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function completedResponse(value: unknown): ObservedResponse | null {
  if (!isRecord(value) || typeof value.model !== "string" || !MODEL_ID.test(value.model)) return null;
  const usage = isRecord(value.usage) ? value.usage : {};
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  return {
    servedModel: value.model,
    inputTokens: tokenCount(usage.input_tokens),
    cachedInputTokens: tokenCount(details.cached_tokens),
    outputTokens: tokenCount(usage.output_tokens),
  };
}

function frameBoundary(buffer: Buffer): { index: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (lf >= 0 && (crlf < 0 || lf < crlf)) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

// Reads only completion metadata. The upstream bytes are forwarded separately and unchanged.
export class CodexResponseObserver {
  private buffer = Buffer.alloc(0);
  private disabled = false;
  private completed: ObservedResponse | null = null;
  private format: "sse" | "json" | "unknown" | "unsupported";

  constructor(contentType: string | undefined, contentEncoding: string | undefined) {
    this.format = contentEncoding && contentEncoding.toLowerCase() !== "identity" ? "unsupported"
      : contentType?.toLowerCase().includes("text/event-stream") ? "sse"
      : contentType?.toLowerCase().includes("application/json") ? "json"
      : contentType ? "unsupported" : "unknown";
  }

  push(chunk: Buffer): void {
    if (this.disabled || this.format === "unsupported") return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.detectFormat();
    if (this.format === "sse") {
      for (let boundary = frameBoundary(this.buffer); boundary; boundary = frameBoundary(this.buffer)) {
        const frame = this.buffer.subarray(0, boundary.index);
        this.buffer = this.buffer.subarray(boundary.index + boundary.length);
        if (frame.length > MAX_OBSERVATION_BYTES) { this.disable(); return; }
        this.readFrame(frame);
      }
    }
    if (this.buffer.length > MAX_OBSERVATION_BYTES) this.disable();
  }

  finish(): ObservedResponse | null {
    if (this.disabled || this.format === "unsupported") return null;
    this.detectFormat();
    if (this.format === "json") {
      try {
        const body: unknown = JSON.parse(this.buffer.toString("utf8"));
        return isRecord(body) && body.status === "completed" ? completedResponse(body) : null;
      } catch { return null; }
    }
    if (this.buffer.length) this.readFrame(this.buffer);
    return this.completed;
  }

  completedEvent(): ObservedResponse | null {
    return this.completed;
  }

  private detectFormat(): void {
    if (this.format !== "unknown") return;
    const start = this.buffer.subarray(0, 64).toString("utf8").trimStart();
    if (start.startsWith("event:") || start.startsWith("data:") || start.startsWith(":")) this.format = "sse";
    else if (start.startsWith("{")) this.format = "json";
    else if (this.buffer.length >= 64) this.disable();
  }

  private disable(): void {
    this.disabled = true;
    this.buffer = Buffer.alloc(0);
    this.completed = null;
  }

  private readFrame(frame: Buffer): void {
    const lines = frame.toString("utf8").split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    if (event && event !== "response.completed") return;
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || (!event && !data.includes('"response.completed"'))) return;
    try {
      const payload: unknown = JSON.parse(data);
      if (!isRecord(payload) || payload.type !== "response.completed") return;
      this.completed = completedResponse(payload.response);
    } catch { /* Malformed metadata must not interrupt the response stream. */ }
  }
}
