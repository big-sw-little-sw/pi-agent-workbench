# 05 — Minimal TUI Monitor

## Goal

Show enough live progress to understand what parent/subagents are doing.

## Non-Goals

- No full inspector.
- No transcript browser.
- No HTML report.
- No GUI.

## Outputs

```text
src/ui/monitor-state.ts
src/ui/status.ts
src/ui/widget.ts
```

## Required Behavior

Use a small shared live-state reducer/projection from observation events. Manual subagent progress, `/observe status`, and the minimal monitor should consume this reducer where practical. UI must not depend directly on runner internals.

Show:

- current run id/title
- parent-only metrics when no subagents
- running/done/failed subagent counts
- current subagent activity
- latest tool/activity line
- token/cache/cost/context totals when available, similar to pi footer/status semantics
- separate parent usage, subagent usage, and combined total usage buckets, plus per-subagent usage where available
- combined usage totals must distinguish complete totals from partial/lower-bound totals when some components are unavailable; display partial known totals as lower bounds such as `$0.05+` or `at least $0.05`
- context compaction counts when available
- error/rate-limit/fallback counts

## Commands

Minimum:

```text
/observe monitor on
/observe monitor off
```

## Community References for Planning Agents

Use community UIs as inspiration only; this phase remains event-driven and minimal:

- https://github.com/tintinweb/pi-subagents — `src/ui/agent-widget.ts` shows useful compact activity lines: spinner/status, turn count, tool count, tokens, context percent, compaction count, and current activity.
- https://github.com/nicobailon/pi-subagents — `src/tui/render.ts`, `src/tui/render-helpers.ts`, and slash live-state files show foreground/async progress rendering and grouped parallel status.

Do not implement conversation viewers, transcript browsers, expandable result boxes, async job managers, or direct runner coupling in MVP. The monitor must consume `ObservationEvent`s only.

## Acceptance Criteria

- Works from synthetic events.
- Works with no subagents.
- Shows subagent progress when child events exist.
- Unknown metrics display as unavailable, not zero.
