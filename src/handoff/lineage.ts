import path from "node:path";
import { writeJsonFileAtomic } from "../core/fs.js";
import { applyEventToMetrics, createEmptyMetrics } from "../core/metrics.js";
import type { RunMetrics, RunRecord } from "../core/types.js";
import type { TraceStore } from "../core/trace-store.js";
import { HandoffStore } from "./store.js";
import type { HandoffLineageExport, HandoffRecord } from "./types.js";

export async function exportHandoffLineage(input: { store: TraceStore; currentRun: RunRecord; file: string; warnings?: string[]; now?: () => number }): Promise<{ file: string; report: HandoffLineageExport }> {
  const handoffStore = new HandoffStore(input.currentRun.storageRoot);
  const all = await handoffStore.list();
  const linked = all.filter((h) => matchesCurrentRun(h, input.currentRun));
  const handoffs = linked.length ? linked : [];
  const runIds = new Set<string>([input.currentRun.runId]);
  for (const handoff of handoffs) {
    runIds.add(handoff.sourceRunId);
    if (handoff.targetRunId) runIds.add(handoff.targetRunId);
  }
  const runs: Array<{ run: RunRecord; metrics: RunMetrics }> = [];
  const warnings = [...(input.warnings ?? [])];
  if (!handoffs.length) warnings.push("no handoff lineage found; exported current run only");
  for (const runId of runIds) {
    const run = await input.store.readRun(runId);
    if (!run) { warnings.push(`missing linked run: ${runId}`); continue; }
    const events = await input.store.readTrace(runId);
    const metrics = events.reduce((acc, event) => applyEventToMetrics(acc, event), createEmptyMetrics());
    runs.push({ run, metrics });
  }
  const combinedMetrics = runs.reduce((acc, item) => combine(acc, item.metrics), createEmptyMetrics());
  const exportFile = path.resolve(input.currentRun.projectRoot ?? input.currentRun.cwd, input.file);
  const report: HandoffLineageExport = {
    schemaVersion: 1,
    exportedAt: (input.now ?? Date.now)(),
    exportFile,
    runs,
    combinedMetrics,
    handoffs,
    sourceRunId: handoffs[0]?.sourceRunId,
    targetRunId: handoffs[0]?.targetRunId,
    warnings: warnings.length ? warnings : undefined,
  };
  await writeJsonFileAtomic(exportFile, report, { createParentDirs: true });
  return { file: exportFile, report };
}

function matchesCurrentRun(handoff: HandoffRecord, run: RunRecord): boolean {
  return handoff.sourceRunId === run.runId
    || handoff.targetRunId === run.runId
    || handoff.sourceTraceId === run.traceId
    || handoff.targetTraceId === run.traceId
    || (Boolean(run.sessionId) && (handoff.sourceSessionId === run.sessionId || handoff.targetSessionId === run.sessionId))
    || (Boolean(run.sessionFile) && (handoff.sourceSessionFile === run.sessionFile || handoff.targetSessionFile === run.sessionFile));
}

function combine(a: RunMetrics, b: RunMetrics): RunMetrics {
  const out: RunMetrics = { ...a };
  for (const key of Object.keys(b) as Array<keyof RunMetrics>) {
    const bv = b[key];
    if (bv === undefined) continue;
    const av = out[key];
    (out as Record<string, number>)[key] = (typeof av === "number" ? av : 0) + bv;
  }
  return out;
}

export function lineageHandoffSummary(record: HandoffRecord): Record<string, unknown> {
  return {
    handoffId: record.handoffId,
    method: record.method,
    status: record.status,
    activation: record.activation,
    sourceRunId: record.sourceRunId,
    targetRunId: record.targetRunId,
    targetAgentName: record.targetAgentName,
    promptArtifact: record.targetPromptArtifact,
    failureStage: record.failureStage,
    targetTaskStatus: record.targetTaskStatus,
  };
}
