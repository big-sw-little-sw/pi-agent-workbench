# 01 — Clean-Slate MVP Reimplementation

## Goal

Reimplement the MVP as a cohesive workbench vertical slice using the design decisions captured in the implementation docs.

This phase supersedes the current `src/`, `tests/`, and generated `dist/` artifacts. Keep the docs; rebuild code around the updated contracts.

## Reset Scope

Delete/rewrite:

```text
src/
tests/
dist/
```

Keep:

```text
docs/
AGENTS.md
README.md
package.json
tsconfig.json
```

Existing code may be used as reference, but the new structure should not preserve old coupling or phase artifacts by inertia.

## Main Entry Point

Normal user/demo loading uses one cohesive extension:

```text
src/extensions/workbench.ts
```

It wires:

- shared workbench run/runtime manager
- parent observability
- manual `/subagent ...` commands
- optional `/delegation ...` commands and model-callable `subagent` tool
- minimal status/live-state projection

Thin module-specific entrypoints may exist for development/testing only and should document degraded traces when loaded alone.

## Required Architecture

Use the updated contracts and principles:

- One shared workbench observation run per parent pi session.
- Observation events are the canonical execution history.
- Workflow graphs are future execution plans/projections, not MVP runtime source of truth.
- `ObservationEvent`/`ObservationSink` is the integration boundary.
- Runner is sink-optional; extension/runtime owns persistence.
- Extension entrypoints stay thin.
- Tests must not require network, credentials, or real model calls.

## MVP Implementation Milestones

The clean-slate MVP is one cohesive product track, but it should be implemented in small reviewable milestones rather than one large change. Each milestone must keep tests offline and avoid pulling in later milestone behavior by inertia.

Detailed milestone specs live under `docs/implementation/milestones/`:

1. `milestones/01-core-trace-foundation.md` — event/types/ids/trace store/metrics, including `subagent_start`, `subagent_end`, and core tests.
2. `milestones/02-runtime-parent-observability.md` — runtime/run manager, one shared run per parent session, parent event persistence wired into `workbench.ts`.
3. `milestones/03-config-agent-catalog.md` — global/project config loading, project-agent trust gate, markdown agent discovery/validation/warnings.
4. `milestones/04-subagent-runner.md` — process-based child runner, model/IQ resolution, timeout/artifact handling, fake-process tests.
5. `milestones/05-manual-subagent-commands.md` — `/subagent list`, `/subagent run`, `/subagent adhoc`, progress/status output backed by shared events.
6. `milestones/06-delegation-mvp.md` — session-scoped `/delegation` commands, prompt/catalog injection, gated model-callable `subagent` tool, single/parallel mock-runner tests.
7. `milestones/07-live-state-monitor-hardening.md` — reducer/projections, concise status display, final offline validation/demo cleanup.

Archived component specs under `docs/implementation/archive/` may be used as references for each milestone, but this file, the milestone files, and the principles/contracts docs remain the active source of truth.

## Key MVP Decisions to Preserve

- Agents are named markdown definitions loaded from configured paths; examples are reference-only.
- Project agents require `agents.trustProjectAgents: true` in MVP.
- Delegation is opt-in and session-scoped; startup config/flag may enable it.
- `/delegation on` fails if no agents are loaded.
- Delegation tool uses named agents only; LLM-created ad-hoc agents are post-MVP.
- Manual `/subagent adhoc` supports unnamed user-controlled subagents.
- Child runner uses subprocess `pi --mode json -p --no-session` with piped/ignored stdio.
- Child runs use same cwd as parent for MVP.
- Child extensions disabled by default via `subagents.loadExtensions: false`.
- Context defaults to `fresh`; `full` is explicit and trace-recorded.
- Delegated `full` context disabled by default via `delegation.allowFullContext: false`.
- Named agent frontmatter does not set context defaults in MVP.
- Tool lists are strict allowlists.
- `systemPromptMode` supports `append` and `replace`; default `append`.
- Named markdown bodies append by default unless frontmatter says replace.
- Oversized final output uses `.pi/workbench/artifacts/<run-id>/<agent-id>/final-output.md`.
- Parallel runner semantics are best-effort, input-order results, bounded concurrency.
- Timeouts default to `subagents.defaultTimeoutMs: 600000`; timeout status is `aborted`.
- Preserve pi built-in auto-retry by default; observe retry/rate-limit events; no workbench-level model fallback in MVP.
- Explicit concrete model unavailable/disallowed fails fast.
- User-facing docs and terse code comments must explain precedence/policy boundaries.

## Resolved Core Implementation Decisions

- Known event types include `run_start`, `run_end`, turn/message/tool lifecycle events, `usage`, `rate_limit`, `retry`, `fallback`, `compaction`, `error`, `artifact`, `subagent_start`, and `subagent_end`; the event type remains open to future strings.
- `ObservationSource` includes `runtime` for workbench-owned lifecycle/infrastructure events.
- Keep `RunRecord.controlMode` as the run default/initial mode, but event-level `controlMode` is the source of truth for mixed manual/delegated sessions.
- Persist `run_start` and `run_end` in the trace as canonical history; `RunRecord` remains the mutable summary.
- The runtime manager emits `run_start`/`run_end` through the normal sink; `TraceStore.createRun()` only creates the initial record.
- `TraceStore` stores project-local traces at the git repository root when `cwd` is inside a git repo; explicit `baseDir` overrides this, otherwise fallback is `cwd/.pi/workbench`; `RunRecord` stores absolute original `cwd`, resolved `projectRoot` when available, actual `storageRoot`, and absolute `traceFile`.
- `TraceStore.appendEvent()` appends JSONL and updates persisted `RunRecord.metrics`; it should not emit additional events or own policy.
- Serialize `appendEvent()` operations in-process per store/run to avoid races from parallel subagents; cross-process locking is out of scope.
- `readTrace()` is tolerant: skip blank/invalid/structurally invalid lines and normalize missing `schemaVersion` to `1`.
- Minimal event validation requires string `runId`, `traceId`, `spanId`, `source`, `controlMode`, `eventType`, and numeric `timestamp`.
- `applyEventToMetrics()` returns a new metrics object rather than mutating its input.
- `RunMetrics` aggregates usage only from explicit `eventType: "usage"` events; other events may carry usage for display/detail but do not update totals.
- `toolCallCount` means total observed `tool_start` events across sources; bucketed parent/delegation/subagent counts belong in live-state projections.
- `retryCount` increments from retry-start events; `retryFailureCount` increments only when a retry event explicitly records failed/exhausted retry status.
- Keep subagent-specific counters out of MVP `RunMetrics`; derive them from `subagent_start`/`subagent_end` in projections.
- ID helpers should produce compact readable prefixed IDs such as `run_<timestamp>_<random>`, `trace_<timestamp>_<random>`, `span_<random>`, and `agent_<random>`; use `crypto.randomBytes()` suffixes rather than verbose UUIDs; runtime defaults `traceId` to `runId` for MVP.

## Acceptance Criteria

- `npm test` passes offline.
- Loading `src/extensions/workbench.ts` creates one shared parent run.
- Parent events persist without subagents.
- Manual subagent commands work with fake child runner tests.
- Delegation is invisible/off until enabled.
- Delegated tool can run single and parallel named subagents with mock runner tests.
- No parent stdin/stdout/TUI interference from child processes.
- Unknown metrics remain unavailable, not zero.
