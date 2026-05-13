# Pi Agent Workbench Plan

This repo contains planning docs for the clean-slate MVP reimplementation of `pi-agent-workbench`.

## Core Separation

```text
observability  = metrics, traces, persisted runs, UI
subagents      = execution capability
delegation     = optional parent-LLM control
workflows      = later YAML/programmatic control
workbench      = later comparison/benchmark/reporting
```

Subagent existence must not imply LLM control.

## Active MVP Plan

The old phased implementation track has been archived. The active plan is:

```text
docs/implementation/01-clean-slate-mvp-reimplementation.md
```

Archived component specs live in:

```text
docs/implementation/archive/
```

They are historical/reference material only.

## Key MVP Simplifications

- One cohesive `src/extensions/workbench.ts` entrypoint for normal use.
- One shared workbench observation run per parent pi session.
- Parent observability is included in the workbench extension.
- Subagents are single-level; child agents cannot spawn subagents.
- Manual `/subagent run` and `/subagent adhoc` are user-controlled.
- Delegation is opt-in and session-scoped.
- The delegated `subagent` tool supports single and parallel modes.
- Parallel mode is for independent tasks and returns best-effort input-order results.
- No YAML/workflow engine in MVP.
- Context supports explicit `fresh` and `full` modes only.
- `fresh` is default; delegated `full` requires policy opt-in.
- Minimal live-state/status projection remains in MVP.

## Required Reading for Implementation

1. `AGENTS.md`
2. `docs/implementation/00-principles.md`
3. `docs/implementation/00-contracts-and-boundaries.md`
4. `docs/implementation/01-clean-slate-mvp-reimplementation.md`

Use `docs/agent-workbench-design.md` as long-form reference only.

## Manual Loading Later

```bash
pi --no-extensions \
  -e ~/sw/code/pi-agent-workbench/src/extensions/workbench.ts
```

Project-local symlinks under `.pi/extensions/` can be used for `/reload` support.
