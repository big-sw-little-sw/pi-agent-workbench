import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerParentObserver } from "../observability/parent-observer.js";
import { relativeToCwd, WorkbenchRuntime, isWorkbenchRuntimeLink } from "../runtime/workbench-runtime.js";
import type { WorkbenchRuntimeLink } from "../runtime/workbench-runtime.js";
import type { RunRecord, RunMetrics } from "../core/types.js";

const LINK_TYPE = "workbench-runtime";

export default function workbenchExtension(pi: ExtensionAPI): void {
  const runtime = new WorkbenchRuntime({ cwd: process.cwd() });

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
    } catch (error) {
      runtime.markTraceWriteFailed(error);
      ctx.ui.notify(`workbench failed to initialize; observability disabled: ${shortMessage(error)}`, "warning");
    }
  });

  registerParentObserver(pi, runtime);

  pi.registerCommand("observe", {
    description: "Show workbench observability status (use /observe status)",
    handler: async (args, ctx) => {
      if (args.trim() && args.trim() !== "status") {
        ctx.ui.notify("usage: /observe status", "info");
        return;
      }
      await showStatus(runtime, ctx);
    },
  });

  pi.on("session_shutdown", async (event, _ctx) => {
    try {
      await runtime.detach({ reason: typeof event.reason === "string" ? event.reason : undefined });
    } catch (error) {
      runtime.markTraceWriteFailed(error);
    }
  });
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

async function showStatus(runtime: WorkbenchRuntime, ctx: ExtensionCommandContext): Promise<void> {
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
  const warnings = [
    status.metricsMayBeIncomplete ? "metrics may be incomplete" : undefined,
    status.traceWriteFailed ? "trace writes degraded" : undefined,
    status.sessionFileChanged ? "session file changed" : undefined,
  ].filter((value): value is string => Boolean(value));
  if (warnings.length) lines.push(`warnings: ${warnings.join("; ")}`);
  ctx.ui.notify(lines.join("\n"), warnings.length ? "warning" : "info");
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
