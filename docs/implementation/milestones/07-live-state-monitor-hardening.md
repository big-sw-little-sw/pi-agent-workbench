# Milestone 07 — Live State, Minimal Monitor, and Hardening

## Goal

Add the small live-state projection used by status/manual progress/minimal monitoring, then harden the MVP for demo and validation.

This milestone should be implementable after reading `AGENTS.md`, the required implementation docs, prior milestone docs as needed, and this file.

## Depends On

- Milestones 01–06.

## Scope

Implement:

- shared live-state reducer/projection from `ObservationEvent`
- concise status/progress rendering helpers
- minimal TUI/progress monitor if supported cleanly by pi extension APIs
- final hardening, docs cleanup, offline validation

Do not implement rich inspector, transcript browser, GUI dashboard, HTML reports, workflows/YAML, or explicit cancellation commands.

## Live-State Decisions

Use a shared live-state reducer/projection from `ObservationEvent`.

Consumers where practical:

- manual subagent progress
- `/observe status`
- `/delegation status` summaries where useful
- minimal monitor/status UI

Core trace events remain canonical. Live state is a projection/cache only.

## Metrics Display

Show usage buckets where available:

- parent usage
- subagent usage
- total usage
- per-subagent usage

Unknown metrics are unavailable, not zero.

Combined totals with unknown parts should display lower-bound/partial values, e.g. `$0.05+`.

Partial semantics live in projections/rendering, not core `RunMetrics`.

`RunMetrics.toolCallCount` is total observed `tool_start` across all sources. UI must not label it as parent-only.

Live-state should derive bucketed counts:

- parent tool calls
- delegation tool calls
- subagent tool calls
- per-agent tool calls

Subagent counts/statuses are derived from `subagent_start`/`subagent_end`; they are not stored in MVP `RunMetrics`.

Milestone 03-1 metrics export intentionally includes only aggregate `RunMetrics` plus run metadata/warnings. If exported reports later need subagent counts or richer activity summaries, source them from this live-state projection rather than adding subagent-specific counters to core `RunMetrics`.

## Minimal Monitor

Keep it small and low-risk.

Useful information:

- run id/status
- current parent turn/activity when available
- active/completed/failed/aborted subagents
- per-subagent status and concise current activity
- parent/subagent/total usage where available
- error/rate-limit/retry counts

Avoid:

- conversation viewers
- transcript browsers
- expandable result boxes
- async job managers beyond existing runner behavior
- direct runner coupling

The monitor consumes observation events/live state only.

## Hardening

Verify:

- extension entrypoints are thin
- tests are offline
- no network/provider credentials required
- child process stdio is never inherited
- unknown metrics remain undefined/unavailable
- project-agent trust behavior is documented
- delegation is off/invisible until enabled
- subagents are single-level guarded
- oversized outputs use artifacts
- no post-MVP features slipped in

## Demo Path

Manual loading target:

```bash
pi --no-extensions \
  -e ~/sw/code/pi-agent-workbench/src/extensions/workbench.ts
```

Expected MVP demo:

1. load workbench extension
2. observe parent run creation
3. list available agents/warnings
4. run manual subagent with fake or safe local behavior where possible
5. enable delegation
6. invoke delegated single/parallel subagents with mock/test path or documented manual path
7. view concise status/monitor output

## Testing

Use fixture event streams and pure reducer tests.

Test:

- parent/subagent/total usage buckets
- unknown/partial metric rendering
- subagent lifecycle projection
- retry/rate-limit/error counts
- per-agent tool counts
- export/report-oriented projection helpers remain separate from core `RunMetrics`
- out-of-order or missing end-event tolerance where reasonable

## Acceptance Criteria

- `npm test` passes offline.
- Live-state reducer is pure/tested.
- Minimal status/monitor consumes events/projection, not runner internals.
- Unknown/partial metrics render correctly.
- Final MVP does not include workflow/YAML/GUI/report/post-MVP features.
