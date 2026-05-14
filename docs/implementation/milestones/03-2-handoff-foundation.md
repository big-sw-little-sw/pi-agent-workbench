# Milestone 03-2 — Handoff Foundation (Manual + Static)

## Goal

Add the handoff foundation: durable handoff records, prompt/static artifacts, successor-session creation, target agent persona support, and lineage export. This milestone intentionally excludes extractive/LLM summarization; Milestone 03-3 adds extractive handoff on top of this foundation.

Primary job: context hygiene for focused successor work. Secondary job: user convenience through reusable generated prompts/context artifacts. Observability lineage is mandatory.

## Placement

After Milestone 03-1 and before subagent execution:

- depends on core trace/runtime/parent observability, config/catalog, metrics export
- does not depend on subagent runner/delegation
- must not expose or require the `subagent` tool

## Scope

Implement new-conversation handoff only.

Supported methods in this milestone:

1. **Manual handoff**
   - user supplies the exact target prompt via `--prompt` or, interactively, an editor when missing
   - no extractor/summarizer call
   - prompt text is preserved exactly except transport/storage normalization and best-effort secret redaction; redaction takes precedence over exact preservation

2. **Static handoff**
   - selected artifacts/files/notes are copied or referenced without summarization
   - requires at least one selected artifact; if no artifacts are provided, use manual mode instead
   - workbench authors a deterministic static-context wrapper from selected artifacts and optional `--note`

Deferred to Milestone 03-3:

- default extractive `/handoff <goal>`
- compact transcript generation
- extractor model call, extractor usage, extractor budgeting
- `handoff_extract_start` / `handoff_extract_end`

Target mode:

- only `new_conversation`
- no current-conversation replacement
- revisit replacement post-MVP only with explicit draft/edit confirmation; never silently replace with an LLM-generated extract

Activation modes:

- interactive default: create successor session and prefill editor with persisted target prompt artifact
- `--start` / `--auto-start`: create successor session and submit the prompt
- headless/API default: create durable handoff record/output only; no unsubmitted target session draft
- headless/API `autoStart: true`: create successor session, submit prompt, wait for completion, then optionally write lineage export
- no fire-and-forget and no `waitForTarget: false` in MVP
- user-invoked `--start` needs no extra confirmation

## Out of Scope

- extractive LLM handoff (Milestone 03-3)
- current conversation replacement
- dynamic/live context bundles
- delegated/model-callable handoff (Milestone 06-1)
- dry-run mode
- custom handoff profiles/extractor profiles
- using named agents as extractors/summarizers
- subagent execution/delegation semantics
- workflows/YAML

## Command/API Semantics

Interactive examples:

```text
/handoff --mode manual --prompt "Continue by implementing phase one. Relevant constraints: ..."
/handoff --mode manual
/handoff --mode static --artifacts plan.md trace-summary.md --note "Use these as context"
/handoff --to scout --mode static --artifacts docs/plan.md
/handoff --mode manual --start --prompt "Start from this exact prompt"
```

Rules:

- 03-2 registers the `/handoff` command for user-visible manual/static modes
- default extractive `/handoff <goal>` is reserved for Milestone 03-3; until then missing `--mode manual|static` should fail with a clear "extractive handoff comes in 03-3" message or equivalent
- manual mode uses `--prompt` or interactive editor; no positional manual prompt
- static mode uses `--artifacts` plus optional `--note`; no positional static note
- static mode errors if no artifacts
- `--artifacts` means handoff package attachments, not extractor input
- `--artifact <path>` may repeat
- `--artifacts <path...>` collects paths until next flag
- `--start` and `--auto-start` are aliases for `autoStart`
- config/env must not imply auto-start, partial-profile acceptance, or external-artifact acceptance

## Shared Slash Argument Parser

Add a tiny shared slash-argument parser helper rather than a large handoff-specific parser.

Requirements:

- offline-tested
- boolean flags
- string flags
- repeated string/list flags
- `--flag=value` for simple string flags only
- minimal single/double quote grouping
- remaining positional args
- unclosed quotes are parse errors
- no boolean negation flags
- no shell expansion, env vars, globbing, or parser dependency

Use it for handoff first; migrate `/observe dump` only if low-risk.

## Target Named Agents

MVP supports handing off to a named target agent/persona from the loaded agent catalog, but only as persona/profile guidance, not a full profiled runtime session.

Rules:

- `--to <agentName>` selects the target persona for the successor conversation
- named agents are reusable agent profiles, not inherently subagents
- apply target system prompt/persona persistently via successor-session metadata plus `before_agent_start`
- apply target thinking via `setup().appendThinkingLevelChange(...)` when different and safe
- target profile model/tools are **not applied** in MVP
- do not append `model_change` for handoff target model overrides
- do not change active tools
- record `desiredTargetModel` and desired tool policy in handoff metadata when present
- if target profile model/tools are present, show a prominent non-context warning that explicitly lists what is not honored
- interactive mode requires per-invocation confirmation before proceeding with such partial profile application
- headless/API fails unless explicit per-invocation `allowPartialProfile` or equivalent is provided
- validate/confirm partial profile behavior before artifact creation or target session creation
- `--start` does not add a second confirmation

