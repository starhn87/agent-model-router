import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { askJev } from "./jev.js";
import { codexSessionKey, estimateContextTokens, latestUserTurn, type CodexBody } from "./codex-request.js";
import { CodexResponseObserver, type ObservedResponse } from "./codex-response.js";
import { AUTO_MODEL, chooseModel, fallbackModel, routingGuard } from "./policy.js";
import type { DecisionEvent, ResponseObservationEvent, RouteChoice, RouteQuery, RouteResult, RouterSettings } from "./types.js";

const CHATGPT_CODEX_URL = "https://chatgpt.com/backend-api/codex";
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

export type ProxyOptions = {
  settings: RouterSettings;
  port?: number;
  upstreamBaseUrl?: string;
  classify?: (query: RouteQuery) => Promise<RouteChoice>;
  onDecision?: (event: DecisionEvent) => void;
  onObservation?: (event: ResponseObservationEvent) => void;
};

type CatalogModel = {
  slug: string;
  supported_in_api?: boolean;
  default_reasoning_level?: string;
  supported_reasoning_levels?: { effort: string }[];
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class CodexRouter {
  private readonly sessions = new Map<string, string>();
  private readonly catalog = new Map<string, CatalogModel>();
  private readonly classify: (query: RouteQuery) => Promise<RouteChoice>;
  private metricsWarningShown = false;

  constructor(private readonly options: ProxyOptions) {
    this.classify = options.classify ?? ((query) => askJev(query));
  }

  private report(event: Omit<DecisionEvent, "at" | "mode" | "client">, requestId?: string): void {
    try {
      this.options.onDecision?.({ at: new Date().toISOString(), client: "codex", mode: this.options.settings.mode, ...event, requestId });
    } catch { this.warnMetricsFailure(); }
  }

  recordObservation(requestId: string, requestedModel: string, observed: ObservedResponse): void {
    try {
      this.options.onObservation?.({ at: new Date().toISOString(), client: "codex", kind: "response",
        requestId, requestedModel, ...observed });
    } catch { this.warnMetricsFailure(); }
  }

  private warnMetricsFailure(): void {
    if (this.metricsWarningShown) return;
    this.metricsWarningShown = true;
    process.stderr.write("[amr] metrics sink unavailable\n");
  }

  private remember(key: string, model: string): void {
    this.sessions.delete(key);
    this.sessions.set(key, model);
    if (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value ?? "");
  }

  private allowedModels(): Set<string> | undefined {
    return this.catalog.size ? new Set(this.catalog.keys()) : undefined;
  }

  ingestCatalog(payload: unknown): unknown {
    if (!isRecord(payload) || !Array.isArray(payload.models)) return payload;
    const models = payload.models.filter(isRecord) as CatalogModel[];
    this.catalog.clear();
    for (const model of models) {
      if (typeof model.slug === "string" && model.supported_in_api !== false) this.catalog.set(model.slug, model);
    }
    if (models.some((model) => model.slug === AUTO_MODEL)) return payload;
    const template = models.find((model) => model.slug === this.options.settings.baselineModel) ?? models[0];
    if (!template) return payload;
    const autoModel: CatalogModel = {
      ...template,
      slug: AUTO_MODEL,
      display_name: "Agent Auto",
      description: "Selects a model per user turn when routing is enabled.",
      visibility: "list",
      supported_in_api: true,
      priority: 0,
    };
    return { ...payload, models: [autoModel, ...models] };
  }

  private adjustReasoning(body: CodexBody, model: string): void {
    if (!isRecord(body.reasoning) || typeof body.reasoning.effort !== "string") return;
    const metadata = this.catalog.get(model);
    const levels = metadata?.supported_reasoning_levels?.map((item) => item.effort);
    if (levels?.length && !levels.includes(body.reasoning.effort)) {
      body.reasoning = { ...body.reasoning, effort: metadata?.default_reasoning_level ?? levels[0] };
    }
  }

  async route(body: CodexBody, requestId?: string): Promise<CodexBody> {
    if (body.model !== AUTO_MODEL) return body; // Explicit model choices remain untouched.

    const { settings } = this.options;
    const key = codexSessionKey(body);
    const currentModel = (key ? this.sessions.get(key) : undefined) ?? settings.baselineModel;
    const turn = latestUserTurn(body);
    let result: RouteResult = { model: currentModel, reason: "tool-continuation" };

    if (turn) {
      const query: RouteQuery = { prompt: turn.prompt, currentModel, contextTokens: estimateContextTokens(body) };
      const guard = turn.hasNonText ? "multimodal-turn" : routingGuard(query, settings);
      if (settings.mode === "pass") {
        result = { model: settings.baselineModel, reason: "pass-mode" };
      } else if (settings.mode === "force") {
        const requested = settings.forceModel ?? settings.baselineModel;
        result = this.allowedModels()?.size && !this.catalog.has(requested)
          ? { model: currentModel, reason: "forced-model-unavailable" }
          : { model: requested, reason: "forced-model" };
      } else if (guard) {
        result = { model: guard === "short-follow-up" ? currentModel : fallbackModel(currentModel, settings), reason: guard };
      } else if (settings.mode === "shadow") {
        const started = Date.now();
        void this.classify(query).then((choice) => {
          const recommendation = chooseModel(query, choice, settings, this.allowedModels());
          this.report({ result: "shadow", model: currentModel, recommendedTier: recommendation.tier,
            confidence: recommendation.confidence, latencyMs: Date.now() - started, jevInputTokens: choice.inputTokens, reason: recommendation.reason }, requestId);
        }).catch(() => {
          this.report({ result: "error", model: currentModel, latencyMs: Date.now() - started, reason: "jev-unavailable" }, requestId);
        });
        result = { model: currentModel, reason: "shadow-mode" };
      } else {
        const started = Date.now();
        try {
          const choice = await this.classify(query);
          result = chooseModel(query, choice, settings, this.allowedModels());
          this.report({ result: result.model === currentModel ? "kept" : "routed", model: result.model,
            recommendedTier: result.tier, confidence: result.confidence, latencyMs: Date.now() - started,
            jevInputTokens: choice.inputTokens, reason: result.reason }, requestId);
        } catch {
          result = { model: fallbackModel(currentModel, settings), reason: "jev-unavailable" };
          this.report({ result: "error", model: result.model, latencyMs: Date.now() - started, reason: result.reason }, requestId);
        }
      }
      if (key) this.remember(key, result.model);
      if (settings.mode === "pass" || settings.mode === "force" || guard) {
        this.report({ result: result.model === currentModel ? "kept" : "routed", model: result.model, reason: result.reason }, requestId);
      }
    }

    const routed = { ...body, model: result.model };
    if (result.model !== body.model) this.adjustReasoning(routed, result.model);
    return routed;
  }
}

function withoutHopHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const output = { ...headers };
  const connectionHeaders = (headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase());
  for (const name of [...connectionHeaders, "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) {
    delete output[name];
  }
  return output;
}

async function readRequest(request: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += part.length;
    if (length > MAX_REQUEST_BYTES) throw new Error("request-too-large");
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function respondError(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  // A partial SSE response must fail at the client, not appear successfully completed.
  if (response.headersSent) return void response.destroy();
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { type: "agent_router_error", message } }));
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, router: CodexRouter, upstreamBaseUrl: string): Promise<void> {
  const rawPath = request.url ?? "/";
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) return respondError(response, 400, "invalid path");
  if (request.method === "GET" && rawPath === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
    return;
  }

  const isResponse = request.method === "POST" && /^\/(?:v1\/)?responses(?:\?|$)/.test(rawPath);
  const isCatalog = request.method === "GET" && /^\/(?:v1\/)?models(?:\?|$)/.test(rawPath);
  let body: Buffer;
  let requestedModel: string | undefined;
  let requestId: string | undefined;
  try {
    body = await readRequest(request);
  } catch {
    return respondError(response, 413, "request too large");
  }
  if (isResponse) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      if (!isRecord(parsed)) throw new Error("body is not object");
      if (parsed.model === AUTO_MODEL) requestId = randomUUID();
      const routed = await router.route(parsed, requestId);
      if (requestId && typeof routed.model === "string") requestedModel = routed.model;
      body = Buffer.from(JSON.stringify(routed));
    } catch {
      return respondError(response, 400, "invalid response request");
    }
  }
  // Routing may have been waiting for Jev when the client disconnected or the server stopped.
  if (response.destroyed) return;

  const base = new URL(upstreamBaseUrl);
  const targetPath = `${base.pathname.replace(/\/$/, "")}${rawPath}`;
  const headers = withoutHopHeaders(request.headers);
  headers.host = base.host;
  delete headers["content-length"];
  if (isCatalog) delete headers["accept-encoding"];
  const transport = base.protocol === "http:" ? http : https;
  const upstream = transport.request({ protocol: base.protocol, hostname: base.hostname, port: base.port || undefined,
    path: targetPath, method: request.method, headers }, (upstreamResponse) => {
    upstreamResponse.on("error", () => respondError(response, 502, "upstream unavailable"));
    const responseHeaders = withoutHopHeaders(upstreamResponse.headers);
    if (!isCatalog) {
      const status = upstreamResponse.statusCode ?? 502;
      if (isResponse && requestId && requestedModel && status >= 200 && status < 300) {
        const contentType = upstreamResponse.headers["content-type"];
        const contentEncoding = upstreamResponse.headers["content-encoding"];
        const observer = new CodexResponseObserver(
          Array.isArray(contentType) ? contentType[0] : contentType,
          Array.isArray(contentEncoding) ? contentEncoding[0] : contentEncoding,
        );
        let recorded = false;
        const record = (observed: ObservedResponse | null): void => {
          if (!observed || recorded) return;
          recorded = true;
          router.recordObservation(requestId!, requestedModel!, observed);
        };
        upstreamResponse.on("data", (chunk: Buffer) => {
          observer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          record(observer.completedEvent());
        });
        upstreamResponse.on("end", () => record(observer.finish()));
        // Codex may close the SSE connection after a completion event without waiting for EOF.
        upstreamResponse.on("close", () => record(observer.finish()));
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    upstreamResponse.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_CATALOG_BYTES) chunks.push(chunk);
    });
    upstreamResponse.on("end", () => {
      if (size > MAX_CATALOG_BYTES) return respondError(response, 502, "model catalog too large");
      let output = Buffer.concat(chunks);
      if ((upstreamResponse.statusCode ?? 500) < 300) {
        try { output = Buffer.from(JSON.stringify(router.ingestCatalog(JSON.parse(output.toString("utf8"))))); }
        catch { /* An unrecognized catalog is returned unchanged. */ }
      }
      delete responseHeaders["content-length"];
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      response.end(output);
    });
  });
  upstream.on("error", () => respondError(response, 502, "upstream unavailable"));
  response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
  upstream.end(body);
}

export async function startCodexProxy(options: ProxyOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new CodexRouter(options);
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, router, options.upstreamBaseUrl ?? CHATGPT_CODEX_URL).catch(() => {
      respondError(response, 502, "proxy unavailable");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  let closing: Promise<void> | undefined;
  return {
    port: (server.address() as AddressInfo).port,
    close: () => closing ??= new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      // Explicit shutdown also cancels active streams; otherwise server.close can wait indefinitely.
      server.closeAllConnections();
    }),
  };
}
