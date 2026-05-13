# 06 — Hardening and Demo

## Goal

Integrate MVP modules into a usable demo.

## Scope

- parent observability
- trace store
- process subagent runner
- basic agents/model IQ
- delegation MVP
- minimal monitor
- optional minimal manual commands

## Non-Goals

- No YAML workflow engine.
- No GUI dashboard.
- No recursive subagents.
- No rich inspector/report unless everything else is done.

## Optional Manual Commands

If time allows:

```text
/subagent list
/subagent run <agent> <task>
```

## Demo Agents

Add simple package/user agents:

- scout
- reviewer
- planner if easy
- worker only if write-tools safety is acceptable

## Demo Scenario

1. Start pi with observability, subagents, delegation.
2. `/delegation on`
3. Ask parent LLM: use scout to inspect code, then use reviewer on findings.
4. Parent calls subagent tool once or more.
5. Minimal monitor shows progress.
6. Trace files persist parent and child events/metrics.
7. `/observe status` shows totals.

## Manual Loading

```bash
pi --no-extensions \
  -e ~/sw/code/pi-agent-workbench/src/extensions/observability.ts \
  -e ~/sw/code/pi-agent-workbench/src/extensions/delegation.ts
```

Add subagents extension too if manual commands are implemented.

## Acceptance Criteria

- MVP demo works end-to-end.
- Delegation off means no subagent tool/prompt.
- Delegation on allows one-child-at-a-time subagent calls.
- Parent and child metrics persist in trace.
- Monitor displays useful progress.