Pi session replacement decision:

- use only the `ctx` passed to `withSession` for target-session work
- current public `ReplacedSessionContext` supports safe draft/auto-start operations but not model/tool setters
- spike result: setup-appended thinking applies immediately; setup-appended model is visible in built session context but not `replacementCtx.model` before first prompt
- post-MVP profiled sessions are tracked in GitHub issue #1: https://github.com/big-sw-little-sw/pi-agent-workbench/issues/1

## Handoff Records and Storage

A handoff produces a durable mutable summary record plus trace events.

Record path:

```text
.pi/workbench/handoffs/<handoff-id>.json
```

Artifact path:

```text
.pi/workbench/artifacts/<source-run-id>/<handoff-id>/
```

ID strategy:

- add `createHandoffId()` near core ID helpers
- use existing core ID style, not UUIDs
- shape: `handoff_<timestamp-base36>_<12-hex>`
- refactor/reuse ID helper internals if useful

Minimum record fields:

- `schemaVersion: 1`
- `handoffId`
- `status: completed | failed | partial`
- failure stage/message when failed or partial
- source run/session identifiers
- target run/session identifiers when created
- target agent/profile name and application mode when specified
- desired target model/tools when present but not honored
- method: `manual | static` in this milestone; schema/types should already allow `extractive` for 03-3, but 03-2 tests only need manual/static behavior
- target mode: `new_conversation`
- activation: `draft | auto_start | artifact_only`
- selected artifact references when present
- target prompt artifact absolute path, SHA-256, size
- submitted prompt hash for auto-start, set when artifact content is accepted by `sendUserMessage` without throwing
- timestamps

Record writes:

- mutable summary updated as state changes, like `RunRecord`
- trace events remain canonical history
- atomic writes using existing helpers, creating parent dirs
- source/target run IDs belong inside JSON, not filename
- persisted paths are absolute and directly openable; UI may render relative paths

All modes write the target prompt artifact before target session creation, after transport/storage normalization and best-effort secret redaction. Draft and auto-start modes read that artifact back; draft pre-fills editor from it, auto-start submits it. If the user edits a draft later, MVP does not update the handoff artifact/hash; target session history is authoritative for the actual submitted prompt.

## Static Artifacts

Validate explicit artifact paths before artifact creation or target session creation.

Validation means:

- resolve path relative to cwd
- check existence/readability
- classify type/size
- verify requested artifact mode feasibility
- directories unsupported unless later added

Invalid/unreadable artifacts:

- interactive: ask whether to continue without invalid artifacts
- headless/API: fail deterministically

External artifacts outside project root/cwd:

- interactive: require confirmation
- headless/API: require explicit `allowExternalArtifacts` or equivalent

Default artifact mode is `auto`:

- source/code files: reference by path/provenance by default
- markdown/text plans/reports under cap: snapshot content into workbench artifact storage and include according to prompt budget
- markdown/text over cap: if snapshot is explicitly requested, copy to artifact storage but include path + metadata only in target prompt
- large/binary/unknown: reference only

Per-artifact metadata:

- original absolute path
- requested mode: `auto | reference | snapshot`
- applied mode: `reference | snapshot`
- reason when auto/fallback changes behavior
- SHA-256 and size for snapshots
- absolute snapshot artifact path when copied

For oversized snapshots, target prompt includes path + metadata only, no preview and no generated summary. Revisit previews/summaries post-MVP.

Apply best-effort redaction to target prompt artifacts (including manual prompts), generated static prompt content, and lineage exports for common secret patterns. Redaction has priority over exact prompt preservation. Do not mutate original source artifacts. Record redaction metadata and document that this is not a security boundary.

## Prompt Formats

Manual:

- user-authored prompt, not wrapped/prefixed; only transport/storage normalization and best-effort secret redaction may alter artifact/submitted text
- with `--to <agent>`, target system prompt applies separately; do not wrap/prefix manual prompt
- if no `--prompt`, open editor interactively and fail in headless

Static:

- minimal deterministic static-context wrapper
- lists user note, selected artifacts, artifact metadata, and actionable paths
- must not pretend an extractor produced decisions/relevant context

Extractive structured prompt v1 is deferred to Milestone 03-3.

Do not include generic source citations/provenance in target prompts. Provenance belongs in handoff records and lineage export. Include artifact/file paths only when actionable.

## Session Lineage and Observability

Handoff is observable as handoff, not subagent activity. Add `handoff` to core `ObservationSource` in 03-2 so manual/static and later extractive handoff use the same source.

Known handoff event types should be added in 03-2 for schema stability, even though extractive events are produced only in 03-3:

- `handoff_start`
- `handoff_extract_start`
- `handoff_extract_end`
- `handoff_end`

