# Milestone 02 — Shared Runtime + Parent Observability

## Goal

Create the shared workbench runtime/run manager and wire parent pi observability into the cohesive `workbench` extension.

This milestone should be implementable after reading only `AGENTS.md`, the required implementation docs listed there, Milestone 01, and this file.

## Depends On

- Milestone 01 core trace foundation.

## Scope

Implement:

- `src/runtime/workbench-runtime.ts`
- `src/runtime/index.ts`
- `src/observability/parent-observer.ts`
- `src/observability/index.ts`
- `src/extensions/workbench.ts`
- `tests/runtime-parent-observability.test.ts`

Update:

- `src/index.ts` to export implemented runtime/observability APIs only if useful for tests/package consumers.
- `README.md` with user-facing install/load instructions and a concise observability quick start once `workbench.ts` and `/observe status` exist.

Do not implement subagent execution, agent catalog loading, config loading beyond minimal runtime options, delegation, rich UI, workflow/YAML behavior, or monitor widgets in this milestone.

Milestone 02 should start moving README.md toward the user-facing landing page for the package. Keep it concise: install/load instructions, observability quick start, `/observe status`, trace storage location, resume/detach semantics, and metrics completeness warning behavior. If details grow too long later, link from README.md to focused `docs/user/*.md` pages rather than making README a full manual.

Documentation note for later subagent milestones: user-facing docs and terse code comments must explain that the parent workbench run can resume across pi reload/quit/resume, but individual process-based subagent invocations do not resume in the MVP. Interrupted subagents are aborted when observable or later shown as orphaned/unknown by projections.

## Milestone 01 Contract Adjustment

During Milestone 02 planning, runtime lifecycle naming/status semantics were clarified while the implementation is still greenfield. Update the core known event types from Milestone 01 to include `runtime_attach`, `runtime_detach`, `prompt_start`, and `prompt_end` as first-class known events. Keep `run_start`/`run_end` for logical observation-run creation/finalization. Update `RunStatus` to include `detached`, meaning the observation run is open/resumable but no runtime is currently attached.

## Core Decisions

- Normal user/demo loading uses one cohesive extension: `src/extensions/workbench.ts`.
- The extension factory wires objects and handlers, but the workbench run starts on pi `session_start`, not at module load/factory time.
- Runtime code lives in `src/runtime/`; parent event subscription/normalization lives in `src/observability/`.
- Observability must work without subagents.
- Parent events persist into the same run/trace later used by subagents/delegation.
- `run_start` is persisted only when a brand-new observation run is created.
- `runtime_attach` is a known core event type and is persisted whenever an extension/runtime instance attaches to a run, including first creation and later resume/reload.
- `runtime_attach` updates `RunRecord.status` to `running`.
- `runtime_detach` is a known core event type; ordinary pi `session_shutdown` emits `runtime_detach`, not `run_end`, because users may quit/reload and later resume the same pi session/run.
- `runtime_detach` updates `RunRecord.status` to `detached` but does not set `endedAt`.
- `run_end` is reserved for an explicit future finalization/failure/abort of the observation run, not normal extension teardown.
- Future subagent invocations are child spans/events inside the parent workbench run; subagent completion/failure/abort does not change `RunRecord.status` and does not emit `run_end`.
- The runtime manager emits lifecycle events through the normal `ObservationSink`.
- `TraceStore.createRun()` must not implicitly append lifecycle events.
- Event-level `controlMode` is the source of truth; the run record control mode is only the default/initial mode.
- Runtime must fail soft during pi startup: corrupt/missing old workbench linkage or storage creation failures should not prevent pi from loading.

## Session Resume and Reload Semantics

The MVP principle is one shared workbench observation run per pi session. Because this workflow frequently uses reload/resume, Milestone 02 must persist a session-to-run link instead of blindly creating a new run for every extension lifetime.

Use pi session custom entries:

```ts
pi.appendEntry("workbench-runtime", {
  schemaVersion: 1,
  runId,
  traceId,
  storageRoot,
  traceFile,
  createdAt,
  metricsMayBeIncomplete,
});
```

