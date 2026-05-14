# 00 — Principles and Guardrails

Read before every implementation phase.

## Architecture Rules

- Observability must work without subagents.
- Subagents are execution capability, not control policy.
- Delegation is opt-in parent-LLM control.
- Workflows/YAML are deferred for MVP.
- GUI dashboard is deferred for MVP.
- Recursive subagents are disabled by default.
- Unknown metrics are unavailable/undefined, not zero.
- Tests must not require network, provider credentials, or real model calls.

## MVP Scope

MVP phases:

1. core trace foundation
2. parent observability
3. subagent runner + agents + simple model/IQ
4. delegation MVP
5. minimal TUI monitor
6. hardening/demo

MVP includes:

- durable JSONL traces and run summaries
- CLI/env/config-driven metrics export for headless observability
- parent-session observability
- new-conversation handoff with durable lineage records
- process-based child pi runner
- basic markdown agent definitions
- simple model/IQ mapping
- opt-in `subagent` tool
- single-level subagents only
- parallel independent subagent tasks with bounded concurrency
- minimal TUI progress/status monitor

MVP excludes:

- chain workflow schema
- YAML workflow engine
- GUI dashboard
- SDK child-agent runner
- recursive subagents
- rich inspector/transcript browser
- HTML reports
- automatic fallback policy engine
- summary/recent/selected subagent context modes
- current-conversation replacement handoff

## Control Defaults

Default state:

```text
observability: enabled when extension is loaded
subagent manual commands: allowed after implemented
delegation tool: disabled until /delegation on
prompt injection: disabled until /delegation on
recursive subagents: disabled
project agents: disabled or confirmation-required
automatic fallback: disabled unless explicitly configured
```

Manual and parent-observability-only modes must not expose a `subagent` tool to the parent LLM.

## Context Defaults

MVP context modes:

- `fresh`: default; child gets agent prompt + task text only.
- `full`: explicit; include serialized parent context/conversation and record this in trace metadata.

Do not implement `summary`, `recent`, or `selected` context modes in MVP unless explicitly asked.

## Package Strategy

Use one package repo:

```text
~/sw/code/pi-agent-workbench
```

Use multiple internal modules and extension entrypoints, not multiple npm packages.

Recommended layout:

```text
src/
  core/
  observability/
  subagents/
  delegation/
  ui/
  extensions/
  test-fixtures/
```

## Config Strategy

Global defaults:

```text
~/.pi/agent/workbench/config.json
```

Project overrides:

```text
<project>/.pi/workbench/config.json
```

Project config wins over global config.

## Schema Version Strategy

- Writers should write `schemaVersion: 1`.
- Readers must treat missing `schemaVersion` as `1`.

## Identity Strategy

MVP:

- one shared workbench observation run per pi session start/resume
- observability, delegation, subagent, and monitor events for that parent session write into the same run/trace
- `traceId` equals `runId` unless explicitly overridden
- parent turns, tool calls, subagents, errors, rate limits, and fallbacks are events/spans inside that run
- runtime attach/detach can occur multiple times inside the same resumable run across pi reload/quit/resume; attach/detach is distinct from logical run start/end

IDs:

| ID | Meaning |
|---|---|
| `sessionId` | pi session UUID |
| `runId` | workbench observation run |
| `traceId` | correlation graph, same as runId for MVP |
| `spanId` | operation ID |
| `parentSpanId` | lineage parent |
| `agentId` | one subagent invocation |

## Persistence Strategy

Default project-local files:

```text
.pi/workbench/runs/<run-id>.json
.pi/workbench/traces/<run-id>.jsonl
```

Large payloads should later use artifact files, not giant JSONL events.

## Testing Strategy

Do not depend on real LLMs.

Use:

- temp directories
- synthetic pi events
- fixture JSONL streams
- fake child processes
- fake model registry
- pure reducers and normalizers
- snapshot/fixture tests for render state

Real provider smoke tests are optional and must not be required for normal verification.
