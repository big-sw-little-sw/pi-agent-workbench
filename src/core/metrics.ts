import type { ObservationEvent, RunMetrics, RunRecord, RunStatus, UsageBreakdown } from "./types.js";

export const SCHEMA_VERSION = 1 as const;

const usageFields = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "toolResultTokens",
  "systemPromptTokens",
  "contextTokens",
  "costUsd",
] as const satisfies readonly (keyof UsageBreakdown)[];

export function normalizeReadSchemaVersion<T extends { schemaVersion?: number }>(value: T): T & { schemaVersion: number } {
  const version = value.schemaVersion ?? SCHEMA_VERSION;
  if (version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion: ${String(version)}`);
  }
  return { ...value, schemaVersion: version };
}

export function prepareWriteSchemaVersion<T extends { schemaVersion?: number }>(value: T): T & { schemaVersion: 1 } {
  if (value.schemaVersion !== undefined && value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion: ${String(value.schemaVersion)}`);
  }
  return { ...value, schemaVersion: SCHEMA_VERSION };
}

export function createEmptyMetrics(): RunMetrics {
  return {
    toolCallCount: 0,
    errorCount: 0,
    rateLimitCount: 0,
    retryCount: 0,
    retryFailureCount: 0,
    fallbackCount: 0,
    compactionAttemptCount: 0,
    compactionCount: 0,
    compactionAbortedCount: 0,
    compactionErrorCount: 0,
  };
}

function addUsage(metrics: RunMetrics, usage: UsageBreakdown | undefined): RunMetrics {
  if (!usage) return metrics;
  const next = { ...metrics };
  for (const field of usageFields) {
    const value = usage[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      next[field] = (next[field] ?? 0) + value;
    }
  }
  return next;
}

function isData(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function runEndStatusFromEvent(event: ObservationEvent): Exclude<RunStatus, "running" | "detached"> {
  const status = isData(event.data) ? event.data.status : undefined;
  return status === "completed" || status === "failed" || status === "aborted" || status === "unknown"
    ? status
    : "unknown";
}

export function applyEventToMetrics(metrics: RunMetrics, event: ObservationEvent): RunMetrics {
  let next: RunMetrics = { ...metrics };

  if (event.eventType === "usage") {
    next = addUsage(next, event.usage);
  }

  switch (event.eventType) {
    case "tool_start":
      next.toolCallCount += 1;
      break;
    case "error":
      next.errorCount += 1;
      break;
    case "rate_limit":
      next.rateLimitCount += 1;
      break;
    case "fallback":
      next.fallbackCount += 1;
      break;
    case "retry":
      if (event.data?.phase === "start") next.retryCount += 1;
      if (event.data?.phase === "end" && (event.data.status === "failed" || event.data.status === "exhausted")) {
        next.retryFailureCount += 1;
      }
      break;
    case "compaction":
      if (event.data?.phase === "start") next.compactionAttemptCount += 1;
      if (event.data?.phase === "end" && event.data.status === "completed") next.compactionCount += 1;
      if (event.data?.phase === "end" && event.data.status === "aborted") next.compactionAbortedCount += 1;
      if (event.data?.phase === "end" && event.data.status === "error") next.compactionErrorCount += 1;
      break;
  }

  return next;
}

export function recomputeRunRecord(input: { record: RunRecord; events: ObservationEvent[] }): RunRecord {
  let metrics = createEmptyMetrics();
  let status = input.record.status;
  let endedAt = input.record.endedAt;

  for (const event of input.events) {
    metrics = applyEventToMetrics(metrics, event);
    if (event.eventType === "runtime_attach") {
      status = "running";
    } else if (event.eventType === "runtime_detach") {
      status = "detached";
    } else if (event.eventType === "run_end") {
      status = runEndStatusFromEvent(event);
      endedAt = event.timestamp;
    }
  }

  return { ...input.record, metrics, status, endedAt };
}
