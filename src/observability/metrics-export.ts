import path from "node:path";
import { createSpanId } from "../core/ids.js";
import { writeJsonFileAtomic } from "../core/fs.js";
import { overlayPresentFields } from "../config/merge.js";
import type { WorkbenchDiagnostic } from "../core/diagnostics.js";
import type { ObservationSink, RunRecord } from "../core/types.js";
import type { TraceStore } from "../core/trace-store.js";
import type { WorkbenchConfig } from "../config/workbench-config.js";

export type MetricsExportMode = "off" | "onShutdown";
export type MetricsExportOptions = { file?: string; mode: MetricsExportMode; template: boolean; diagnostics: WorkbenchDiagnostic[] };
export type MetricsExportReport = {
  schemaVersion: 1;
  exportedAt: number;
  exportFile: string;
  run: {
    runId: string;
    traceId: string;
    status: string;
    startedAt: number;
    endedAt?: number;
    cwd: string;
    projectRoot?: string;
    storageRoot: string;
    traceFile: string;
    primaryModel?: string;
  };
  metrics: RunRecord["metrics"];
  warnings?: string[];
};

type Layer = { file?: unknown; mode?: unknown; template?: unknown; source: string };
type MetricsExportLayerOptions = { file?: string; mode: MetricsExportMode; template: boolean };
type ParsedLayer = { overlay: MetricsExportLayerOptions; raw: Record<string, unknown> };

const METRICS_EXPORT_OPTION_PATHS = [["file"], ["mode"], ["template"]];

export function resolveMetricsExportOptions(input: {
  config: WorkbenchConfig;
  env?: NodeJS.ProcessEnv;
  cli?: { file?: unknown; mode?: unknown; template?: unknown };
}): MetricsExportOptions {
  const diagnostics: WorkbenchDiagnostic[] = [];
  let effective: MetricsExportLayerOptions = {
    file: input.config.observability.metricsExportFile,
    mode: input.config.observability.metricsExportMode,
    template: input.config.observability.metricsExportTemplate,
  };

  const env = input.env ?? process.env;
  for (const layer of [
    { file: env.PI_WORKBENCH_METRICS_FILE, mode: env.PI_WORKBENCH_METRICS_EXPORT, template: env.PI_WORKBENCH_METRICS_TEMPLATE, source: "env" },
    { ...input.cli, source: "cli" },
  ] satisfies Layer[]) {
    const parsed = parseLayer(layer, diagnostics);
    effective = overlayPresentFields(effective, parsed.overlay, parsed.raw, METRICS_EXPORT_OPTION_PATHS);
  }
  if (effective.mode !== "off" && !effective.file) diagnostics.push({ severity: "warning", code: "metrics_export_file_required", message: "metrics export enabled without a file", fieldPath: "observability.metricsExportFile" });
  if (effective.mode !== "off" && effective.file?.includes("{runId}") && !effective.template) diagnostics.push({ severity: "warning", code: "metrics_export_template_disabled", message: "metrics export file contains {runId} but template mode is false", fieldPath: "observability.metricsExportTemplate" });
  return { ...effective, diagnostics };
}

function parseLayer(layer: Layer, diagnostics: WorkbenchDiagnostic[]): ParsedLayer {
  const overlay: MetricsExportLayerOptions = { mode: "off", template: false };
  const raw: Record<string, unknown> = {};
  if (layer.file !== undefined) {
    if (typeof layer.file === "string" && layer.file.trim()) {
      overlay.file = layer.file;
      raw.file = true;
    } else diagnostics.push({ severity: "warning", code: "metrics_export_file_invalid", message: `invalid ${layer.source} metrics export file`, fieldPath: "observability.metricsExportFile" });
  }
  if (layer.mode !== undefined) {
    if (layer.mode === "off" || layer.mode === "onShutdown") {
      overlay.mode = layer.mode;
      raw.mode = true;
    } else {
      diagnostics.push({ severity: "warning", code: "metrics_export_mode_invalid", message: `invalid ${layer.source} metrics export mode`, fieldPath: "observability.metricsExportMode" });
    }
  }
  if (raw.file && !raw.mode) {
    overlay.mode = "onShutdown";
    raw.mode = true;
  }
  if (layer.template !== undefined) {
    if (layer.template === true || layer.template === "true") {
      overlay.template = true;
      raw.template = true;
    } else if (layer.template === "false" || (layer.template === false && layer.source !== "cli")) {
      overlay.template = false;
      raw.template = true;
    } else if (layer.template !== false) diagnostics.push({ severity: "warning", code: "metrics_export_template_invalid", message: `invalid ${layer.source} metrics export template value`, fieldPath: "observability.metricsExportTemplate" });
  }
  return { overlay, raw };
}

