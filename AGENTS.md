# pi-agent-workbench Agent Instructions

This repo implements the pi agent workbench package.

## Required Reading

Before implementing the MVP, read:

1. `docs/implementation/00-principles.md`
2. `docs/implementation/00-contracts-and-boundaries.md`
3. `docs/implementation/01-clean-slate-mvp-reimplementation.md`

Use `docs/agent-workbench-design.md` only as the full design reference.

## MVP Track

Active plan: `docs/implementation/01-clean-slate-mvp-reimplementation.md`

Earlier phase specs are archived under `docs/implementation/archive/` as historical/component references only.

Stretch goals live in `docs/implementation/99-stretch-goals.md`.

## Main Principles

- Simplicity is a guiding principle: keep code and design as simple as possible, but no simpler.
- Brevity is also a guiding principle: keep code outputs, document outputs, and agent messages concise.

## Current Strategy

- One package repo, multiple internal modules and pi extension entrypoints.
- Do not split into multiple npm packages for the MVP.
- Observability must work without subagents.
- Subagents are execution capability, not control policy.
- Delegation is opt-in parent-LLM control.
- Workflows/YAML and GUI dashboard are deferred.
- Tests must not require network, provider credentials, or real model calls.

## Implementation Rules

- Implement only the requested clean-slate MVP slice/task.
- Do not opportunistically implement post-MVP goals.
- Keep extension entrypoints thin.
- Prefer shared contracts and dependency injection over direct cross-module coupling.
- Use `ObservationEvent` and `ObservationSink` as the integration boundary.
- Unknown token/cache metrics are unavailable/undefined, not zero.
- Writers should write `schemaVersion: 1`; readers must treat missing schema version as `1`.

## MVP Simplifications

- Subagents are single-level: child agents cannot spawn subagents.
- Subagents are single-level: child agents cannot spawn subagents.
- The MVP `subagent` tool supports single and parallel modes.
- Parallel mode runs multiple independent subagents concurrently with a bounded concurrency limit.
- Chain/workflow sequencing is not in MVP; parent LLM may sequence work through repeated tool calls.
- MVP context supports explicit `fresh` and `full` modes.
- Default context is `fresh`: child receives agent prompt + task text only.
- `full` context is explicit, costly/noisy, and must be recorded in trace metadata.
- Minimal TUI progress monitor stays in MVP.
- Inspector/report/GUI/YAML workflows are stretch goals.

## Test Command

```bash
npm test
```

## Manual pi Loading Later

The clean-slate MVP should expose one cohesive workbench extension entrypoint:

```bash
pi --no-extensions \
  -e ~/sw/code/pi-agent-workbench/src/extensions/workbench.ts
```
