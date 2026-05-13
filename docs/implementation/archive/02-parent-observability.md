# 02 — Parent Observability

## Goal

Add a pi extension that observes normal pi sessions and persists events/metrics using Phase 1.

## Non-Goals

- No subagents.
- No delegation tool.
- No rich TUI.
- No workflows.

## Outputs

Normal user/demo loading should use one cohesive workbench extension entrypoint that includes parent observability:

```text
src/extensions/workbench.ts
```

Thin/dev entrypoints may still exist for isolated testing:

```text
src/extensions/observability.ts
src/observability/*
```

## Required Behavior

- Create/open one observation run per pi session start/resume.
- Persist parent events to trace store.
- Capture assistant usage when available.
- Capture cache read/write tokens when available.
- Capture cost when available.
- Capture context usage when available.
- Capture context compaction lifecycle metrics when pi makes them available (for example via pi extension `session_before_compact`/`session_compact` hooks, or JSON-mode `compaction_start`/`compaction_end` events):
  - compaction attempts/starts
  - completed compactions
  - aborted compactions
  - compaction errors
  - trigger reason (`manual`, `threshold`, `overflow`) when available
  - `tokensBefore`, `firstKeptEntryId`, `willRetry`, and `fromExtension` when available
- Capture tool lifecycle counts.
- Capture errors.
- Passively capture rate-limit events when detectable, e.g. HTTP 429 from provider response hooks.
- Flush on shutdown.

## Commands

```text
/observe status
```

Shows current run id, trace path, token/cache/cost/context totals when available, tool/error/rate-limit/fallback/compaction counts.

## Acceptance Criteria

- Works with no subagents installed/enabled.
- Normal pi prompt creates persisted trace events.
- `/observe status` works.
- Unknown fields display unavailable/undefined, not zero.
- Unit tests use synthetic events and temp trace store.
- Synthetic compaction start/end events update compaction metrics without requiring real model calls or triggering pi compaction.
