# Milestone 06 — Delegation MVP

## Goal

Allow the parent LLM to invoke named subagents through an opt-in, session-scoped delegation tool.

This milestone should be implementable after reading `AGENTS.md`, the required implementation docs, prior milestone docs as needed, and this file.

## Depends On

- Milestone 02 runtime/workbench extension.
- Milestone 03 config/catalog.
- Milestone 04 subagent runner.
- Milestone 05 manual command boundary decisions.

## Scope

Implement:

- `/delegation on`
- `/delegation off`
- `/delegation status`
- delegation prompt/catalog injection
- one generic model-callable `subagent` tool
- single and parallel delegated execution
- policy validation at tool-call time

Do not implement workflows/YAML, parent-LLM-created ad-hoc agents, recursive subagents, or workbench-level fallback policy.

## Core Decisions

- Subagents are execution capability, not control policy.
- Delegation is opt-in parent-LLM control.
- `/delegation on` is session-scoped.
- Startup config/flag may enable delegation.
- Delegation is invisible/off until enabled.
- `/delegation on` fails if no agents are loaded.
- Manual subagent commands remain independent of delegation.
- Delegation uses one generic model-callable `subagent` tool, not one tool per agent.
- Delegation tool uses named loaded agents only.
- Parent LLM ad-hoc agents are deferred post-MVP.
- Policy validation happens at tool-call time.

## Delegation Prompt/Catalog

Inject concise catalog guidance derived from frontmatter/metadata only.

Do not inject full child prompts into the parent LLM context.

Include:

- agent name
- description
- rough tool/model/IQ hints if useful
- context policy summary
- parallel mode constraints

Tool schema should use free-string agent names with catalog guidance and runtime validation rather than a generated enum.

## Delegation Tool

One model-callable tool, conceptually:

```ts
subagent({
  mode: "single" | "parallel",
  agentName?: string,
  task?: string,
  tasks?: Array<{ agentName: string; task: string }>,
  context?: "fresh" | "full"
})
```

Exact schema can vary, but it must support:

- single named subagent
- parallel independent named subagents
- bounded concurrency
- input-order results

No chain/workflow sequencing in MVP. The parent LLM may sequence dependent work through repeated tool calls.

## Context Policy

- Default context is `fresh`.
- Delegated `full` context is disabled by default via `delegation.allowFullContext: false`.
- If delegated full context is disallowed, reject at tool-call time with a clear error.
- Any `full` use must be trace-recorded.
- Agent frontmatter must not set context defaults.

Full context serialization matches Milestone 05:

- markdown transcript
- compact tool summaries
- cwd, parent model, parent thinking, date, runId, traceId, controlMode

## Tool/Agent Policy

Delegated named subagents may use tools/context-file settings from trusted agent frontmatter.

No extra dangerous-tools gate in MVP beyond catalog trust/tool allowlist decisions.

Project agents require `agents.trustProjectAgents: true` from Milestone 03.

Subagents remain single-level; child agents cannot spawn subagents.

## Parallel Semantics

- Parallel mode is for independent tasks.
- Bounded concurrency.
- Best-effort: one failure does not abort all others.
- Results returned in input order.
- Aggregate status can be `completed`, `partial_failure`, `failed`, or `aborted`.
- Tool result returns concise structured wrapper plus each child final output/status/usage.
- Do not return full child transcripts by default.
- If final output is truncated, include artifact path when available.

## Events

Use shared runtime sink and trace.

Use `controlMode: "llm-delegated"` for delegated tool execution and child runs initiated by it.

Avoid double-emitting the same delegated tool call as both parent and delegation `tool_start`. Emit exactly one metric-affecting `tool_start` for the delegated subagent tool call.

Child runner still emits `subagent_start`/`subagent_end` and child internals with `source: "subagent"`.

## `/delegation status`

Show concise effective policy:

- enabled/disabled
- loaded agent count
- whether project agents are trusted
- full context allowed/disallowed
- max parallel/concurrency if configured
- default context

## Testing

Use mock runner and fixture catalog.

No real pi/model calls.

Test:

- delegation off means no model-callable tool exposed
- `/delegation on` fails with no loaded agents
- named-agent validation at tool-call time
- full context disallowed by default
- single delegated run
- parallel delegated runs with bounded concurrency and input-order results
- manual commands remain independent

## Acceptance Criteria

- `npm test` passes offline.
- Delegation is invisible/off until enabled.
- `/delegation status` reports effective policy concisely.
- Delegated tool runs single and parallel named subagents using mock runner tests.
- Invalid agent/context policy errors are clear and do not crash the parent session.
