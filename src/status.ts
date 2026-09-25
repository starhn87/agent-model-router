import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const MAX_TAIL_BYTES = 512 * 1024;
const MAX_ENTRIES = 20;

export type StatusEntry = {
  at: string;
  result?: string;
  tier?: string;
  confidence?: number;
  requestedModel?: string;
  requestedEffort?: string;
  recommendedEffort?: string;
  servedModel?: string;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 128 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function recentStatusFromMetrics(content: string): StatusEntry[] {
  const entries = new Map<string, StatusEntry>();
  for (const line of content.split("\n")) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event)) continue;
    const id = text(event.requestId);
    if (!id) continue;
    const previous = entries.get(id) ?? { at: "" };
    const at = text(event.at) ?? previous.at;
    let entry: StatusEntry;
    if (event.kind === "response") {
      const servedModel = text(event.servedModel);
      if (!servedModel) continue;
      entry = { ...previous, at, servedModel,
        requestedModel: text(event.requestedModel) ?? previous.requestedModel,
        requestedEffort: text(event.requestedEffort) ?? previous.requestedEffort };
    } else {
      const result = text(event.result);
      if (!result) continue;
      entry = { ...previous, at, result, tier: text(event.recommendedTier),
        confidence: typeof event.confidence === "number" && Number.isFinite(event.confidence) ? event.confidence : undefined,
        requestedModel: text(event.model) ?? previous.requestedModel,
        requestedEffort: text(event.effort) ?? previous.requestedEffort,
        recommendedEffort: text(event.recommendedEffort) ?? previous.recommendedEffort };
    }
    entries.delete(id);
    entries.set(id, entry);
    if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value ?? "");
  }
  return [...entries.values()].reverse();
}

export function readRecentStatus(path: string): StatusEntry[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (!count) break;
      read += count;
    }
    let content = buffer.subarray(0, read).toString("utf8");
    if (start > 0) {
      const boundary = content.indexOf("\n");
      content = boundary < 0 ? "" : content.slice(boundary + 1);
    }
    return recentStatusFromMetrics(content);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function display(value: string | undefined, fallback = "—"): string {
  return escapeHtml(value ?? fallback);
}

function displayTime(value: string): string {
  const date = new Date(value);
  return display(Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "medium" }));
}

export function renderStatusPage(entries: StatusEntry[], hasMetricsFile: boolean): string {
  const latest = entries[0];
  const modelLabel = (entry: StatusEntry) => `${display(entry.servedModel, "응답 확인 대기")}${entry.servedModel && entry.requestedModel &&
    entry.servedModel !== entry.requestedModel && !entry.servedModel.startsWith(`${entry.requestedModel}-`)
    ? ` <span title="요청 모델: ${display(entry.requestedModel)}">≠</span>` : ""}`;
  const rows = entries.map((entry) => `<tr><td>${displayTime(entry.at)}</td><td>${modelLabel(entry)}</td>` +
    `<td>${display(entry.recommendedEffort)}</td><td>${display(entry.requestedEffort)}</td><td>${display(entry.tier ?? entry.result)}</td></tr>`).join("");
  const empty = hasMetricsFile ? "아직 관찰한 요청이 없습니다. 라우터 설정을 적용한 새 Codex 작업에서 메시지를 보내세요."
    : "상태 기록을 보려면 라우터를 --metrics FILE 옵션으로 시작하세요.";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="refresh" content="3"><title>Jev Auto 상태</title><style>` +
    `:root{font:15px system-ui,sans-serif;color-scheme:light dark}body{max-width:860px;margin:24px auto;padding:0 18px}` +
    `h1{font-size:1.5rem}p{line-height:1.5}.card{border:1px solid #8886;border-radius:12px;padding:18px;margin:18px 0}` +
    `.value{font-size:1.5rem;font-weight:700}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}` +
    `small,.muted{opacity:.72}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #8885}` +
    `@media(max-width:600px){.grid{grid-template-columns:1fr}table{font-size:.8rem}}` +
    `</style></head><body><h1>Jev Auto</h1><p class="muted">이 화면은 로컬 라우터를 거친 자동 라우팅 요청만 표시합니다. ` +
    `Codex에 Jev Auto가 표시되는 것만으로 이 작업의 연결을 확인할 수는 없습니다. 3초마다 갱신합니다.</p>` +
    `<p class="muted">화면 갱신: ${displayTime(new Date().toISOString())} · 마지막 라우터 기록: ${latest ? displayTime(latest.at) : "없음"}</p>` +
    `<p>새 메시지를 보냈는데 마지막 기록 시각이 바뀌지 않나요? 설정 변경 전에 만든 작업은 기존 공급자 연결을 유지할 수 있습니다. ` +
    `라우터 설정을 적용한 뒤 <strong>새 Codex 작업</strong>에서 Jev Auto를 선택하세요. 기존 작업의 모델만 바꿔도 연결은 바뀌지 않습니다.</p>` +
    (latest ? `<div class="card"><div class="grid"><div><small>실제 응답 모델</small><div class="value">${modelLabel(latest)}</div></div>` +
      `<div><small>요청 effort</small><div class="value">${display(latest.requestedEffort)}</div></div></div>` +
      `<p>요청 모델: <strong>${display(latest.requestedModel)}</strong> · Jev 등급: <strong>${display(latest.tier)}</strong>` +
      ` · Jev 추천 effort: <strong>${display(latest.recommendedEffort)}</strong>` +
      `${latest.confidence === undefined ? "" : ` · 신뢰도: <strong>${latest.confidence}</strong>`}</p></div>` : `<div class="card">${empty}</div>`) +
    (rows ? `<h2>최근 요청</h2><table><thead><tr><th>시각</th><th>실제 응답 모델</th><th>Jev 추천 effort</th><th>요청 effort</th><th>라우팅</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>` : "") + `</body></html>`;
}