export function resolveMetricsExportPath(input: { file: string; run: RunRecord; template: boolean }): { ok: true; file: string; warnings: string[] } | { ok: false; error: string; warnings: string[] } {
  const warnings: string[] = [];
  let configured = input.file;
  if (input.template) {
    const unmatched = (configured.includes("{") || configured.includes("}")) && !/^([^{}]|\{runId\})*$/.test(configured);
    if (unmatched) return { ok: false, error: "metrics export path contains an unsupported placeholder", warnings };
    configured = configured.replaceAll("{runId}", input.run.runId);
  } else if (configured.includes("{runId}")) {
    warnings.push("metrics export path contains literal {runId}; template mode is false");
  }
  const base = input.run.projectRoot ?? input.run.cwd;
  return { ok: true, file: path.resolve(base, configured), warnings };
}

export async function readFreshRun(store: TraceStore, run: RunRecord): Promise<RunRecord> {
  try { return (await store.readRun(run.runId)) ?? run; } catch { return run; }
}

export function buildMetricsExportReport(input: { run: RunRecord; exportFile: string; warnings?: string[]; now?: () => number }): MetricsExportReport {
  const run = input.run;
  const warnings = input.warnings?.filter(Boolean) ?? [];
  return {
    schemaVersion: 1,
    exportedAt: (input.now ?? Date.now)(),
    exportFile: path.resolve(input.exportFile),
    run: {
      runId: run.runId,
      traceId: run.traceId,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      cwd: path.resolve(run.cwd),
      projectRoot: run.projectRoot ? path.resolve(run.projectRoot) : undefined,
      storageRoot: path.resolve(run.storageRoot),
      traceFile: path.resolve(run.traceFile),
      primaryModel: run.primaryModel,
    },
    metrics: run.metrics,
    warnings: warnings.length ? warnings : undefined,
  };
}

export async function exportMetricsReport(input: { store: TraceStore; run: RunRecord; file: string; template: boolean; warnings?: string[]; now?: () => number }): Promise<{ file: string; report: MetricsExportReport }> {
  const fresh = await readFreshRun(input.store, input.run);
  const resolved = resolveMetricsExportPath({ file: input.file, run: fresh, template: input.template });
  if (!resolved.ok) throw new Error(resolved.error);
  const report = buildMetricsExportReport({ run: fresh, exportFile: resolved.file, warnings: [...(input.warnings ?? []), ...resolved.warnings], now: input.now });
  await writeJsonFileAtomic(resolved.file, report, { createParentDirs: true });
  return { file: resolved.file, report };
}

export async function emitMetricsExportError(input: { sink: ObservationSink; run: RunRecord; error: unknown; now?: () => number }): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await input.sink.emit({
    schemaVersion: 1,
    runId: input.run.runId,
    traceId: input.run.traceId,
    spanId: createSpanId(),
    source: "runtime",
    controlMode: input.run.controlMode,
    eventType: "error",
    timestamp: (input.now ?? Date.now)(),
    data: { phase: "metrics_export", message },
  });
}

export function formatExportStatusLine(input: { run: RunRecord; file: string; mode: MetricsExportMode; template: boolean; cwd: string }): string {
  const resolved = resolveMetricsExportPath({ file: input.file, run: input.run, template: input.template });
  const configuredDisplay = displayPath(input.cwd, input.file);
  if (!resolved.ok) return `export: metrics=${input.mode} file=${configuredDisplay} template=${input.template} warning=${resolved.error}`;
  const resolvedDisplay = displayPath(input.cwd, resolved.file);
  const extra = configuredDisplay === resolvedDisplay ? "" : ` resolved=${resolvedDisplay}`;
  return `export: metrics=${input.mode} file=${configuredDisplay}${extra} template=${input.template}`;
}

function displayPath(cwd: string, file: string): string {
  const absolute = path.resolve(cwd, file);
  const relative = path.relative(cwd, absolute);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}
