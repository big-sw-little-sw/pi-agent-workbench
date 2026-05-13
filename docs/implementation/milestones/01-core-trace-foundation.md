# Milestone 01 — Core Trace Foundation

## Goal

Create the shared core contracts and durable trace foundation used by every later workbench module.

This milestone should be implementable after reading only `AGENTS.md`, the required implementation docs listed there, and this file.

## Scope

Implement:

- `src/core/types.ts`
- `src/core/ids.ts`
- `src/core/metrics.ts`
- `src/core/trace-store.ts`
- `src/core/index.ts`
- minimal root `src/index.ts`
- `tests/core.test.ts`

`src/core/types.ts` should include shared contracts needed by later milestones, such as `AgentDefinition`, `SubagentRunRequest`, `SubagentRunResult`, `SubagentRunner`, and simple model/IQ resolver types, but Milestone 01 must not implement their behavior.

Do not implement parent observability, subagent execution, config loading, delegation, UI, pi extension code/imports, trace inspection CLI/dev commands, user-facing README feature docs, or empty placeholder directories for later milestones. README updates should wait until user-visible runtime behavior exists unless package export usage requires a tiny note.

Create only the core files listed above plus tests. Later milestones should add their directories when they contain real behavior.

## Contracts

### ObservationSink

```ts
interface ObservationSink {
  emit(event: ObservationEvent): void | Promise<void>;
}
```

### Event Source

Use:

```ts
type ObservationSource =
  | "runtime"
  | "parent"
  | "subagent"
  | "workflow"
  | "delegation"
  | "evaluator";
```

`runtime` means workbench-owned lifecycle/infrastructure events such as run start/end, trace-store/runtime errors, config reload events, and artifact bookkeeping.

### Control Mode

Use:

```ts
type ControlMode = "manual" | "workflow" | "llm-delegated" | "hybrid";
```

`RunRecord.controlMode` is the initial/default run mode. Event-level `controlMode` is the source of truth for mixed manual/delegated sessions.

### Event Types

Known event types:

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
  | "retry"
  | "fallback"
  | "compaction"
  | "error"
  | "artifact"
  | "subagent_start"
  | "subagent_end";

