import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerParentObserver } from "../observability/parent-observer.js";
import { emitMetricsExportError, exportMetricsReport, formatExportStatusLine, resolveMetricsExportOptions } from "../observability/metrics-export.js";
import { relativeToCwd, WorkbenchRuntime, isWorkbenchRuntimeLink } from "../runtime/workbench-runtime.js";
import { loadWorkbenchConfig } from "../config/workbench-config.js";
import { loadAgentCatalog } from "../subagents/agent-catalog.js";
import type { WorkbenchRuntimeLink } from "../runtime/workbench-runtime.js";
import type { RunRecord, RunMetrics } from "../core/types.js";
import type { WorkbenchDiagnostic } from "../core/diagnostics.js";
import type { WorkbenchConfigLoadResult } from "../config/workbench-config.js";
import type { AgentCatalog } from "../subagents/agent-catalog.js";

const LINK_TYPE = "workbench-runtime";

export type WorkbenchServices = {
  configLoadResult?: WorkbenchConfigLoadResult;
  agentCatalog?: AgentCatalog;
  startupDiagnostics: WorkbenchDiagnostic[];
  metricsExport?: ReturnType<typeof resolveMetricsExportOptions>;
};

export type WorkbenchExtensionOptions = {
  loadConfig?: typeof loadWorkbenchConfig;
  loadCatalog?: typeof loadAgentCatalog;
  homeDir?: string;
};

export default function workbenchExtension(pi: ExtensionAPI): void {
  createWorkbenchExtension()(pi);
}

export function createWorkbenchExtension(options: WorkbenchExtensionOptions = {}): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => registerWorkbench(pi, options);
}

function registerWorkbench(pi: ExtensionAPI, options: WorkbenchExtensionOptions): void {
  const runtime = new WorkbenchRuntime({ cwd: process.cwd() });
  const services: WorkbenchServices = { startupDiagnostics: [] };
  registerMetricsFlags(pi);

  pi.on("session_start", async (event, ctx) => {
    try {
      await runtime.start({
        reason: typeof event.reason === "string" ? event.reason : undefined,
        sessionId: safeCall(() => ctx.sessionManager.getSessionId()),
        sessionFile: safeCall(() => ctx.sessionManager.getSessionFile()),
        displayName: safeCall(() => ctx.sessionManager.getSessionName()),
        primaryModel: ctx.model?.id,
        existingLinks: extractLinks(ctx),
        appendLink: (link) => pi.appendEntry(LINK_TYPE, link),
      });
      await loadStartupServices(services, ctx, options, pi);
    } catch (error) {
      runtime.markTraceWriteFailed(error);
      ctx.ui.notify(`workbench failed to initialize; observability disabled: ${shortMessage(error)}`, "warning");
    }
  });

  registerParentObserver(pi, runtime);

  pi.registerCommand("observe", {
    description: "Show workbench observability status (use /observe status)",
    handler: async (args, ctx) => {
      const parsed = parseObserveArgs(args);
      if (parsed.kind === "status") {
        await showStatus(runtime, services, ctx);
        return;
      }
      if (parsed.kind === "dump") {
        await dumpMetrics(runtime, parsed.file, parsed.template, ctx);
        return;
      }
      ctx.ui.notify("usage: /observe status | /observe dump [--template] <file>", "info");
    },
  });

  pi.on("session_shutdown", async (event, _ctx) => {
    try {
      await runtime.detach({ reason: typeof event.reason === "string" ? event.reason : undefined });
      await exportOnShutdown(runtime, services);
    } catch (error) {
      runtime.markTraceWriteFailed(error);
    }
  });
}

async function loadStartupServices(services: WorkbenchServices, ctx: ExtensionContext, options: WorkbenchExtensionOptions, pi: ExtensionAPI): Promise<void> {
  services.startupDiagnostics = [];
  services.configLoadResult = undefined;
  services.agentCatalog = undefined;
  try {
    const configLoadResult = await (options.loadConfig ?? loadWorkbenchConfig)({ cwd: ctx.cwd, homeDir: options.homeDir });
    const agentCatalog = await (options.loadCatalog ?? loadAgentCatalog)({ cwd: ctx.cwd, homeDir: options.homeDir, config: configLoadResult });
    const metricsExport = resolveMetricsExportOptions({ config: configLoadResult.effectiveConfig, cli: readMetricsFlags(pi) });
    services.configLoadResult = configLoadResult;
    services.agentCatalog = agentCatalog;
    services.metricsExport = metricsExport;
    services.startupDiagnostics = [...configLoadResult.diagnostics, ...metricsExport.diagnostics, ...agentCatalog.diagnostics];
  } catch (error) {
    services.metricsExport = undefined;
    services.startupDiagnostics = [{ severity: "error", code: "startup_config_catalog_failed", message: shortMessage(error), hint: "subagents unavailable until reload succeeds" }];
    safeCall(() => ctx.ui.notify("workbench config/catalog load failed; subagents unavailable", "warning"));
  }
}

function extractLinks(ctx: ExtensionContext): WorkbenchRuntimeLink[] {
  const entries = safeCall(() => ctx.sessionManager.getEntries()) ?? [];
  const links: WorkbenchRuntimeLink[] = [];
  for (const entry of entries as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (candidate.type !== "custom" || candidate.customType !== LINK_TYPE) continue;
    if (isWorkbenchRuntimeLink(candidate.data)) links.push({ ...candidate.data, schemaVersion: candidate.data.schemaVersion ?? 1 });
  }
  return links;
}