On `session_start`:

1. Inspect `ctx.sessionManager.getEntries()` for custom entries with `customType: "workbench-runtime"`.
2. Select the latest structurally valid entry by session entry order, not by `createdAt`.
3. Attempt to read the linked run from the current `TraceStore`.
4. Verify the linked run's trace file still exists and is readable before resuming. Do not rely on later append behavior because `appendFile` can recreate a missing JSONL file and silently fragment history.
5. If the run exists and the trace file is readable, resume it.
6. If no valid link exists, or the linked run/trace is missing/corrupt/unreadable, create a new run and append a new custom entry.

Multiple link entries can exist because pi custom entries are append-only. Normal reload/resume should not append a new link when the existing link is valid. Additional links are expected only for recovery, migration, or bug/manual-edit cases; latest valid append wins deterministically.

A structurally valid link entry has:

- `entry.type === "custom"`
- `entry.customType === "workbench-runtime"`
- `entry.data.schemaVersion` missing or `1`
- non-empty string `runId`
- non-empty string `traceId`

The link should also include `storageRoot` and `traceFile` as hints/debug metadata when known, but Milestone 02 should resolve/read the run through the current `TraceStore` rooted at current cwd/baseDir. Stored absolute paths may be stale if a project moved and must not override current storage policy. If replacement-run recovery fragmented metrics, include `metricsMayBeIncomplete: true` in the replacement link so the warning survives later reloads without scanning the trace.

Ignore malformed entries and unsupported schema versions.

Resume behavior:

- Resuming/reloading the same pi session should reuse the same `runId`/`traceId` when possible.
- Resume linked runs with status `detached` normally.
- Resume linked runs with status `running`, but mark the attach event with `data.previousStatus: "running"` and `data.possibleUncleanDetach: true` because the prior runtime may have crashed before `runtime_detach`.
- Resume linked runs with status `unknown` if the run is otherwise readable, but mark the attach event with `data.previousStatus: "unknown"` and a warning.
- Do not resume linked terminal runs with status `completed`, `failed`, or `aborted`; create a replacement run instead.
- `/new`, `/fork`, and `/clone` naturally get their own session histories and therefore their own workbench run links.
- Store `sessionFile` on `RunRecord` when available for external grouping/debugging.
- Store `session_start` reason, current attach cwd, and available session file/path details in `run_start.data` for new runs and `runtime_attach.data` for every attach.
- Keep `RunRecord.cwd` as the original cwd from run creation; do not mutate it on later attaches. Different attach cwd values belong in `runtime_attach.data.cwd`.
- Keep `RunRecord.sessionFile` as the original session file from run creation; do not mutate it on later attaches.
- If the current attach `sessionFile` differs from `RunRecord.sessionFile`, set `runtime_attach.data.sessionFileChanged: true` and expose a soft `/observe status` warning that grouping may be ambiguous. This is not a metrics-incomplete warning.
- `possibleUncleanDetach` is an attachment warning, not a metrics warning. Do not set `metricsMayBeIncomplete` merely because the previous status was `running`; reserve `metricsMayBeIncomplete` for replacement-run recovery that fragments metrics.

Invalid-link behavior:

- Do not throw and break pi startup.
- Create a new run and append a replacement `workbench-runtime` entry.
- Treat a linked run whose persisted `traceId` differs from the link `traceId` as invalid/corrupt; do not resume it.
- Treat a linked run whose `traceFile` is missing or unreadable as invalid/corrupt; do not resume it, because recreating the JSONL would silently lose earlier history.
- Treat a linked terminal run (`completed`, `failed`, or `aborted`) as closed and not resumable; create a new run instead.
- Emit a runtime `error` event after the new run is initialized, with details such as old `runId`, old `traceFile`, and a short reason.
- Mark the new `run_start.data.metricsMayBeIncomplete: true`, `runtime_attach.data.metricsMayBeIncomplete: true`, and replacement link `metricsMayBeIncomplete: true`; include `data.recoveredFromInvalidLink` so later status/report UI can warn that metrics may be fragmented.

