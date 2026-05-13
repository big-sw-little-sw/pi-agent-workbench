# Milestone 05 — Manual Subagent Commands

## Goal

Expose user-controlled manual subagent commands backed by the shared runtime, catalog, and runner.

This milestone should be implementable after reading `AGENTS.md`, the required implementation docs, prior milestone docs as needed, and this file.

## Depends On

- Milestone 02 runtime/workbench extension.
- Milestone 03 config/catalog.
- Milestone 04 subagent runner.

## Scope

Implement:

- `/subagent list`
- `/subagent run`
- `/subagent adhoc`
- concise manual progress/status output using shared observation events where practical

Do not implement parent-LLM delegation in this milestone.

## Manual vs Delegated Boundary

Manual subagent commands are independent of delegation.

- They are user-controlled.
- They do not expose a model-callable `subagent` tool to the parent LLM.
- They may run named agents or ad-hoc user-specified prompts.
- They work whether delegation is on or off.

## `/subagent list`

Show:

- loaded agents
- source tier (`project`/`user`/reference package if ever shown)
- description
- model/IQ/thinking if configured
- tool allowlist summary
- warnings for untrusted project agents
- invalid/duplicate-agent warnings
- useful hints such as enabling `agents.trustProjectAgents` or using normal pi `/reload`

## `/subagent run`

Runs a named loaded agent.

MVP behavior:

- agent must exist in loaded catalog
- task text is user-provided
- cwd is current parent/session cwd
- context defaults to `fresh`
- `full` context allowed only by explicit user request
- model/IQ/thinking may be overridden if command syntax supports it simply
- tools come from trusted agent frontmatter/default tools, with strict allowlist semantics

## `/subagent adhoc`

Runs an unnamed user-controlled subagent.

Support explicit prompt mode flags:

- `--append-system-prompt`
- `--replace-system-prompt`

Support context-file flags:

- `--load-context-files`
- `--no-context-files`

Manual ad-hoc is user-only and independent of delegation. Parent LLM-created ad-hoc agents are post-MVP.

## Context Decisions

MVP context modes:

- `fresh`: default
- `full`: explicit only

Manual full context is allowed by explicit user request.

Full context serializes parent conversation as a markdown transcript with compact tool summaries plus minimal metadata:

- cwd
- parent model
- parent thinking
- date
- runId
- traceId
- controlMode

Parent model/thinking should be recorded in trace metadata for all subagent runs, but included in child prompt only for full context.

## Prompt Decisions

- Named markdown bodies append to child pi default prompt by default unless frontmatter says replace.
- `systemPromptMode: append | replace`; default `append`.
- Tool lists are strict allowlists.
- Agent frontmatter may set `loadContextFiles`; default false.
- Agent frontmatter must not set context defaults.

## Events

Manual commands should use the shared runtime sink.

Manual runs should produce:

- appropriate parent/manual command span if useful
- `subagent_start`
- child events from runner
- explicit `usage` events when totals should update
- `subagent_end`

Use `controlMode: "manual"`.

## Progress/Status

Keep output concise.

Where practical, consume the shared live-state reducer/projection once available. Before the full monitor milestone, simple runner progress callbacks or event summaries are acceptable if they do not couple runner to UI.

## Testing

Use mock runner and fixture catalogs.

No real pi/model calls.

Test:

- list loaded agents and warnings
- run named agent request construction
- ad-hoc prompt mode flags
- explicit full context behavior
- missing agent errors
- runner failure/aborted statuses displayed clearly

## Acceptance Criteria

- `npm test` passes offline.
- Manual commands do not require delegation.
- `/subagent list` shows loaded agents plus warnings/hints.
- `/subagent run` invokes the runner with the expected named agent request.
- `/subagent adhoc` supports append/replace prompt modes and context-file flags.
- Manual full context is explicit and trace-recorded.
