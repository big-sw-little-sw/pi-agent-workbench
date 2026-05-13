# 03 — Subagent Runner + Agents + Models

## Goal

Build the minimum subagent execution capability: process runner, basic agent definitions, simple model/IQ resolver.

## Non-Goals

- No SDK runner in MVP; keep the runner interface backend-neutral for a future SDK implementation.
- No recursive subagents.
- No chain API required.
- No delegation prompt/tool yet.
- No complex context builder.

## Outputs

```text
src/subagents/runner-process.ts
src/subagents/agent-definitions.ts
src/subagents/model-iq.ts
src/subagents/config.ts
src/test-fixtures/*
```

## Runner Behavior

Run child pi processes via JSON mode. The process runner is the MVP backend because it gives stronger isolation, straightforward abort/crash containment, and testability with fake child processes. Child stdio must be piped/ignored, never inherited, so child runs do not affect parent stdin/stdout/TUI. The runner should still sit behind the shared `SubagentRunner` contract so a future SDK runner can be added without changing delegation/UI code.

The core primitive runs one child; MVP should also provide a bounded parallel helper for independent child requests.

```bash
pi --mode json -p --no-session --model <model> --thinking <level> --tools <tools> ...
```

Pass reasoning effort as pi's first-class `--thinking` flag when selected. Valid MVP thinking levels are pi's levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

Requirements:

- parse child JSONL stdout
- capture stderr
- emit normalized `ObservationEvent`s to `ObservationSink`, using `subagent_start`/`subagent_end` for child run boundaries and generic message/tool/usage/error events with `source: "subagent"` for child internals
- aggregate final output/status/usage
- persist subagent final output inline when small; when oversized, write the full final output to `.pi/workbench/artifacts/<run-id>/<agent-id>/final-output.md` and store a truncated preview plus relative artifact path in `subagent_end.data`; default inline cap is configurable via `subagents.maxInlineFinalOutputBytes` and defaults to 32768 bytes
- support abort via `AbortSignal`
- preserve trace lineage with `parentSpanId`
- assign each child a globally unique `agent_<uuid>` id
- support bounded parallel execution for independent subagent requests; shared runner semantics are best-effort, return results in input order, and use aggregate statuses such as `completed`, `partial_failure`, `failed`, or `aborted`
- enforce `maxConcurrency` default, e.g. 2, configurable later
- mark child processes with an environment variable such as `PI_WORKBENCH_SUBAGENT_CHILD=1` so child sessions cannot recursively expose subagent controls
- spawn children with piped/ignored stdio, never inherited stdio; parent UI owns all terminal input/output
- run child pi with `--no-extensions` by default via `subagents.loadExtensions: false`; if enabled, recursion guard must still prevent subagent/delegation controls inside children
- run child processes in the same cwd as the parent/session for MVP
- run child processes with `--no-session` for MVP; the workbench trace is the durable/canonical record
- use temp files for large task/system prompt payloads rather than very long argv values
- enforce configurable default timeout via `subagents.defaultTimeoutMs`, defaulting to 600000 ms; timeout terminates the child and returns status `aborted` with an explanatory error message

## Manual Unnamed Subagents

MVP may support manual unnamed subagents as a user-controlled escape hatch through a separate `/subagent adhoc` command. This is separate from delegation: the model-callable `subagent` tool still requires named loaded agents.

Manual unnamed invocation provides task and explicit child prompt handling, with optional model/IQ/thinking/context/context-file choices. Use argument names that describe behavior clearly:

- `--append-system-prompt <text-or-file>` appends instructions to the child pi default system prompt.
- `--replace-system-prompt <text-or-file>` replaces the child pi default system prompt for this ad-hoc run.
- `--load-context-files` allows child pi to load normal context files such as AGENTS.md for this ad-hoc run.
- `--no-context-files` disables context-file loading explicitly.

If neither is provided, use a minimal generic appended child instruction. Named markdown agent bodies append to the child pi default system prompt by default; replacement for named agents is deferred unless explicitly needed.

It should emit events with `controlMode: "manual"` and agent metadata such as `agent.name: "adhoc"` or `data.unnamed: true`.

Recommended constraints:

