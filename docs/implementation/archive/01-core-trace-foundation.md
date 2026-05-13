# 01 — Core Trace Foundation

## Goal

Build the smallest durable observability foundation that later phases can share.

Phase 1 should be boring, local, deterministic, and testable without pi, subagents, providers, or network.

## Simplification Decision

Keep features, reduce surface area.

Phase 1 needs only:

1. shared event/run types
2. ID helpers
3. JSONL trace read/write
4. run summary read/write/list
5. small metric accumulator

Do not over-model every future feature. Use optional fields and open metadata where appropriate.

## Non-Goals

- No pi extension registration.
- No parent event subscriptions.
- No subagents.
- No delegation.
- No TUI.
- No workflows.
- No artifacts implementation beyond paths being possible later.
- No real model/API/network calls.

## Implementation Target

Package root:

```text
~/sw/code/pi-agent-workbench
```

Recommended minimal files:

```text
src/core/types.ts          # all shared types
src/core/ids.ts            # run/trace/span id helpers
src/core/metrics.ts        # applyEventToMetrics()
src/core/trace-store.ts    # JSONL + run summary persistence
src/core/index.ts
src/index.ts
tests/core.test.ts
```

Avoid splitting into many tiny files unless useful.

## Required Types

### Core aliases

```ts
type ControlMode = "manual" | "workflow" | "llm-delegated" | "hybrid";
type ObservationSource = "parent" | "subagent" | "workflow" | "delegation" | "evaluator";
```

### Event type

Use a known union but allow future strings without schema churn.

```ts
type KnownObservationEventType =
  | "run_start"
  | "run_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "usage"
  | "rate_limit"
  | "fallback"
  | "compaction"
  | "error"
  | "artifact"
  | "subagent_start"
  | "subagent_end";

type ObservationEventType = KnownObservationEventType | (string & {});
```

### UsageBreakdown

All fields optional. Unknown means `undefined`, not `0`.

```ts
type UsageBreakdown = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  toolResultTokens?: number;
  systemPromptTokens?: number;
  contextTokens?: number;
  costUsd?: number;
};
```

### ObservationEvent

One flexible envelope. Future phase-specific data goes in `data` unless it is common enough to promote.

```ts
type ObservationEvent = {
  schemaVersion?: number; // write 1; missing reads as 1
  runId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  source: ObservationSource;
  controlMode: ControlMode;
  eventType: ObservationEventType;
  timestamp: number;

  agent?: {
    id?: string;
    name?: string;
    type?: string;
    iq?: string;
    model?: string;
    tools?: string[];
  };

  workflow?: {
    id?: string;
    stepId?: string;
    variantId?: string;
  };

  usage?: UsageBreakdown;
  data?: Record<string, unknown>;
};
```

### RunMetrics

Keep compact summary metrics only. Detailed data stays in JSONL trace.

```ts
type RunMetrics = UsageBreakdown & {
  toolCallCount: number;
  errorCount: number;
  rateLimitCount: number;
  fallbackCount: number;
  compactionAttemptCount: number;
  compactionCount: number;
  compactionAbortedCount: number;
  compactionErrorCount: number;
};
```

### RunRecord

```ts
type RunRecord = {
  schemaVersion?: number;
  runId: string;
  traceId: string;
  cwd: string;
  controlMode: ControlMode;
  status: "running" | "completed" | "failed" | "aborted" | "unknown";
  startedAt: number;
  endedAt?: number;
  traceFile: string;
  metrics: RunMetrics;

  sessionId?: string;
  sessionFile?: string;
  displayName?: string;
  fallbackTitle?: string;
  primaryModel?: string;
};
```

## Version Rule

- Writers write `schemaVersion: 1`.
- Readers treat missing `schemaVersion` as `1`.

## Persistence Layout

Under a supplied project cwd/base dir:

```text
.pi/workbench/runs/<run-id>.json
.pi/workbench/traces/<run-id>.jsonl
```

Do not create general artifacts support in Phase 1. Later phases can add:

```text
.pi/workbench/artifacts/<run-id>/
```

Trace events should remain reasonably small. If a later phase needs to persist large payloads, such as oversized subagent final outputs, full tool output, transcripts, diffs, screenshots, or reports, it should add artifact file management and store artifact references in `event.data` instead of embedding large blobs in JSONL.

## Required APIs

Names can vary, but functionality should exist.

```ts
createRunId(): string
createTraceId(): string
createSpanId(): string
normalizeSchemaVersion<T>(value: T): T & { schemaVersion: number }
createEmptyMetrics(): RunMetrics
applyEventToMetrics(metrics: RunMetrics, event: ObservationEvent): RunMetrics
createRunRecord(input): RunRecord

class TraceStore {
  constructor(options: { cwd: string; baseDir?: string })
  createRun(input): Promise<RunRecord>
  appendEvent(event: ObservationEvent): Promise<void>
  readRun(runId: string): Promise<RunRecord | undefined>
  writeRun(record: RunRecord): Promise<void>
  listRuns(): Promise<RunRecord[]>
  readTrace(runId: string): Promise<ObservationEvent[]>
}
```

## Metric Rules

- `usage` event adds present numeric usage fields.
- Missing usage fields do not become zero.
- `tool_start` increments `toolCallCount`.
- `error` increments `errorCount`.
- `rate_limit` increments `rateLimitCount`.
- `fallback` increments `fallbackCount`.
- `compaction` increments compaction counts according to `event.data.phase`/`event.data.status` when present:
  - `phase: "start"` increments `compactionAttemptCount`.
  - `phase: "end", status: "completed"` increments `compactionCount`.
  - `phase: "end", status: "aborted"` increments `compactionAbortedCount`.
  - `phase: "end", status: "error"` increments `compactionErrorCount`.
- Compaction payload details, when available, stay in `event.data` (for example `reason`, `tokensBefore`, `firstKeptEntryId`, `willRetry`, `fromExtension`, `summaryLength`). Do not store full compaction summaries in metrics.
- `run_end` may update status/end time.

## Acceptance Criteria

- Package builds.
- Tests pass without network/API keys.
- Can create a run in a temp dir.
- Can append/read JSONL events.
- Can list persisted runs.
- Missing schema version reads as `1`.
- Writers include `schemaVersion: 1`.
- Unknown metrics stay undefined.
- Metric accumulation works.
- Blank JSONL lines are ignored.

## Test Plan

Use temp directories.

Test:

- ID helper basic uniqueness/format.
- schema version normalization.
- run creation.
- JSONL append/read roundtrip.
- run summary write/read/list.
- usage aggregation with partial fields.
- cache fields unavailable vs explicit zero.
- rate-limit/fallback/tool/error/compaction counts.
- blank JSONL line handling.

## Keep Out of Phase 1

- typed `RateLimitEvent` payload beyond generic `data`
- artifact file management
- UI state
- pi extension lifecycle
- subagent runner
- context policy
- fallback policy engine
