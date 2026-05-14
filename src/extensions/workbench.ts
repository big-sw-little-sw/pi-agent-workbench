import { promises as fs } from "node:fs";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerParentObserver } from "../observability/parent-observer.js";
import { emitMetricsExportError, exportMetricsReport, formatExportStatusLine, resolveMetricsExportOptions } from "../observability/metrics-export.js";
import { relativeToCwd, WorkbenchRuntime, isWorkbenchRuntimeLink } from "../runtime/workbench-runtime.js";
import { loadWorkbenchConfig } from "../config/workbench-config.js";
import { loadAgentCatalog } from "../subagents/agent-catalog.js";
import { parseSlashArgs } from "../core/slash-args.js";
import { exportHandoffLineage, runHandoff, type HandoffRecord, type HandoffRequest, type HandoffSessionAdapter } from "../handoff/index.js";
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
        if (parsed.lineage) await dumpLineage(runtime, parsed.file, ctx);
        else await dumpMetrics(runtime, parsed.file, parsed.template, ctx);
        return;
      }
      ctx.ui.notify("usage: /observe status | /observe dump [--lineage] [--template] <file>", "info");
    },
  });

  pi.registerCommand("handoff", {
    description: "Create a new-conversation manual/static handoff",
    handler: async (args, ctx) => handleHandoff(args, runtime, services, ctx),
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const entries = safeCall(() => ctx.sessionManager.getEntries()) ?? [];
    const target = [...(entries as unknown[])].reverse().find((entry) => isHandoffTargetEntry(entry)) as { data?: { systemPrompt?: string } } | undefined;
    if (!target?.data?.systemPrompt) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${target.data.systemPrompt}` };
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

async function dumpLineage(runtime: WorkbenchRuntime, file: string, ctx: ExtensionCommandContext): Promise<void> {
  const run = runtime.getStatus().run;
  if (!run) {
    ctx.ui.notify("workbench: not initialized", "warning");
    return;
  }
  try {
    const result = await exportHandoffLineage({ store: runtime.store, currentRun: run, file, warnings: runtime.getStatus().warnings });
    ctx.ui.notify(`workbench lineage exported: ${relativeToCwd(ctx.cwd, result.file)}`, result.report.warnings?.length ? "warning" : "info");
  } catch (error) {
    ctx.ui.notify(`workbench lineage export failed: ${shortMessage(error)}`, "warning");
  }
}

async function handleHandoff(args: string, runtime: WorkbenchRuntime, services: WorkbenchServices, ctx: ExtensionCommandContext): Promise<void> {
  const run = runtime.getStatus().run;
  if (!run) { ctx.ui.notify("workbench: not initialized", "warning"); return; }
  let request: HandoffRequest;
  try {
    request = parseHandoffArgs(args, ctx);
  } catch (error) {
    ctx.ui.notify(`handoff: ${shortMessage(error)}`, "warning");
    return;
  }
  try {
    const record = await runHandoff({
      request,
      sourceRun: run,
      store: runtime.store,
      sink: runtime,
      catalog: services.agentCatalog,
      adapter: createPiHandoffAdapter(ctx),
    });
    if (record.activation === "artifact_only") {
      appendSourceHandoffMetadata(ctx, record);
      const msg = record.status === "completed" ? "created" : "partial";
      const promptLine = record.targetPromptArtifact ? `\nprompt: ${relativeToCwd(ctx.cwd, record.targetPromptArtifact.path)}` : "";
      ctx.ui.notify(`handoff ${msg}: ${record.handoffId}${promptLine}`, record.status === "completed" ? "info" : "warning");
    }
  } catch (error) {
    ctx.ui.notify(`handoff failed: ${shortMessage(error)}`, "warning");
  }
}

function parseHandoffArgs(args: string, ctx: ExtensionCommandContext): HandoffRequest {
  const parsed = parseSlashArgs(args, {
    mode: { kind: "string" }, prompt: { kind: "string" }, to: { kind: "string" }, note: { kind: "string" },
    artifact: { kind: "string", multiple: true }, artifacts: { kind: "stringList" }, start: { kind: "boolean" }, "auto-start": { kind: "boolean" },
    "allow-partial-profile": { kind: "boolean" }, "allow-external-artifacts": { kind: "boolean" },
  });
  if (parsed.positionals.length) throw new Error("positional handoff goals are reserved for extractive handoff in 03-3; use --mode manual|static");
  const mode = stringFlag(parsed.flags.mode);
  if (mode !== "manual" && mode !== "static") throw new Error("extractive handoff comes in 03-3; use --mode manual or --mode static");
  return {
    method: mode,
    prompt: stringFlag(parsed.flags.prompt),
    artifacts: [...listFlag(parsed.flags.artifact), ...listFlag(parsed.flags.artifacts)],
    note: stringFlag(parsed.flags.note),
    targetAgentName: stringFlag(parsed.flags.to),
    autoStart: parsed.flags.start === true || parsed.flags["auto-start"] === true,
    headless: false,
    allowPartialProfile: parsed.flags["allow-partial-profile"] === true,
    allowExternalArtifacts: parsed.flags["allow-external-artifacts"] === true,
    confirmPartialProfile: (message) => ctx.ui.confirm("Partial target profile", message),
    confirmExternalArtifact: (message) => ctx.ui.confirm("External handoff artifact", message),
    continueWithoutInvalidArtifact: (message, artifactPath) => ctx.ui.confirm("Invalid handoff artifact", `${message}\n\nContinue without ${relativeToCwd(ctx.cwd, artifactPath)}?`),
    editPrompt: () => ctx.ui.editor("Manual handoff prompt", ""),
  };
}

function createPiHandoffAdapter(ctx: ExtensionCommandContext): HandoffSessionAdapter {
  return {
    createDraft: async (input) => {
      let sessionId: string | undefined;
      let sessionFile: string | undefined;
      appendSourceHandoffMetadata(ctx, recordFromSessionInput(input, "partial"));
      const result = await ctx.newSession({
        parentSession: input.parentSessionFile,
        setup: async (sm) => setupTargetSession(sm, input),
        withSession: async (targetCtx) => {
          sessionId = safeCall(() => targetCtx.sessionManager.getSessionId());
          sessionFile = safeCall(() => targetCtx.sessionManager.getSessionFile());
          targetCtx.ui.setEditorText(await fs.readFile(input.promptArtifactPath, "utf8"));
          targetCtx.ui.notify(`handoff draft created: ${input.handoffId}`, "info");
        },
      });
      return { cancelled: result.cancelled, sessionId, sessionFile };
    },
    autoStart: async (input) => {
      let sessionId: string | undefined;
      let sessionFile: string | undefined;
      let targetTask: { targetTaskStatus?: "completed" | "failed"; targetTaskErrorMessage?: string } = {};
      appendSourceHandoffMetadata(ctx, recordFromSessionInput(input, "partial"));
      const result = await ctx.newSession({
        parentSession: input.parentSessionFile,
        setup: async (sm) => setupTargetSession(sm, input),
        withSession: async (targetCtx) => {
          sessionId = safeCall(() => targetCtx.sessionManager.getSessionId());
          sessionFile = safeCall(() => targetCtx.sessionManager.getSessionFile());
          await targetCtx.sendUserMessage(input.prompt);
          await targetCtx.waitForIdle();
          targetTask = readTargetTaskStatus(targetCtx);
          targetCtx.ui.notify(`handoff auto-start completed: ${input.handoffId}`, targetTask.targetTaskStatus === "failed" ? "warning" : "info");
        },
      });
      return { cancelled: result.cancelled, sessionId, sessionFile, ...targetTask, ...readTargetTaskStatus(result) };
    },
  };
}

function appendSourceHandoffMetadata(ctx: ExtensionCommandContext, record: Pick<HandoffRecord, "handoffId" | "sourceRunId" | "sourceTraceId" | "targetRunId" | "targetTraceId" | "targetSessionId" | "targetSessionFile" | "targetPromptArtifact" | "status" | "targetTaskStatus">): void {
  const manager = ctx.sessionManager as unknown as { appendCustomEntry?: (type: string, data: unknown) => void; appendSessionInfo?: (name: string) => void };
  const metadata = { schemaVersion: 1, handoffId: record.handoffId, sourceRunId: record.sourceRunId, sourceTraceId: record.sourceTraceId, targetRunId: record.targetRunId, targetTraceId: record.targetTraceId, targetSessionId: record.targetSessionId, targetSessionFile: record.targetSessionFile, promptArtifact: record.targetPromptArtifact, status: record.status, targetTaskStatus: record.targetTaskStatus };
  safeCall(() => manager.appendCustomEntry?.("workbench-handoff-source", metadata));
  safeCall(() => manager.appendSessionInfo?.(`Workbench handoff ${record.handoffId}${record.targetRunId ? ` → ${record.targetRunId}` : ""}`));
}

function recordFromSessionInput(input: Parameters<HandoffSessionAdapter["createDraft"]>[0], status: HandoffRecord["status"]): Pick<HandoffRecord, "handoffId" | "sourceRunId" | "sourceTraceId" | "targetRunId" | "targetTraceId" | "targetSessionId" | "targetSessionFile" | "targetPromptArtifact" | "status" | "targetTaskStatus"> {
  return {
    handoffId: input.handoffId,
    sourceRunId: input.sourceRun.runId,
    sourceTraceId: input.sourceRun.traceId,
    targetRunId: input.targetRun.runId,
    targetTraceId: input.targetRun.traceId,
    targetPromptArtifact: input.promptArtifact,
    status,
  };
}

function readTargetTaskStatus(value: unknown): { targetTaskStatus?: "completed" | "failed"; targetTaskErrorMessage?: string } {
  // Pi interactive status probing is best-effort; API/headless adapters should return explicit targetTaskStatus/error when they can observe final target prompt status.
  const candidate = value as { targetTaskStatus?: unknown; targetTaskErrorMessage?: unknown; lastTaskStatus?: unknown; lastTaskError?: unknown; getLastTaskStatus?: () => unknown; getLastPromptStatus?: () => unknown; getLastError?: () => unknown } | undefined;
  const raw = safeCall(() => candidate?.getLastTaskStatus?.()) ?? safeCall(() => candidate?.getLastPromptStatus?.()) ?? candidate?.lastTaskStatus ?? candidate?.targetTaskStatus;
  const status = typeof raw === "object" && raw !== null ? (raw as { status?: unknown; errorMessage?: unknown }) : { status: raw, errorMessage: undefined };
  const error = status.errorMessage ?? candidate?.lastTaskError ?? candidate?.targetTaskErrorMessage ?? safeCall(() => candidate?.getLastError?.());
  const errorMessage = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  return status.status === "completed" || status.status === "failed" ? { targetTaskStatus: status.status, targetTaskErrorMessage: errorMessage } : {};
}

async function setupTargetSession(sm: unknown, input: Parameters<HandoffSessionAdapter["createDraft"]>[0]): Promise<void> {
  const manager = sm as { appendCustomEntry?: (type: string, data: unknown) => void; appendThinkingLevelChange?: (level: string) => void; appendSessionInfo?: (name: string) => void };
  manager.appendCustomEntry?.(LINK_TYPE, input.runtimeLink);
  manager.appendCustomEntry?.("workbench-handoff-target", { handoffId: input.handoffId, runId: input.targetRun.runId, traceId: input.targetRun.traceId, sourceRunId: input.sourceRun.runId, sourceTraceId: input.sourceRun.traceId, sourceSessionId: input.sourceRun.sessionId, sourceSessionFile: input.sourceRun.sessionFile, promptArtifact: input.promptArtifact, source: "handoff", agentName: input.targetAgent?.name, systemPrompt: input.targetAgent?.systemPrompt });
  if (input.targetAgent?.thinking) manager.appendThinkingLevelChange?.(input.targetAgent.thinking);
  manager.appendSessionInfo?.(input.title);
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

function parseObserveArgs(args: string): { kind: "status" } | { kind: "dump"; file: string; template: boolean; lineage: boolean } | { kind: "invalid" } {
  try {
    const parsed = parseSlashArgs(args, { template: { kind: "boolean" }, lineage: { kind: "boolean" } });
    if (parsed.positionals.length === 0 || (parsed.positionals.length === 1 && parsed.positionals[0] === "status")) return { kind: "status" };
    if (parsed.positionals[0] !== "dump") return { kind: "invalid" };
    const file = parsed.positionals.slice(1).join(" ");
    return file ? { kind: "dump", file, template: parsed.flags.template === true, lineage: parsed.flags.lineage === true } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function stringFlag(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function listFlag(value: unknown): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [String(value)];
}

function isHandoffTargetEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const candidate = entry as { customType?: unknown; type?: unknown; data?: unknown };
  return (candidate.customType === "workbench-handoff-target" || candidate.type === "workbench-handoff-target") && typeof candidate.data === "object";
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