## User-Facing Incomplete Metrics Indication

Milestone 02 should provide a minimal indication through `/observe status` when metrics may be incomplete.

`/observe status` should report, tersely:

- current `runId`
- trace file path
- run status
- whether the run was resumed or newly created
- warning line if `metricsMayBeIncomplete` is true, e.g. `warning: metrics may be incomplete; previous workbench run link was invalid`

Later monitor/report milestones can render this more prominently, but Milestone 02 should already preserve the flag in trace metadata and expose it via the status command.

## Runtime Responsibilities

The runtime manager owns:

- run initialization on `session_start`
- persisted session-run linkage lookup/creation
- trace ID/run ID selection
- shared sink composition
- trace-store append calls
- runtime lifecycle events
- current run status for commands/tests
- extension-level cleanup/detach behavior on `session_shutdown`
- soft recovery from invalid persisted runtime links

It must not own:

- subagent process spawning
- agent catalog policy
- delegation tool policy
- UI rendering internals
- parent pi event normalization details

## Suggested Runtime API

Exact names may vary, but keep this shape simple and testable:

```ts
type WorkbenchRuntimeOptions = {
  cwd: string;
  baseDir?: string;
  controlMode?: ControlMode;
  now?: () => number;
};

type WorkbenchRuntimeSessionInfo = {
  reason?: string;
  sessionId?: string;
  sessionFile?: string;
  displayName?: string;
  primaryModel?: string;
  existingLinks?: WorkbenchRuntimeLink[];
  appendLink?: (link: WorkbenchRuntimeLink) => void | Promise<void>;
};

type WorkbenchRuntimeLink = {
  schemaVersion?: number;
  runId: string;
  traceId: string;
  storageRoot?: string;
  traceFile?: string;
  createdAt?: number;
  metricsMayBeIncomplete?: boolean;
};

type WorkbenchRuntimeStatus = {
  initialized: boolean;
  run?: RunRecord;
  resumed: boolean;
  metricsMayBeIncomplete: boolean;
  traceWriteFailed?: boolean;
  sessionFileChanged?: boolean;
  warnings: string[];
};

class WorkbenchRuntime implements ObservationSink {
  constructor(options: WorkbenchRuntimeOptions);
  start(session: WorkbenchRuntimeSessionInfo): Promise<RunRecord>;
  detach(input?: { reason?: string }): Promise<void>;
  end(input: { status: "completed" | "failed" | "aborted" | "unknown"; reason?: string }): Promise<void>;
  emit(event: ObservationEvent): Promise<void>;
  getStatus(): WorkbenchRuntimeStatus;
  getSink(): ObservationSink;
}
```

Runtime event behavior:

- `start()` creates or resumes a run.
- If `start()` creates a brand-new observation run, it first emits `run_start` through `emit()`.
- `run_start` uses `source: "runtime"`, `controlMode: "manual"` by default, the run's `spanId`, and current timestamp.
- Every successful `start()` emits `runtime_attach` through `emit()` for the current extension/runtime lifecycle.
- `runtime_attach.data.resumed` is `false` for first creation and `true` for resumed runs.
- The event log is append-only and represents both logical run lifecycle and runtime process attach/detach observations.
- `detach()` emits `runtime_detach` through `emit()` once per runtime instance if a run is active.
- `runtime_attach` and `runtime_detach` use `source: "runtime"`, the run's lifecycle `spanId`, and `data.reason` from pi lifecycle events when available (`startup`, `reload`, `quit`, `new`, `resume`, `fork`, etc.).
- `runtime_detach` updates `RunRecord.status` to `detached` but must not set `endedAt`; core metrics should otherwise ignore it.
- `end()` emits `run_end` only for explicit finalization/failure/abort of the observation run; Milestone 02 does not call it for ordinary pi shutdown.
- `run_end.data.status` must be a valid terminal/unknown status for core `TraceStore` status updates when a future caller intentionally finalizes the run.
- `RunRecord.status` meanings after the Milestone 02 adjustment are: `running` = runtime currently attached; `detached` = open/resumable but no runtime attached; `completed`/`failed`/`aborted` = explicitly finalized terminal states; `unknown` = unclear/corrupt/imported state.
- Guard against duplicate `start()`/`detach()`/`end()` calls in one runtime instance.