async function showStatus(runtime: WorkbenchRuntime, services: WorkbenchServices, ctx: ExtensionCommandContext): Promise<void> {
  const status = runtime.getStatus();
  if (!status.initialized || !status.run) {
    ctx.ui.notify("workbench: not initialized", "info");
    return;
  }

  let run: RunRecord = status.run;
  try {
    run = (await runtime.store.readRun(run.runId)) ?? run;
  } catch {
    // Status is read-only and best-effort; fall back to the in-memory record.
  }

  const lines = [
    `workbench: ${run.status}${status.resumed ? " (resumed)" : " (new)"}`,
    `run: ${run.runId}`,
    `trace: ${relativeToCwd(ctx.cwd, run.traceFile)}`,
    `metrics: ${formatMetrics(run.metrics)}`,
  ];
  const exportOptions = services.metricsExport;
  if (exportOptions && exportOptions.mode !== "off" && exportOptions.file) {
    lines.push(formatExportStatusLine({ run, file: exportOptions.file, mode: exportOptions.mode, template: exportOptions.template, cwd: ctx.cwd }));
  }
  const warnings = [
    status.metricsMayBeIncomplete ? "metrics may be incomplete" : undefined,
    status.traceWriteFailed ? "trace writes degraded" : undefined,
    status.sessionFileChanged ? "session file changed" : undefined,
    diagnosticSummary(services.startupDiagnostics, "config/catalog"),
  ].filter((value): value is string => Boolean(value));
  if (warnings.length) lines.push(`warnings: ${warnings.join("; ")}`);
  ctx.ui.notify(lines.join("\n"), warnings.length ? "warning" : "info");
}

async function dumpMetrics(runtime: WorkbenchRuntime, file: string, template: boolean, ctx: ExtensionCommandContext): Promise<void> {
  const run = runtime.getStatus().run;
  if (!run) {
    ctx.ui.notify("workbench: not initialized", "warning");
    return;
  }
  try {
    const result = await exportMetricsReport({ store: runtime.store, run, file, template, warnings: runtime.getStatus().warnings });
    ctx.ui.notify(`workbench metrics exported: ${relativeToCwd(ctx.cwd, result.file)}`, "info");
  } catch (error) {
    try { await emitMetricsExportError({ sink: runtime, run, error }); } catch { /* fail soft */ }
    ctx.ui.notify(`workbench metrics export failed: ${shortMessage(error)}`, "warning");
  }
}

async function exportOnShutdown(runtime: WorkbenchRuntime, services: WorkbenchServices): Promise<void> {
  const options = services.metricsExport;
  const run = runtime.getStatus().run;
  if (!run || !options || options.mode !== "onShutdown" || !options.file) return;
  try {
    await exportMetricsReport({ store: runtime.store, run, file: options.file, template: options.template, warnings: runtime.getStatus().warnings });
  } catch (error) {
    try { await emitMetricsExportError({ sink: runtime, run, error }); } catch { /* fail soft */ }
  }
}

function registerMetricsFlags(pi: ExtensionAPI): void {
  const api = pi as ExtensionAPI & { registerFlag?: (name: string, options?: unknown) => void };
  try {
    api.registerFlag?.("workbench-metrics-file", { description: "Workbench metrics export file", type: "string" });
    api.registerFlag?.("workbench-metrics-export", { description: "Workbench metrics export mode: off|onShutdown", type: "string" });
    api.registerFlag?.("workbench-metrics-template", { description: "Enable workbench metrics {runId} template expansion", type: "boolean" });
  } catch { /* optional pi API */ }
}

function readMetricsFlags(pi: ExtensionAPI): { file?: unknown; mode?: unknown; template?: unknown } {
  const api = pi as ExtensionAPI & { getFlag?: (name: string) => unknown };
  const get = (name: string): unknown => {
    try { return api.getFlag?.(name); } catch { return undefined; }
  };
  const template = get("workbench-metrics-template");
  return {
    file: get("workbench-metrics-file"),
    mode: get("workbench-metrics-export"),
    template: template === true ? true : undefined,
  };
}

function parseObserveArgs(args: string): { kind: "status" } | { kind: "dump"; file: string; template: boolean } | { kind: "invalid" } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === "status")) return { kind: "status" };
  if (parts[0] !== "dump") return { kind: "invalid" };
  let template = false;
  let fileParts = parts.slice(1);
  if (fileParts[0] === "--template") {
    template = true;
    fileParts = fileParts.slice(1);
  }
  const file = fileParts.join(" ");
  return file ? { kind: "dump", file, template } : { kind: "invalid" };
}

export function formatMetrics(metrics: RunMetrics): string {
  const parts = [
    `tools=${metrics.toolCallCount}`,
    `errors=${metrics.errorCount}`,
    `retries=${metrics.retryCount}`,
    `rate_limits=${metrics.rateLimitCount}`,
  ];
  const usageParts = [
    metricPart("tokens", metrics.totalTokens),
    metricPart("in", metrics.inputTokens),
    metricPart("out", metrics.outputTokens),
    metricPart("cache_read", metrics.cacheReadTokens),
    metricPart("cache_write", metrics.cacheWriteTokens),
    metricPart("reasoning", metrics.reasoningTokens),
    metricPart("tool_result", metrics.toolResultTokens),
    metricPart("system", metrics.systemPromptTokens),
    metricPart("context", metrics.contextTokens),
    metrics.costUsd === undefined ? undefined : `cost=$${metrics.costUsd.toFixed(4)}`,
  ].filter((part): part is string => Boolean(part));
  return [...parts, ...usageParts].join(" ");
}

function diagnosticSummary(diagnostics: WorkbenchDiagnostic[], label: string): string | undefined {
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const parts = [warnings ? `${label} warnings=${warnings}` : undefined, errors ? `${label} errors=${errors}` : undefined].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

function metricPart(label: string, value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${label}=${value}`;
}

function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function shortMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}
