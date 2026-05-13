# Milestone 04 — Process-Based Subagent Runner

## Goal

Implement the MVP child subagent runner and model/IQ resolution behind testable interfaces.

This milestone should be implementable after reading `AGENTS.md`, the required implementation docs, prior milestone docs as needed, and this file.

## Depends On

- Milestone 01 core events/types/sink.
- Milestone 03 config/catalog contracts for named agents and defaults.

## Scope

Implement:

- `SubagentRunner` interface implementation
- process-based child pi runner
- bounded parallel runner
- model/IQ resolver
- timeout handling
- final-output artifact handling
- fake-process tests

Do not implement manual `/subagent` commands or delegation tool UX in this milestone.

## Runner Contract

```ts
interface SubagentRunner {
  run(request: SubagentRunRequest, sink?: ObservationSink): Promise<SubagentRunResult>;
  runParallel?(
    requests: SubagentRunRequest[],
    options: { maxConcurrency: number },
    sink?: ObservationSink
  ): Promise<SubagentRunResult[]>;
}
```

```ts
type SubagentRunRequest = {
  runId: string;
  traceId: string;
  parentSpanId?: string;
  agentName: string;
  task: string;
  cwd: string;
  model?: string;
  iq?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools?: string[];
  systemPrompt?: string;
  context?: "fresh" | "full";
  timeoutMs?: number;
  signal?: AbortSignal;
};
```

```ts
type SubagentRunResult = {
  agentId: string;
  agentName: string;
  status: "completed" | "failed" | "aborted";
  finalOutput?: string;
  errorMessage?: string;
  usage?: UsageBreakdown;
  startedAt: number;
  endedAt: number;
  events?: ObservationEvent[];
};
```

Runner emits to optional `ObservationSink`; extension/runtime owns persistence.

## Process Runner Decisions

- Child runner is subprocess-based for MVP, not SDK.
- Child process uses `pi --mode json -p --no-session`.
- Child stdio must be piped/ignored, never inherited.
- Child cwd is same as parent/session.
- Child extensions disabled by default via `subagents.loadExtensions: false`.
- Preserve pi built-in auto-retry by default via `subagents.usePiAutoRetry: true`.
- No workbench-level model fallback/retry policy in MVP.
- If pi exhausts retries, subagent status is `failed`.
- Timeout status is `aborted`.
- Default timeout is `subagents.defaultTimeoutMs = 600000`.

## Recursion Guard

Subagents are single-level in MVP.

Guard recursion via environment such as:

```text
PI_WORKBENCH_SUBAGENT_CHILD=1
```

Child agents must not spawn subagents.

## Events

Emit at minimum:

- `subagent_start`
- child `message_*`/`tool_*`/`usage`/`error` events when parseable from pi JSON
- `rate_limit` and `retry` when pi auto-retry events are observed
- `subagent_end`

For pi `auto_retry_start` caused by rate limit, emit both:

- `rate_limit`
- `retry`

Keep `rateLimitCount` separate from retry metrics.

Use explicit `usage` events to update aggregate metrics.

## Model/IQ Decisions

Explicit concrete model unavailable/disallowed fails fast.

`modelIQ.fallback` is selection fallback only, not runtime model fallback.

No workbench-level runtime model fallback in MVP.

Resolution precedence:

1. request model
2. agent model
3. request IQ
4. agent IQ
5. default IQ
6. fallback model
7. parent/default model

Thinking precedence:

1. request thinking
2. agent thinking
3. selected IQ-level thinking
4. pi/model default

## Context Decisions

MVP context modes:

- `fresh`: default; child receives agent prompt + task text only.
- `full`: explicit; serialized parent context/conversation.

Any `full` use must be trace-recorded.

Full context serialization details are finalized in later manual/delegation integration, but runner request must preserve the chosen context mode in events/metadata.

## Parallel Semantics

- Parallel mode runs independent subagents concurrently with bounded concurrency.
- Best-effort: one child failure does not abort other children.
- Return results in input order, not completion order.
- Each child gets its own `agentId` and span.
- The parent parallel call/span is `parentSpanId` of each child.
- Aggregate status for callers can be derived as `completed`, `partial_failure`, `failed`, or `aborted`; individual runner results remain per-child `completed`/`failed`/`aborted`.

## Artifacts

Oversized final output goes to:

```text
.pi/workbench/artifacts/<run-id>/<agent-id>/final-output.md
```

`subagent_end` should include preview/path metadata in `data` when artifacted.

Keep JSONL events reasonably small.

## Testing

Tests must not spawn real pi or call real models.

Use:

- fake child process adapter
- fixture JSONL streams/stdout chunks
- fake timers/signals where useful
- temp directories for artifacts

## Acceptance Criteria

- `npm test` passes offline.
- Runner builds the expected child command/options without inherited stdio.
- Timeout aborts the child and returns status `aborted`.
- Explicit unavailable/disallowed model fails fast.
- Pi retry/rate-limit fixture events map to separate `rate_limit` and `retry` events.
- Parallel runner respects concurrency and returns input-order results.
- Oversized output is artifacted and referenced in `subagent_end`.