## Parent Observability

Capture parent-session events available from pi without requiring provider credentials or real model calls in tests.

Normalize to `ObservationEvent` where possible:

- parent prompt/agent-loop lifecycle: map pi `agent_start`/`agent_end` to workbench `prompt_start`/`prompt_end`
- parent turns: `turn_start`, `turn_end`
- model/message lifecycle: `message_start`, `message_update`, `message_end`
- tool calls: map pi `tool_execution_start`, `tool_execution_update`, `tool_execution_end` to workbench `tool_start`, `tool_update`, `tool_end`
- usage/cost: explicit `usage` events for aggregate totals
- errors: `error`
- rate limits/retries if exposed by parent pi events: `rate_limit`, `retry`
- compaction if exposed: `compaction`

Compaction policy:

- Map pi `session_before_compact`/`session_compact` if straightforward.
- Emit `compaction` with `data.phase: "start"` before compaction so core metrics count attempts consistently.
- Emit `compaction` with `data.phase: "end", data.status: "completed"` after successful compaction.
- If pi exposes cancel/error, map to `data.status: "aborted"`/`"error"`.
- Do not persist compacted content or summaries in Milestone 02.

Provider hook policy:

- Do not use `before_provider_request` in Milestone 02; provider payloads may be huge/sensitive and are not needed for MVP parent observability.
- Use `after_provider_response` only if straightforward, primarily to emit small `rate_limit` events for HTTP 429 responses with limited metadata such as `retry-after`.
- Observe explicit pi retry events only if exposed; do not infer retries from repeated messages/responses or HTTP failures.
- Milestone 02 does not implement workbench-level fallback. Future fallback-on-429 policy should emit an explicit `fallback` event when a model change is actually chosen, separate from observed `rate_limit` and `retry` events.

Use `source: "parent"` for parent pi activity and `source: "runtime"` for workbench lifecycle/infrastructure events.

Parent observer responsibilities:

- subscribe to pi events
- normalize pi event payloads into `ObservationEvent`
- use pi event timestamps when present and finite/non-negative; otherwise use runtime `now()`
- preserve stable spans for lifecycle pairs where pi supplies IDs
- emit through the runtime sink
- avoid throwing from event handlers when normalization of a single event fails; emit a runtime/parent `error` event when possible
- avoid disrupting pi if trace writes fail during parent event handling

It must not:

- create or end workbench runs
- write trace files directly
- own metrics aggregation
- register subagent/delegation behavior

## Parent Prompt/Turn Semantics

Pi `agent_start`/`agent_end` represent the parent agent loop for one user prompt. Workbench maps these to `prompt_start`/`prompt_end` to avoid confusion with named subagents. A prompt may contain multiple turns; each turn is one model response plus any tool calls. Subagent invocation lifecycle remains represented separately by `subagent_start`/`subagent_end`.

## Parent Span/ID Rules

The parent observer should keep lineage stable but simple:

- Prompt lifecycle events for the same pi parent agent loop should reuse one span ID when possible. If pi does not expose a prompt/agent-loop ID, keep a single active prompt span created on `agent_start` and reused on `agent_end`.
- Turn lifecycle events for the same pi `turnIndex` should reuse one span ID during the active turn.
- Message lifecycle events for the same pi/provider message should reuse one span ID when a message ID is available; otherwise derive a span per lifecycle observation and store identifying details in `data`.
- Tool lifecycle events for the same pi `toolCallId` should reuse one span ID.
- Turn spans should use the active prompt span as `parentSpanId` when known.
- Tool/message spans should use the active turn span as `parentSpanId` when known.
- Clean span maps to avoid long-session memory growth: clear prompt span on `prompt_end`, clear active turn span on `turn_end`, delete message span on `message_end`, and delete tool span on `tool_end`.
- If an end/update event arrives without a known start span, create/use a span anyway and set `data.missingStart: true`.
- When an orphan update/end event has a stable message/tool ID, store the generated span in the relevant map before emitting so later updates/end events for the same ID reuse the same span; still delete the span on the corresponding end event.
- Do not require parent spans to exist before child spans; core trace validation intentionally does not enforce span references.

