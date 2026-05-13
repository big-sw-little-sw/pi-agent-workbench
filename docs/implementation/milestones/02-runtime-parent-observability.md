# Milestone 02 — Shared Runtime + Parent Observability

## Goal

Create the shared workbench runtime/run manager and wire parent pi observability into the cohesive `workbench` extension.

This milestone should be implementable after reading `AGENTS.md`, the required implementation docs, Milestone 01, and this file.

## Depends On

- Milestone 01 core trace foundation.

## Scope

Implement:

- shared runtime/run manager
- one workbench observation run per parent pi session
- `src/extensions/workbench.ts` shell
- parent event subscriptions/normalization
- `/observe status` or similarly minimal status command if straightforward

Do not implement subagent execution, agent catalog loading, delegation, or rich UI in this milestone.

## Decisions

- Normal user/demo loading uses one cohesive extension: `src/extensions/workbench.ts`.
- Loading the extension creates/resumes one shared parent workbench run.
- Observability must work without subagents.
- Parent events persist into the same run/trace later used by subagents/delegation.
- `run_start` and `run_end` are persisted as trace events.
- The runtime manager emits `run_start`/`run_end` through the normal `ObservationSink`.
- `TraceStore.createRun()` must not implicitly append lifecycle events.
- Event-level `controlMode` is the source of truth; the run record control mode is only the default/initial mode.

## Runtime Responsibilities

The runtime manager owns:

- run initialization
- trace ID/run ID selection
- shared sink composition
- trace-store append calls
- live-state fanout later
- emitting `runtime` lifecycle events
- extension-level cleanup/end behavior when available

It must not own:

- subagent process spawning
- agent catalog policy
- delegation tool policy
- UI rendering internals

## Parent Observability

Capture parent-session events available from pi without requiring provider credentials or real model calls in tests.

Normalize to `ObservationEvent` where possible:

- parent turns: `turn_start`, `turn_end`
- model/message lifecycle: `message_start`, `message_update`, `message_end`
- tool calls: `tool_start`, `tool_update`, `tool_end`
- usage/cost: explicit `usage` events for aggregate totals
- errors: `error`
- rate limits/retries if exposed by parent pi events: `rate_limit`, `retry`
- compaction if exposed: `compaction`

Use `source: "parent"` for parent pi activity and `source: "runtime"` for workbench lifecycle/infrastructure events.

## Usage Rules

- Emit explicit `eventType: "usage"` events when totals should update.
- Do not rely on lifecycle events with `usage` to update persisted `RunMetrics`.
- Unknown token/cache/cost metrics remain unavailable/undefined.

## Extension Entry Point

`src/extensions/workbench.ts` should stay thin:

- create/load runtime
- register parent observability hooks
- register minimal commands implemented in this milestone
- leave module-specific logic in testable functions/classes

## Testing

Tests must not use real model calls or network.

Use:

- fake pi event emitters/harnesses
- temp directories
- synthetic parent events
- assertions on JSONL trace and run metrics

## Acceptance Criteria

- `npm test` passes offline.
- Loading the workbench extension creates one shared run.
- `run_start` is persisted through the normal sink.
- Synthetic parent events persist as normalized observation events.
- Parent usage totals update only via explicit `usage` events.
- Parent observability works with no subagent/delegation modules enabled.