type ObservationEventType = KnownObservationEventType | (string & {});
```

The open string type allows future/custom events while preserving autocomplete for known events.

### UsageBreakdown

All fields are optional. Unknown means `undefined`, not `0`.

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

Use workbench-normalized names instead of pi-native usage names. Pi adapters can map `input`/`output`/`cacheRead`/`cacheWrite` and `cost.total` into these fields. MVP stores only total `costUsd`; component cost breakdowns, if needed, may remain in `event.data`.

`contextTokens` represents observed used context tokens when known. Do not add context-window limit fields to `RunMetrics`; producers may store `event.data.contextWindowTokens` when known, and live-state projections may compute percentages from event data.

### Agent Metadata

```ts
type AgentType = "parent" | "subagent" | "adhoc" | (string & {});
```

For named subagents, record `agent.type: "subagent"`, catalog `agent.name`, and invocation `agent.id`. For manual ad-hoc subagents, use `agent.type: "adhoc"` and a simple name such as `"adhoc"`. Parent events may use `agent.type: "parent"` with model/IQ metadata when useful, but should omit `agent.id` in MVP because parent identity is already represented by `runId`/`sessionId`.

### ObservationEvent

```ts
type ObservationEvent = {
  schemaVersion?: number;
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
    type?: AgentType;
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

`agent.tools` records the requested/allowed tool list for that agent/run. Actual tool usage is represented by `tool_start`/`tool_end` events.

`agent.model` records the resolved concrete model when known. `agent.iq` records the effective/resolved IQ level when known. Requested model/IQ and resolution details may be stored in `event.data` as `requestedModel`, `requestedIq`, or `resolutionReason`.

The optional `workflow` field remains in core for future compatibility, but workflows/YAML are post-MVP; MVP treats it as metadata only and implements no workflow behavior.

`parentSpanId` remains optional in the type, but producers should preserve lineage where known. `subagent_start` should include the invoking manual/delegation span when available; child internal events should use the subagent span as parent when possible; root events such as `run_start` omit it.

`subagent_start` and `subagent_end` for the same invocation should use the same `spanId`; child internal events should generally use that span as `parentSpanId`. `agent.id` separately identifies the subagent invocation.

Tool lifecycle events for the same tool call should use the same `spanId`; `parentSpanId` points to the containing turn/subagent/delegation span. Provider/pi tool call IDs may be stored in `event.data.toolCallId`.

Message lifecycle events for the same assistant/message stream should use the same `spanId`; `parentSpanId` points to the containing turn span. Provider/pi message IDs may be stored in `event.data.messageId`.

Turn lifecycle events for the same parent turn should use the same `spanId`; root parent turns usually omit `parentSpanId`, and messages/tool calls within the turn use the turn span as `parentSpanId`.

`run_start` and `run_end` for the same run should use the same runtime-created run span ID. `runId` identifies the run; the span ID identifies the lifecycle span. Store this as optional `RunRecord.spanId` so reload/resume/end logic can reuse it.

Writers should write `schemaVersion: 1`; readers must treat missing schema version as `1`. Core write paths should throw for explicit unsupported schema versions in MVP. Use separate read/write helpers: tolerant `normalizeReadSchemaVersion()` and strict `prepareWriteSchemaVersion()`.

### RunMetrics

Keep compact cross-cutting summary metrics only:

```ts
type RunMetrics = UsageBreakdown & {
  toolCallCount: number;
  errorCount: number;
  rateLimitCount: number;
  retryCount: number;
  retryFailureCount: number;
  fallbackCount: number;
  compactionAttemptCount: number;
  compactionCount: number;
  compactionAbortedCount: number;
  compactionErrorCount: number;
};
```

Do not include subagent-specific counters in MVP `RunMetrics`; derive them from `subagent_start`/`subagent_end` in projections.

`createEmptyMetrics()` initializes known counters to `0`, while usage/cost fields remain absent/`undefined` until observed. Counts are known zero at run start; token/cache/cost metrics may be unavailable and must not be represented as zero unless explicitly observed as zero.

### RunRecord

```ts
type RunRecord = {
  schemaVersion?: number;
  runId: string;
  traceId: string;
  spanId?: string;
  cwd: string;
  projectRoot?: string;
  storageRoot: string;
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

## ID Decisions

ID helpers should produce compact readable prefixed IDs:

- `run_<timestamp>_<random>`
- `trace_<timestamp>_<random>`
- `span_<random>`
- `agent_<random>`

Use `crypto.randomBytes()` suffixes, not verbose UUIDs.

Suggested entropy:

- run/trace: timestamp + 6 random bytes hex
- span/agent: 8 random bytes hex

Runtime defaults `traceId` to the exact same string as `runId` for MVP, and `createRunRecord()` should default omitted `traceId` to `runId`. Path/storage resolution belongs in a separate exported `resolveWorkbenchPaths({ cwd, baseDir? })` helper. It computes paths only and must not create directories. `createRunRecord()` should accept resolved absolute `cwd`, optional `projectRoot`, and `storageRoot`, generate `runId` and `spanId` when omitted, allow caller-provided `runId` for deterministic tests, always derive `traceFile` as `<storageRoot>/traces/<runId>.jsonl`, default omitted `startedAt` to `Date.now()`, default omitted `controlMode` to `manual`, and default omitted `status` to `running`, while allowing explicit overrides for deterministic tests. It should trim/validate writer-created run fields using the same rules as `readRun()`, including known status validation against `running`, `completed`, `failed`, `aborted`, and `unknown`. Keep `createTraceId()` available for future/custom cases.

## Metric Rules

`applyEventToMetrics(metrics, event)` must return a new object and must not mutate its input.

Rules:

- Aggregate token/cost fields only from explicit `eventType: "usage"` events.
- Other events may carry `usage` for display/detail, but they do not update persisted totals.
- Missing usage fields remain unavailable/undefined, not zero.
- Sum only usage fields present in explicit `usage` events. Do not recompute missing `totalTokens` from `inputTokens + outputTokens`; providers may define token categories differently, and core metrics should not invent values.
- Ignore malformed usage values in metrics: only finite non-negative numbers are accumulated. Ignore `NaN`, `Infinity`, strings, null, and negative values; metric reducers should not throw on bad usage payloads.
- Keep `costUsd?: number` and sum it with normal JavaScript numbers for MVP. Pi model costs are documented as per-million-token cost values and session usage exposes cost totals without a separate currency field; treat workbench `costUsd` as USD-compatible summary data, not a billing ledger. Revisit precision/currency modeling post-MVP if needed.
- `tool_start` increments `toolCallCount`; this means total observed tool starts across all sources.
- `error` increments `errorCount`.
- `rate_limit` increments `rateLimitCount`.
- `fallback` increments `fallbackCount`.
- `retry` with `data.phase: "start"` increments `retryCount`.
- `retry` with `data.phase: "end"` and `data.status: "failed" | "exhausted"` increments `retryFailureCount`.
- `compaction` updates compaction counters from `data.phase`/`data.status` when present:
  - `phase: "start"` increments `compactionAttemptCount`.
  - `phase: "end", status: "completed"` increments `compactionCount`.
  - `phase: "end", status: "aborted"` increments `compactionAbortedCount`.
  - `phase: "end", status: "error"` increments `compactionErrorCount`.
- `run_end` updates run status/end time in the trace store and recompute helper. Read status from `event.data.status`; valid statuses are `completed`, `failed`, `aborted`, and `unknown`. If missing/invalid, use `unknown`. Do not add a lifecycle-specific top-level field to `ObservationEvent`.
- Non-`run_end` events must not update `RunRecord.status`; `error` increments error metrics only, and failed subagents remain projection-level state unless the runtime later emits `run_end` with failed/aborted status.

## TraceStore

Default persistence layout under the resolved workbench storage root:

```text
.pi/workbench/runs/<run-id>.json
.pi/workbench/traces/<run-id>.jsonl
```

Storage root resolution:

1. explicit `baseDir` option wins and is the full workbench storage root; if relative, resolve against `cwd`
2. otherwise, if `cwd` is inside a git repository, use the repository root plus `.pi/workbench`
3. otherwise, use `cwd/.pi/workbench`

Even when `baseDir` overrides storage, still detect and store `projectRoot` when `cwd` is inside a git repository. `baseDir` controls storage only; it does not redefine project identity.

Git root detection should be simple filesystem parent walking for a `.git` file or directory from `path.resolve(cwd)` up to filesystem root when the cwd exists. Do not invoke `git`, do not add a home-directory special case, and stop when `path.dirname(current) === current`. A `.git` file counts as a git root for worktrees/submodules. If cwd does not exist, do not throw from path resolution; omit `projectRoot` and use explicit `baseDir` or `<resolved cwd>/.pi/workbench`.

Do not create or modify `.gitignore` automatically in MVP. Users may choose whether to ignore or commit `.pi/workbench/`; later status UI may warn when traces are project-local and not ignored.

`RunRecord.cwd` stores the absolute original parent/session cwd from the `TraceStore`. `RunRecord.projectRoot` stores the absolute resolved git repository root when found; otherwise it may be omitted. `RunRecord.storageRoot` stores the absolute actual workbench storage root. `RunRecord.traceFile` stores the absolute trace JSONL path. UI/display code may render relative paths for readability, but persisted metadata should be directly openable.

`TraceStore` construction should not throw merely because `cwd` does not exist; it resolves paths without side effects. `createRun()` may later fail if storage directories cannot be created. `TraceStore.createRun(input)` should use the store's `cwd`/`projectRoot`/`storageRoot` and must not accept path/storage fields such as `cwd`, `projectRoot`, `storageRoot`, or `traceFile`; create another `TraceStore` for another cwd.

`TraceStore.createRun(input)` accepts only run metadata overrides: optional `runId`, `traceId`, `spanId`, `controlMode`, `startedAt`, `sessionId`, `sessionFile`, `displayName`, `fallbackTitle`, and `primaryModel`. It should not accept `metrics` or `status`; it creates running runs with empty metrics. The pure `createRunRecord()` helper may accept optional `status`/`metrics` for tests and recompute helpers, defaulting to `running` and empty metrics.

Required behavior:

- `TraceStore.createRun()` eagerly creates the storage root plus `runs/` and `traces/` directories plus an empty trace JSONL file, then creates only the initial `RunRecord`; it does not append `run_start`. Create the empty trace file before writing the run record, so a written run record points to an existing trace file.
- `TraceStore.createRun()` must fail fast if the run ID already exists; it must not overwrite existing run records/traces.
- The runtime manager, implemented in a later milestone, emits `run_start` and `run_end` through the normal sink.
- `createRunRecord()` and `TraceStore.writeRun()` write `schemaVersion: 1` when missing and throw for explicit unsupported schema versions in MVP.
- `TraceStore.writeRun()` must reject records whose `cwd`, `projectRoot`, or `storageRoot` conflict with the store's resolved metadata.
- `TraceStore.writeRun()` must reject `traceFile` paths outside `store.tracesDir`; MVP trace files stay under `<tracesDir>/<runId>.jsonl`.
- `TraceStore.writeRun()` should use atomic-ish temp-file-then-rename writes for the mutable run JSON.
- `TraceStore.appendEvent()` first validates that `event.runId` has an existing run record; missing run records are errors and must not create orphan traces.
- `TraceStore.appendEvent()` writes events with `schemaVersion: 1` when missing and throws for explicit unsupported schema versions in MVP.
- `TraceStore.appendEvent()` requires producers to supply a valid finite non-negative numeric `timestamp`; it must not default event timestamps to persistence time.
- `TraceStore.appendEvent()` validates the same minimum event structure as `readTrace()` before writing and throws on invalid write input; required string fields must be non-empty after trimming. Optional `parentSpanId`, when present, must also be a non-empty string after trimming. Trim top-level ID/classifier fields before writing: `runId`, `traceId`, `spanId`, `parentSpanId`, `source`, `controlMode`, and `eventType`; leave nested `data` untouched. Do not require referenced parent spans to already exist.
- `TraceStore.appendEvent()` validates that `event.traceId` matches the run record's `traceId`; mismatches throw to avoid cross-trace contamination.
- `TraceStore.appendEvent()` enforces known `source` and `controlMode` values, but `eventType` remains any non-empty string for future/custom events.
- `TraceStore.appendEvent()` appends the JSONL event first, then updates persisted `RunRecord.metrics`, because the event log is canonical and metrics can be recomputed if a crash occurs between writes.
- JSONL appends should write exactly one compact JSON object per event followed by one newline: `JSON.stringify(event) + "\n"`. Do not pretty-print trace events.
- If JSONL append succeeds but run-record update fails, `appendEvent()` throws and does not attempt rollback/truncation; recovery is to read the trace, recompute metrics/status from events, and rewrite the run record.
- Milestone 01 should provide a pure `recomputeRunRecord()` helper, but no automatic repair in `readRun()`/`readTrace()` and no `TraceStore.repairRun()` method yet.
- `appendEvent()` should also update `RunRecord.status`/`endedAt` for `run_end` events.
- `TraceStore` must not emit additional events or own lifecycle policy.
- Serialize `appendEvent()` operations in-process per store/run to avoid races from parallel subagents.
- Cross-process locking is out of scope.
- `TraceStore.listRuns()` scans only `runs/*.json` in MVP; it does not infer orphan runs from `traces/*.jsonl`. Orphan recovery is post-MVP repair tooling.
- `TraceStore.listRuns()` returns runs sorted by `startedAt` descending; records with missing/invalid `startedAt` sort last.
- `TraceStore.readTrace(runId)` uses the run record's `traceFile` path when available. If the run record or trace file is missing, return an empty array; do not discover orphan trace files in MVP.
- `TraceStore.readRun()` returns `undefined` for a missing run file, but throws for invalid JSON, structurally invalid run records, or explicit unsupported schema versions. Missing `schemaVersion` is normalized to `1`.
- Minimum `readRun()` validation requires string `runId`, `traceId`, `cwd`, `storageRoot`, valid known `controlMode`, valid known `status`, `traceFile`, finite non-negative numeric `startedAt`, and object `metrics`. Optional `spanId`, `sessionId`, and `sessionFile` must be non-empty strings when present. Optional `endedAt` must be a finite non-negative number when present. Trim IDs/classifier/path fields such as `runId`, `traceId`, `spanId`, `cwd`, `projectRoot`, `storageRoot`, `controlMode`, `status`, `traceFile`, `sessionId`, and `sessionFile`; do not trim user-facing `displayName`/`fallbackTitle`. Do not require `endedAt >= startedAt` in core validation. Do not deeply validate every metric field; normalize missing metric counters/defaults through metrics helpers when needed.

Suggested API:

```ts
createRunId(): string;
createTraceId(): string;
createSpanId(): string;
createAgentId(): string;
normalizeReadSchemaVersion<T>(value: T): T & { schemaVersion: number };
prepareWriteSchemaVersion<T>(value: T): T & { schemaVersion: 1 };
createEmptyMetrics(): RunMetrics;
applyEventToMetrics(metrics: RunMetrics, event: ObservationEvent): RunMetrics;
resolveWorkbenchPaths(input: { cwd: string; baseDir?: string }): { cwd: string; projectRoot?: string; storageRoot: string; runsDir: string; tracesDir: string };
createRunRecord(input): RunRecord;
recomputeRunRecord(input: { record: RunRecord; events: ObservationEvent[] }): RunRecord;

class TraceStore {
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly storageRoot: string;
  readonly runsDir: string;
  readonly tracesDir: string;

  constructor(options: { cwd: string; baseDir?: string });
  createRun(input): Promise<RunRecord>;
  appendEvent(event: ObservationEvent): Promise<void>;
  readRun(runId: string): Promise<RunRecord | undefined>;
  writeRun(record: RunRecord): Promise<void>;
  listRuns(): Promise<RunRecord[]>;
  readTrace(runId: string): Promise<ObservationEvent[]>;
}
```

## Trace Reading

`readTrace()` should be tolerant:

- skip blank lines
- skip invalid JSON lines
- skip structurally invalid event lines
- normalize missing `schemaVersion` to `1`
- skip explicit unsupported schema versions
- skip events whose trimmed `runId` does not match the requested `runId`
- skip events whose trimmed `traceId` does not match the run record's `traceId`

Minimal structural validation requires:

- `runId: string`
- `traceId: string`
- `spanId: string`
- `source: string`
- `controlMode: string`
- `eventType: string`
- `timestamp: finite non-negative number`

Required string fields must be non-empty after trimming. `readTrace()` should trim accepted top-level ID/classifier fields (`runId`, `traceId`, `spanId`, `parentSpanId`, `source`, `controlMode`, `eventType`) while leaving nested `data` untouched.

Do not deeply validate `agent`, `usage`, or `data` during trace reads. Unlike write validation, `readTrace()` accepts any string `source`, `controlMode`, and `eventType` as long as the minimum structure is present; projections may ignore unknown values.

## Portability

Use Node `path` APIs for path handling and git-root parent walking. Do not split paths manually on `/`. Tests only need to run on the current platform; no Windows-specific test matrix is required for MVP, but core code should avoid POSIX-only assumptions.

## Suggested Implementation Sequence

1. Define core types in `src/core/types.ts`, including shared future-facing interfaces but no behavior.
2. Implement ID helpers in `src/core/ids.ts`.
3. Implement schema/version, metric, validation, and recompute helpers in `src/core/metrics.ts` or small file-local helpers where appropriate.
4. Implement path resolution and `TraceStore` in `src/core/trace-store.ts`.
5. Add barrel exports in `src/core/index.ts` and root `src/index.ts`.
6. Add `tests/core.test.ts` covering IDs, metrics, path resolution, schema handling, trace-store persistence, tolerant reads, run status, and concurrent appends.
7. Run `npm test` and keep the milestone limited to core files only.

An independent implementation agent should not need to create another feature plan before coding this milestone; this file is intentionally implementation-ready. A very short task checklist is acceptable, but avoid re-opening product scope.

## Acceptance Criteria

- `npm test` passes offline.
- Core exports are available from `src/core/index.ts` and root `src/index.ts`; root `src/index.ts` exports only implemented core APIs in Milestone 01, with no future module placeholders. `src/core/index.ts` may export all public symbols from intentional public core modules (`types`, `ids`, `metrics`, `trace-store`) while keeping unexported file-local helpers private.
- Run files and trace files are written under `.pi/workbench` in a temp test directory.
- Schema-version tests cover write paths adding `schemaVersion: 1`, write paths rejecting explicit unsupported versions, `readRun()` normalizing missing versions and throwing unsupported explicit versions, and `readTrace()` normalizing missing versions while skipping unsupported explicit event versions.
- Usage totals aggregate only from `usage` events; tests cover that lifecycle events such as `subagent_end` carrying `usage` do not update core metrics, while explicit `usage` events do.
- Unknown metrics remain `undefined`, not `0`.
- Invalid trace lines do not fail the whole trace read; tolerant read tests include blank lines, invalid JSON, unsupported schema versions, missing required fields, wrong runId, wrong traceId, and valid matching events.
- Concurrent `appendEvent()` calls do not corrupt metrics in-process.
- Run status tests cover `appendEvent(run_end)` updating persisted status/`endedAt`, `recomputeRunRecord()` deriving status/`endedAt` from the latest valid `run_end`, and non-`run_end` errors/subagent failures not changing run status.
- ID helper tests assert prefixes/basic shape/uniqueness, not brittle exact timestamp formatting.
- Path resolution tests cover no-git cwd fallback, repo-root `.git/`, `.git` as a file, nested cwd under repo, and explicit `baseDir` overriding storage while still recording `projectRoot`.