## Usage Rules

- Emit explicit `eventType: "usage"` events when totals should update.
- Do not rely on lifecycle events with `usage` to update persisted `RunMetrics`.
- Unknown token/cache/cost metrics remain unavailable/undefined.
- Map pi usage fields into workbench `UsageBreakdown` only when finite non-negative numbers are known.
- Map total cost into `costUsd` only when available as a total; keep richer provider cost details in `event.data` if useful.

Suggested usage mapping:

```text
pi input/inputTokens              -> usage.inputTokens
pi output/outputTokens            -> usage.outputTokens
pi total/totalTokens              -> usage.totalTokens
pi cacheRead/cacheReadTokens      -> usage.cacheReadTokens
pi cacheWrite/cacheWriteTokens    -> usage.cacheWriteTokens
pi reasoning/reasoningTokens      -> usage.reasoningTokens
pi usage.cost.total               -> usage.costUsd
```

If pi emits usage on assistant `message_end`, the observer should emit:

1. the normalized `message_end` event, optionally carrying `usage` for detail/display; and
2. a separate explicit `usage` event with the same normalized usage for persisted aggregate totals.

Do not aggregate usage from user or tool-result messages in Milestone 02 unless pi later documents them as authoritative model usage. Persisted parent usage totals may lag until final assistant message completion; this favors correctness over token-by-token live estimates. A later live UX/monitor milestone may show "current turn pending" or approximate streaming state without updating aggregate metrics until authoritative usage arrives.

Parent payload policy for Milestone 02:

- Do not persist full user prompt text by default; `prompt_start` may store prompt length/image count but not the prompt body.
- Do not persist prompt/message/tool previews by default; truncation is not sanitization.
- Do not persist full streaming chunks from `message_update`.
- Do not persist giant final message content into JSONL.
- Keep parent message events to metadata, lifecycle, role, IDs, content lengths/counts, and authoritative usage.
- Do not persist full parent tool args/results by default.
- `tool_start` may store `toolName`, `toolCallId`, and argument shape/count metadata when useful, but not raw argument values.
- `tool_update` should store small metadata only.
- `tool_end` may store `isError`, status, and small result shape/count metadata when useful, but not raw result content.
- Error events may include concise metadata such as error name, phase, and a short capped message (for example 500 chars). Do not persist full stack traces, request/response bodies, or large/raw error payloads by default. Mark `data.truncated: true` when capped.
- Milestone 04 owns the first artifact-writing policy for oversized subagent final output.
- Parent transcript/tool artifacting is deferred to Milestone 07 or post-MVP inspector/report work only if a concrete UX needs it.

## Extension Entry Point

`src/extensions/workbench.ts` should stay thin:

- instantiate `WorkbenchRuntime` using current process cwd/default options
- register `session_start` handler that calls runtime `start()` with session info and persisted links from `ctx.sessionManager.getEntries()`
- call `pi.appendEntry("workbench-runtime", data)` from runtime start when a new link is needed
- register parent observability hooks through `registerParentObserver(pi, runtime)`
- register `/observe status`
- register `session_shutdown` handler that calls runtime `detach()`
- avoid module-specific business logic in the extension entrypoint

The extension should import pi types only as types where possible.

## README Update

Update `README.md` in this milestone because `workbench.ts` and `/observe status` are user-visible.

README should include:

- short package description
- user-focused GitHub install commands:

```bash
pi install git:github.com/big-sw-little-sw/pi-agent-workbench
pi install -l git:github.com/big-sw-little-sw/pi-agent-workbench
```