- only exposed through manual command/API, not parent-LLM delegation
- no persistent agent definition is created
- no parent prompt catalog entry is injected
- default context is `fresh`
- context-file loading is separate from parent transcript context; named agents decide via frontmatter and manual ad-hoc runs decide via flags
- explicit `full`/fork context must be recorded in trace metadata
- parent model/thinking metadata should be recorded in trace for all subagent runs when available, but included in the child prompt only for `context: "full"`
- model selection uses the same model/IQ resolver as named agents
- explicit model strings should use pi model identifiers, including provider prefix when needed, e.g. `anthropic/claude-sonnet-4-5`
- if no model/IQ is specified, inherit the current parent/default model when available
- `tools` choices are strict allowlists; if omitted, use configured safe default subagent tools. Manual ad-hoc subagents use the same default precedence but may override tools explicitly with `--tools`.

## Agent Definitions

Minimum markdown frontmatter:

```md
---
name: scout
description: Find relevant files quickly.
iq: low
thinking: low
tools: read, grep, find, ls
---

System prompt body.
```

Support fields:

- `name`
- `description`
- `iq?`
- `model?`
- `thinking?` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`)
- `tools?` strict allowlist of child pi tools
- `systemPromptMode?` (`append` by default, or `replace`)
- `loadContextFiles?` (`false` by default; when true, child pi may load normal context files such as AGENTS.md)

MVP ships example agent markdown files for reference only, but does not auto-load package default agents and does not auto-copy examples into user/project directories. Users explicitly create, copy, or modify markdown agent files in configured discovery paths.

Discovery paths for MVP:

```text
<project>/.pi/workbench/agents/*.md
~/.pi/agent/workbench/agents/*.md
```

When enabled later, package defaults would have the lowest precedence. Effective precedence is:

```text
trusted project agents > global user agents > package defaults/examples
```

Duplicate names across source tiers are allowed and resolved by precedence. Duplicate names within the same source tier should produce a warning/conflict and not silently shadow unpredictably.

`systemPromptMode: replace` is allowed for project agents when `trustProjectAgents` is true; replacement does not require an additional MVP trust flag.

Project agents override global agents with the same name when project agents are trusted. MVP should support a simple config flag:

```json
{
  "agents": {
    "trustProjectAgents": true
  }
}
```

Project config lives at `<project>/.pi/workbench/config.json`; global config lives at `~/.pi/agent/workbench/config.json`; project config overrides global config. For MVP, `trustProjectAgents` may be set in project config for convenience, but this is weak trust because the repo can trust itself. Post-MVP should move toward user-controlled trusted project roots in global config.

Keep parsing permissive enough that future compatibility with community `.pi/agents/*.md` definitions is possible, but do not enable that path in MVP unless explicitly requested. Invalid agent markdown should be skipped with warnings rather than failing the entire catalog; `/subagent list` should surface invalid-agent warnings when present.

Defer complex fields such as memory, skills, worktree isolation, scheduling, steering defaults, prompt modes, context defaults, output files, and max-turn policy.

## Model/IQ/Thinking Resolution

Simple config supports either string model values or structured model/thinking values:

```json
{
  "modelIQ": {
    "fallback": "anthropic/claude-sonnet-4-5",
    "defaultIq": "medium",
    "levels": {
      "low": "anthropic/claude-haiku-4-5",
      "medium": {
        "model": "anthropic/claude-sonnet-4-5",
        "thinking": "medium"
      },
      "high": {
        "model": "anthropic/claude-opus-4-5",
        "thinking": "high"
      }
    }
  }
}
```

`iq` is the workbench's abstract quality/cost tier. `thinking` is pi/provider reasoning effort and should be passed to child pi as `--thinking <level>`.

Recommended model precedence:

1. request `model`, if provided and allowed
2. agent `model`, if provided
3. request `iq`, resolved through config
4. agent `iq`, resolved through config
5. config `modelIQ.defaultIq`, resolved through config
6. config `modelIQ.fallback`
7. parent/default pi model, if available

For MVP, explicit concrete model requests fail fast if unavailable/disallowed; do not silently switch to another model. `modelIQ.fallback` is only a default model-selection fallback when no explicit concrete model was selected, not runtime rate-limit fallback automation. Do not add workbench-level retry/model-fallback policy in MVP. Preserve pi's built-in auto-retry by default via `subagents.usePiAutoRetry: true` by inheriting normal child pi retry settings, observe JSON events such as `auto_retry_start`/`auto_retry_end`, and mark the child failed if pi exhausts retries. Workbench should only override child retry behavior when configured and supported by pi CLI/settings. Map auto-retry starts to `rate_limit` events only when the error message indicates rate limiting/429/too many requests; include retry attempt/max/delay in `data`. Other retryable errors should be recorded as errors or generic event data without incrementing fallback counts. If pi exhausts auto-retries, the subagent result status is `failed` with explanatory error details, not a new status. Workbench-level rate-limit fallback policies are post-MVP.

Recommended thinking precedence:

1. request `thinking`, if provided and allowed
2. agent `thinking`, if provided
3. thinking from the selected IQ level, if the level is structured
4. no explicit thinking flag; let pi/model defaults apply

If both `model` and `iq` are present on an agent, `model` selects the concrete model and `iq` is only a fallback/metadata for cases where the concrete model is overridden or disallowed. If both a concrete model string includes pi's `:<thinking>` shorthand and a separate `thinking` field is supplied, the separate `thinking` field wins after parsing/normalization.

Global config, project override:

```text
~/.pi/agent/workbench/config.json
<project>/.pi/workbench/config.json
```

Config parsing should warn on unknown fields but continue loading. Warnings should be visible through relevant status/list commands where practical. Config and agent catalogs are loaded at extension startup/reload; users should use normal pi `/reload` after editing config or agent markdown in MVP.

## Context MVP

Support two explicit context modes:

| Mode | Behavior |
|---|---|
| `fresh` | Default. Child receives agent prompt + task text only. Parent/user/parent LLM includes needed context inside the task. This corresponds to a new child session with no automatic parent transcript fork. |
| `full` | Include serialized parent context/conversation when the caller explicitly requests it. This is the MVP equivalent of community `inherit_context`/`fork`; it is costly/noisy and must be recorded in trace metadata. Parent conversation should be serialized as a markdown transcript with compact tool summaries rather than raw huge tool outputs. |

Do not implement `summary`, `recent`, `selected`, `fork` aliases, or agent-default context inheritance yet. Agent frontmatter must not set context defaults in MVP; context is `fresh` unless explicitly requested per run and allowed by policy.

Precedence/policy decisions around model, thinking, tools, prompt mode, context files, and context mode must be documented in user-facing docs and kept tersely commented in code at the resolver/policy boundaries.

The runner itself should accept already-built task/system prompt content. Parent-context extraction can live in delegation/manual integration where pi session context is available.

## Community References for Planning Agents

Review these implementations before coding, but use this phase file and `00-contracts-and-boundaries.md` as authoritative:

- https://github.com/nicobailon/pi-subagents — primary reference for MVP process execution. Useful files/ideas: `src/runs/shared/pi-args.ts` for `pi --mode json -p` argument construction, recursion guard env vars, temp prompt/task files; `src/runs/foreground/execution.ts` and `src/runs/background/subagent-runner.ts` for JSONL process handling; `test/support/mock-pi*` and process tests for fake-runner patterns; `agents/*.md` for practical named-agent prompts.
- https://github.com/tintinweb/pi-subagents — reference for SDK/session-runner tradeoffs and UX/config ideas. Useful files/ideas: `src/agent-runner.ts` for `createAgentSession` runner shape, event subscription, max-turn handling, and tool filtering; `src/custom-agents.ts` and `src/default-agents.ts` for agent frontmatter/default-agent design; `src/ui/agent-widget.ts` for later monitor inspiration.

Borrow small patterns only. Do not import their architecture wholesale. Specifically avoid chain execution, async/background persistence, scheduling, intercom/RPC, worktree isolation, steering/resume, memory scopes, conversation viewers, and always-on model-callable tools in Phase 3.

## Manual Commands

Minimum:

```text
/subagent list
/subagent run <agent> <task>
/subagent adhoc <task> [--append-system-prompt ...|--replace-system-prompt ...] [--model ...|--iq ...] [--thinking ...] [--tools ...] [--context fresh|full] [--load-context-files|--no-context-files]
```

`/subagent list` should show loaded agent names, descriptions, source, and concise key effective settings such as IQ/model/thinking, tools allowlist, system prompt mode, and context-file loading. If project agents exist but are untrusted, show them separately as unavailable with an actionable note about `agents.trustProjectAgents`. Show `/reload` guidance when useful, such as no agents loaded, untrusted/invalid agents, or config warnings; do not always print reload noise.

Manual command output should provide minimal live progress plus a final structured result. If no named agents are loaded, named `/subagent run` should fail with actionable guidance and example paths; no implicit generic named agent is created.

## Acceptance Criteria

- Fixture child JSONL stream parses without real model calls.
- Fake child process tests pass.
- Loads fixture agent markdown.
- Resolves model/IQ/thinking precedence, including structured IQ levels.
- Can run one child subagent manually from code-level test or helper.
- Can run two fixture subagents concurrently with bounded concurrency.
- Context mode is accepted and recorded; `fresh` works without parent session access.
