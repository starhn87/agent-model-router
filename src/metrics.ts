import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { MetricsEvent } from "./types.js";

export function writeMetric(event: MetricsEvent, file?: string): void {
  const line = `${JSON.stringify(event)}\n`;
  if (!file) return void process.stderr.write(`[amr] ${line}`);
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line, { mode: 0o600 });
}