- package manifest support for pi install, e.g. `package.json` `pi.extensions` points at `src/extensions/workbench.ts`
- development setup command if needed
- local development loading command:

```bash
pi --no-extensions \
  -e ~/sw/code/pi-agent-workbench/src/extensions/workbench.ts
```

- observability quick start: install/load extension, run pi normally, use `/observe status`
- default trace/run paths under `.pi/workbench/`
- run lifecycle summary: `run_start` once, `runtime_attach` on load/resume, `runtime_detach` on shutdown, `run_end` only on explicit future finalization
- status summary: `running` means runtime attached, `detached` means open/resumable with no runtime attached
- metrics warning: `/observe status` warns when metrics may be incomplete after invalid-link recovery
- brief privacy note, not overemphasized: parent observability records lifecycle/usage/tool names/status metadata and does not capture full prompt/message/tool args/results by default
- note that subagent docs will be added when subagent commands exist; do not document unimplemented commands as available

## Trace Write Failure Handling

Observability must not break normal pi usage.

- `runtime.emit()` may throw for tests/direct callers when persistence fails.
- Parent observer handlers should catch errors from `sink.emit()` so pi lifecycle/model/tool flow is not disrupted by observability failures.
- On first trace write failure from an observer handler, set runtime degraded state such as `traceWriteFailed` with a short reason.
- If `ctx.ui.notify` is available, notify once: `workbench trace write failed; observability degraded`.
- Do not recursively emit an `error` event when trace writing itself is failing.
- `/observe status` should show a degraded warning when trace writes have failed.

Runtime lifecycle failure handling:

- `session_start` should fail soft when possible. If run creation/storage initialization fails completely, notify the user, set runtime uninitialized/degraded state, and let pi continue.
- Parent observer handlers should no-op while runtime is uninitialized.
- `session_shutdown` should best-effort emit `runtime_detach`, catch failures, and never block pi exit.

## Minimal `/observe status` Command

Implement a minimal command if command registration is available and straightforward.

Behavior:

- If runtime has not started, notify/print `workbench: not initialized`.
- If initialized, read the persisted `RunRecord` from disk when possible and fall back to runtime's last known run if read fails.
- Show concise run status with run ID, status, trace path, and metrics counters/token breakdown fields that are known.
- Render trace paths relative to cwd/project root when possible for readability; persisted paths remain absolute.
- Unknown usage metrics should be omitted or shown as `unknown`, never `0`.
- Token/cost display should include a concise breakdown for defined fields, not only `totalTokens`: total, input, output, cache read/write, reasoning, tool result, system prompt, context, and cost when present.
- Include incomplete-metrics warning when runtime status has `metricsMayBeIncomplete`.
- Include degraded warning when runtime status has `traceWriteFailed`.
- Include soft grouping warning when current session file differs from the run record's original `sessionFile`.
- Keep output to roughly 3–5 lines.
- `/observe status` is read-only: it must not append trace events, mutate run/session state, repair records, create runs, inject messages, or affect LLM context. Repeated status calls should not consume context window.

Suggested shape:

```text
workbench: running
run: run_...
trace: .pi/workbench/traces/run_....jsonl
metrics: tools=3 errors=0 retries=1 rate_limits=0 tokens=12345 in=8000 out=3000 cache_read=1200 cache_write=145 reasoning=200 cost=$0.0123
warnings: metrics may be incomplete; trace writes degraded
```

Do not implement rich trace browsing, monitor widgets, or reports in this milestone.

## Testing

Tests must not use real model calls, network, provider credentials, or a real pi process.

Use:

- fake pi event emitter/extension harness
- fake session manager entries
- temp directories
- synthetic parent events
- assertions on JSONL trace and run metrics

Test layers:

1. Runtime unit tests call `WorkbenchRuntime.start()`, `detach()`, optional explicit `end()`, and `emit()` directly.
2. Parent observer tests use fake `pi.on` event registration, emit synthetic pi events, and inspect normalized trace output.
3. Extension wiring smoke tests use a minimal fake `ExtensionAPI` with `on`, `registerCommand`, `appendEntry`, fake `ctx.sessionManager`, and fake UI notification capture to verify `session_start`, `/observe status`, and `session_shutdown` wiring.

