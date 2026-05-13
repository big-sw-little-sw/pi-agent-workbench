# 04 — Delegation MVP

## Goal

Let the parent LLM call a gated `subagent` tool when explicitly enabled.

## Non-Goals

- No YAML workflows.
- No recursive subagents.
- No chain tool schema.
- No complex context inheritance beyond explicit `fresh` and `full` modes.

## Outputs

Normal user/demo loading should use the cohesive workbench extension entrypoint so parent and child events share one run/trace:

```text
src/extensions/workbench.ts
```

Delegation internals and optional thin/dev entrypoint:

```text
src/extensions/delegation.ts
src/delegation/tool.ts
src/delegation/prompt.ts
src/delegation/policy.ts
```

## MVP Execution Shape

Single-level: child subagents cannot spawn further subagents.

The tool supports:

- `single`: one subagent task.
- `parallel`: multiple independent subagent tasks run concurrently with bounded concurrency.

No `chain` mode in MVP. The parent LLM may sequence dependent work through repeated tool calls over multiple turns/tool calls.

## Required Safety Behavior

When delegation is off:

- no active model-callable `subagent` tool
- no subagent catalog in parent system prompt
- no delegation guidance

When `/delegation on` is requested and no agents are loaded, fail fast with an actionable message instead of activating an empty tool/catalog. Otherwise, `/delegation on` should stay simple: activate delegation and validate per-request policy at tool-call time rather than prevalidating all possible agent/request combinations.

When delegation is on:

- activate/register one generic model-callable `subagent` tool, not one tool per agent
- inject concise agent catalog and policy
- build the injected catalog from agent definition frontmatter/metadata, not full child system prompts
- enforce recursion disabled
- delegated named subagents may use the strict tool allowlist and context-file loading setting from their trusted agent frontmatter/config; no extra MVP dangerous-tools/context-file gate is required beyond enabling delegation and trusting/choosing the agent
- enforce allowed agents/tools/IQ/thinking where configured

Unlike community subagent extensions that expose a model-callable tool immediately after install/load, this workbench must keep parent-LLM delegation opt-in. Loading observability or the Phase 3 runner must not make `subagent` visible to the parent model.

## Tool Shape MVP

Single:

```json
{
  "agent": "scout",
  "task": "Find relevant auth files. Context: ...",
  "iq": "low",
  "model": "optional explicit model",
  "thinking": "optional explicit pi thinking level",
  "context": "fresh"
}
```

Parallel:

```json
{
  "tasks": [
    { "agent": "reviewer", "task": "Review auth for security issues", "iq": "high", "thinking": "high" },
    { "agent": "reviewer", "task": "Review auth for correctness and regressions", "iq": "high" }
  ],
  "maxConcurrency": 2,
  "context": "fresh"
}
```

Context:

- `fresh` default: agent prompt + task text only. The parent LLM must put needed context in the task string.
- `full`: include serialized parent context/conversation. Explicit only; equivalent to community `inherit_context`/`fork`; record in trace metadata. Delegated `full` context should require explicit policy/config opt-in; manual full context is allowed by explicit user request.
- Agent frontmatter must not default context to `full` in MVP.
- Delegated `full` context is disabled by default via `delegation.allowFullContext: false`; enabling it is an explicit user/project policy choice.

Precedence/policy decisions must be documented for users and tersely commented in code at the tool/policy boundary.

## Parent LLM Sequencing

No chain API is needed initially. For dependent work, the parent LLM can call:

1. `subagent({agent: "scout", ...})`
2. read result
3. `subagent({agent: "reviewer", task: "Using scout findings: ..."})`

For independent work, parent LLM can use parallel mode, e.g. two reviewers with different review criteria.

## Commands and Startup State

```text
/delegation on
/delegation off
/delegation status
```

`/delegation status` should show a concise effective policy summary, including on/off state, source (`command`, `config`, or `flag`), model-callable tool active/inactive, loaded agent names, context default, whether full context is allowed, and max concurrency.

Delegation is session-scoped for MVP. It may be enabled either manually with `/delegation on` or at startup through configuration/CLI flag support when available. `/delegation status` must report the effective state regardless of how delegation was enabled.

Recommended startup controls:

- config field such as `delegation.enabledByDefault` for global/project defaults
- extension CLI flag such as `--workbench-delegation` for one-off sessions, if pi extension flags are available

Manual `/subagent ...` commands remain independent from delegation. They use manual control mode and must not require `/delegation on`.

## Community References for Planning Agents

Review these implementations for tool UX and policy pitfalls, but keep this phase's opt-in safety model authoritative:

- https://github.com/nicobailon/pi-subagents — reference for a `subagent` tool shape supporting single/parallel/chain/management. Borrow single/parallel result summarization and recursion-guard ideas; do not implement chain, async management, intercom, or default always-on delegation in MVP.
- https://github.com/tintinweb/pi-subagents — reference for Claude Code-style `Agent`, `get_subagent_result`, and `steer_subagent` tooling. Borrow concise catalog/tool-description ideas; do not expose multiple tools, background steering/resume, or always-on delegation in MVP.

## Acceptance Criteria

- Parent cannot see/call subagent tool when delegation is off.
- Prompt injection happens only when delegation is on.
- Tool runs one child subagent in single mode.
- Tool runs multiple independent child subagents in parallel mode with bounded concurrency.
- Parallel results are returned in input task order, not completion order.
- Parallel mode is best-effort for independent tasks: one child failure does not abort other children. Return explicit aggregate status such as `completed`, `partial_failure`, `failed`, or `aborted`.
- Tool result returns a concise structured wrapper plus each child final output and usage/status; it does not return full child transcripts by default.
- When child final output is truncated in the returned result, include the relative artifact path for the full output when available.
- Tests can use mock runner/catalog.
