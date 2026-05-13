# 99 — Stretch and Post-MVP Goals

Do not implement these in MVP unless explicitly asked.

## Post-MVP Direction

Eventual goal: a general agent workflow/workbench platform for observing, orchestrating, comparing, and improving agentic workflows.

MVP target remains narrower: parent observability plus usable subagent execution/delegation.

Design notes to preserve:

- Workflow specs/graphs are the source of intended execution/control flow.
- Observation events are the source of actual execution/history.
- Workflow run state should become a projection/cache derived from events.
- Post-MVP persistence should move toward events plus cached snapshots: traces remain canonical, snapshots speed UI/resume/reporting.
- Post-MVP delegation should investigate cache-aware task-scoped delegation, possibly by running bounded delegated tasks in isolated side sessions instead of mutating the main parent session prompt on/off.
- Post-MVP agent trust should move from project-self-trust toward user-controlled trusted project roots in global config.
- Post-MVP delegation may allow parent-LLM-created ad-hoc agents, but only behind explicit config/policy such as allowed tools, max IQ/model, context restrictions, and optional user approval.
- Post-MVP subagent runs may optionally save child pi sessions for native resume/fork/inspection, while keeping workbench traces canonical.
- Post-MVP subagent UX should revisit explicit cancellation commands such as `/subagent cancel <agentId>` and `/subagent cancel --all`.
- Post-MVP runner architecture should revisit process runner vs SDK/API runner behind the same `SubagentRunner` interface.
- Post-MVP child execution policy should consider controlled loading of extensions/custom tools inside subagents; MVP children should avoid direct terminal access and keep child tool exposure explicit.
- Post-MVP rate-limit handling should revisit workbench-level retry/fallback policies such as `ask`, `auto-same-iq`, and `auto-lower-iq`; MVP preserves pi's built-in auto-retry by default, records retry/rate-limit events when available, and does not switch models automatically.
- Post-MVP metrics should revisit whether durable `RunMetrics` should include subagent-specific counters such as `subagentCount`, `subagentCompletedCount`, and `subagentFailedCount`; MVP derives these from `subagent_start`/`subagent_end` events in projections instead.
- Post-MVP trace maintenance should revisit explicit repair tooling such as `TraceStore.repairRun()` or `/observe repair`, using the MVP pure recompute helper to rebuild mutable run summaries from canonical JSONL traces.
- Post-MVP cost modeling should explore whether `costUsd` remains sufficient or whether multi-currency/precision-safe cost fields are needed; MVP treats cost as USD-compatible summary data, not billing-ledger data.

## Context Controls

MVP supports:

- `fresh`: default; child receives agent prompt + task text only.
- `full`: explicit; include serialized parent context/conversation and record this choice in trace metadata.

Later policies:

- `summary`
- `recent`
- `selected`
- existing pi compaction summary
- LLM summarization

## Rate-Limit Fallbacks

MVP may passively record rate limits.

Later:

- `/observe rate-limits`
- `/observe fallbacks`
- `/subagent fallback ask|auto-same-iq|auto-lower-iq`
- human approval
- automatic fallback

## Parallel and Chain Subagents

MVP supports parallel independent subagent tasks with bounded concurrency.

Later:

- chain array schema
- richer parallel coordination
- cancellation/retry per parallel child

## Manual Commands

MVP optional:

- `/subagent list`
- `/subagent run`

Later:

- `/subagent show`
- `/subagent cancel`
- `/subagent logs`
- `/subagent config`

## Inspector

Later:

- `/observe open`
- timeline
- tree
- transcript
- metrics
- raw trace view

## HTML Report

Later static report from persisted traces.

## GUI Dashboard

Later local web dashboard after trace schema stabilizes.

## YAML Workflows

Later programmatic workflow engine.

## SDK Runner

Later child agent backend behind same runner interface.

## Recursive Subagents

Disabled by default. Later requires explicit max depth, child count, budget, tools, and model limits.