Avoid overbuilding a pi simulator.

Test cases should cover:

1. Runtime creates a new run on first `session_start` and appends a `workbench-runtime` link.
2. `run_start` and `runtime_attach` are persisted through the normal sink for a newly created run.
3. Runtime resumes an existing linked run on reload/resume from the same cwd or another cwd in the same repository, preserves `runId`/`traceId`, and emits `runtime_attach` without another `run_start`.
4. Invalid/missing linked run or missing/unreadable linked trace file fails soft, creates a new run, emits an error event, and marks `metricsMayBeIncomplete`.
5. `session_shutdown` emits `runtime_detach` once, updates run status to `detached`, and does not set ended time.
6. Synthetic prompt/turn/message/tool parent events persist as normalized observation events, including orphan update-before-end cases that reuse spans by stable message/tool ID.
7. Tool execution events map to `tool_start`/`tool_update`/`tool_end` and increment `toolCallCount` only on starts.
8. Parent usage totals update only via explicit `usage` events, not lifecycle events carrying usage.
9. Unknown usage metrics remain `undefined`, not `0`.
10. Parent observer works with no subagent/delegation modules enabled.
11. `/observe status` reports the current run, includes a concise token/cost breakdown for known usage fields, and includes incomplete-metrics warning when flagged.
12. Trace write failures in parent observer handlers do not throw into pi, set degraded runtime status, and notify at most once.
13. README documents how to load the extension, where traces are written, and the runtime attach/detach status semantics.

## Suggested Implementation Sequence

1. Add `src/runtime/workbench-runtime.ts` with runtime link types, status type, sink implementation, `start()`, `detach()`, optional explicit `end()`, and `getStatus()`.
2. Add runtime unit tests for core contract adjustments, new-run creation, lifecycle events, resume via persisted link, resume from a nested cwd in the same repository, missing trace-file recovery, warning persistence, and duplicate start/end guards.
3. Add `src/observability/parent-observer.ts` with a small `registerParentObserver(pi, sink/runtime)` function and pure normalization helpers.
4. Add parent observer tests using a fake pi emitter and synthetic event payloads.
5. Add `src/extensions/workbench.ts` that wires runtime, parent observer, session lifecycle, persisted link append, and `/observe status`.
6. Update `README.md` with concise user-facing loading/observability/status documentation.
7. Add barrel exports in `src/runtime/index.ts`, `src/observability/index.ts`, and update root exports only for implemented public APIs.
8. Run `npm test` and keep the milestone limited to runtime + parent observability.

An independent implementation agent should not need to create another feature plan before coding this milestone; this file is intentionally implementation-ready.

## Acceptance Criteria

- `npm test` passes offline.
- Loading `src/extensions/workbench.ts` and receiving `session_start` creates or resumes one shared parent run.
- A new session with no prior workbench link creates a run and appends a `workbench-runtime` custom entry.
- Reload/resume of the same pi session reuses the persisted workbench run when the linked run and trace file are readable, including from another cwd under the same repository/storage root.
- Invalid persisted linkage fails soft, creates a replacement run, records an error/incomplete-metrics marker, and does not break startup.
- `run_start` is persisted through the normal sink only when a run is first created.
- `runtime_attach` is persisted through the normal sink on first creation and resume/reload.
- `runtime_detach` is persisted on `session_shutdown` through the normal sink, updates run status to `detached`, and does not finalize the run or set `endedAt`.
- Synthetic parent prompt/turn/message/tool events persist as normalized observation events.
- Parent usage totals update only via explicit `usage` events.
- Parent observability works with no subagent/delegation modules enabled.
- `/observe status` shows current run/trace details and warns when metrics may be incomplete.
- README is updated as the user-facing landing page for implemented Milestone 02 behavior.
- Unknown metrics remain unavailable/undefined, not zero.