Existing events:

- `artifact` for prompt/context files
- `error` for failures

Recommended event data:

- `handoffId`
- `method`
- `targetMode: "new_conversation"`
- `activation`
- `sourceRunId` / source session path
- `targetRunId` / target session path when created
- `targetAgentName` and `targetAgentApplication` when specified
- prompt artifact path/hash

Do not emit `subagent_start`/`subagent_end`.

Lineage rules:

- source and target sessions have separate linked workbench runs
- when activation creates a target session, handoff creates a target run; it does not continue the same run across sessions. Headless artifact-only handoff may have no target run yet.
- target conversation usage belongs to target run
- source session gets hidden lineage metadata plus a concise visible breadcrumb if it can be non-context; otherwise hidden only
- target session gets reverse lineage metadata; visible breadcrumb only if non-context
- target prompt should not include generic handoff provenance noise

Failure rules:

- target session/prompt failures after artifacts/records exist produce `partial` status
- do not delete/rollback sessions or trace files
- record recovery paths and failure stage
- emit explicit `error` events for metric-affecting failures
- target task failure after successful auto-start does not make handoff failed/partial; report `handoffStatus: completed` plus target run failure
- one-shot headless exits non-zero if target run fails

## Metrics and Lineage Export

Add minimal lineage export:

```text
/observe dump --lineage <file>
```

Behavior:

- `/observe dump <file>` remains current active run export
- lineage export works from either source or target session
- explicit links first, fallback scan local `.pi/workbench/handoffs/*.json`
- if no lineage found, export current run only with warning
- current-run based only; `--handoff <id>` / `--run <id>` selectors deferred
- `schemaVersion: 1`, `exportedAt`, absolute `exportFile`
- include per-run records/metrics, combined metrics over available runs, handoff metadata, source/target IDs, warnings
- do not include full raw trace events by default
- include artifact paths/hashes/sizes, not prompt contents inline
- tolerate partial/missing target traces

## Conversation Titles

Target session display name should be deterministic if pi APIs permit:

- `Handoff: <prompt/goal prefix>`
- `Handoff to <target>: <prompt/goal prefix>`

If not possible, record title in handoff metadata and leave native naming alone. Do not modify source session title. Do not use a title LLM call.

## Headless/API

Per-invocation fields:

- `method: manual | static` in this milestone; schema may allow `extractive` later
- `prompt`
- `artifacts`
- `note`
- `targetAgentName`
- `autoStart`
- `lineageExportPath`
- `allowPartialProfile`
- `allowExternalArtifacts`

Config/env may provide safe defaults such as artifact policy or lineage export path/template, but not auto-start, partial-profile acceptance, or external-artifact acceptance.

## Testability and Adapters

Core orchestration must be testable without pi, providers, network, or real model calls.

Use dependency injection around:

- session controller/adapter for target session creation, draft prefill, auto-start, and lineage metadata writes
- artifact store/hash/redaction helpers
- lineage export reader/writer
- slash parser

The extension entrypoint stays thin and adapts pi command context (`ctx.newSession`, `withSession`, `ctx.ui.setEditorText`, `ctx.sendUserMessage`).

## Documentation Requirements

Add `docs/user/handoff.md` or equivalent and link from README.

User docs must explain:

- handoff vs subagent
- manual vs static modes in this milestone, with extractive marked as coming in 03-3 if not implemented yet
- draft vs `--start`/`--auto-start`
- `--to <agent>` persona-first behavior and unsupported model/tools warnings
- `--artifacts` semantics
- artifact auto/reference/snapshot rules and size caps
- source/target lineage and `/observe dump --lineage`
- headless behavior and no fire-and-forget

Developer docs/comments must explain:

- `handoff_*` vs `subagent_*`
- source-run vs target-run metrics ownership
- target profile metadata and `before_agent_start`
- artifact inclusion/redaction rules
- deferred replacement, extractive handoff, full profiled sessions, and fire-and-forget

## Acceptance Criteria

- User docs added and README links to them.
- `/handoff --mode manual --prompt ...` creates a durable record and prompt artifact without extractor logic.
- Interactive manual with no `--prompt` opens editor; headless fails clearly.
- `/handoff --mode static --artifacts ...` validates artifacts, creates static wrapper prompt artifact, and records provenance.
- Static mode requires artifacts.
- Interactive default for implemented modes creates successor session draft.
- Headless default creates handoff record/artifact only.
- Explicit auto-start path submits artifact content and waits in one-shot headless.
- Target named agent persona applies via persistent system prompt metadata; model/tools are not applied and warnings/confirmations behave as specified.
- Source and target runs are separate and linked.
- Trace contains `handoff_start`/`handoff_end` and no subagent events.
- Minimal lineage dump works from either source or target and includes per-run plus combined metrics.
- Partial failures are recorded as partial and recoverable.
- 03-2 performs no extractor/model calls; extractive handoff is not implemented until 03-3.
- Tests are offline with fake adapters.
