# Milestone 03-3 — Extractive Handoff

## Goal

Add Amp-style extractive handoff on top of Milestone 03-2: the user provides a next-task goal, workbench prepares bounded source context, a built-in extractor model generates a structured target prompt, and the existing handoff foundation creates the record/artifact/successor session.

Extractive handoff is the default UX for:

```text
/handoff <goal>
```

## Depends On

- Milestone 03-2 handoff foundation.
- Existing config/catalog/runtime/observability from prior milestones.

## Scope

First, clean up 03-2 target-run attachment so extractive handoff builds on authoritative lineage instead of placeholder target runs.

Then implement the third handoff method:

1. **Extractive handoff**
   - user provides a next-task goal/instructions
   - if goal is missing interactively, prompt for it
   - if goal is missing in headless/API, fail clearly
   - do not infer generic “continue this work” in MVP
   - prepare compact active-branch source context with deterministic tool summaries
   - include selected artifact inputs according to type/size/global budget
   - run a built-in extractor LLM call
   - write generated target prompt artifact
   - hand off to Milestone 03-2 session/lineage/target-agent machinery after the target-runtime attachment cleanup above

Required 03-2 cleanup before/with extractive flow:

- stop pre-creating target `RunRecord`s in source-session handoff orchestration
- write target-session handoff metadata (`handoffId`, source run/session IDs, storage root, prompt artifact metadata) before creating/opening the successor session
- when the target workbench runtime starts, detect `workbench-handoff-target` metadata and update the handoff record with the actual target `runId`, `traceId`, session ID, and session file
- make the update idempotent across target reload/resume; same target session/run should be a no-op, conflicting target linkage should warn/fail deterministically
- emit target-side linkage/lifecycle events from the actual target runtime, not from a placeholder source-created run
- ensure auto-start updates target linkage before or around prompt submission so lineage is available even if the target task fails
- keep `/observe dump --lineage` working from source and target using the updated handoff record, with fallback scanning only as recovery

Out of scope:

- custom extractor profiles
- named agents as extractors/summarizers
- extractor tools
- pre-extractor instruction editor (`--edit-extraction` deferred)
- current-session replacement
- fire-and-forget

## Built-In Extractor

Use one package-owned built-in extractor rather than custom profiles.

Put execution behind a small `HandoffExtractor` interface so tests use fake extractors and never require real model calls.

Extractor behavior:

- model defaults to parent/default model or configured utility model if available
- IQ/thinking defaults to low or medium
- package-owned fixed/versioned system prompt
- no tools in MVP
- input consists only of prepared compact context, artifact inputs/metadata, and goal

Minimal config knobs:

- `handoff.extractorModel?`
- `handoff.extractorIq?`
- `handoff.maxInputChars?`
- `handoff.maxOutputTokens?`
- `handoff.includeCitations?: boolean` if kept, default false and do not render generic prompt citations

Do not add arbitrary custom prompt/profile configuration. If multiple context transforms accumulate later, consider a definition kind such as `context_transform` or `handoff_profile`.

## Extractor Input

Prepare a deterministic compact source context from the current active branch only.

Include:

- user messages
- assistant messages, excluding thinking blocks
- deterministic tool summaries
- candidate file/reference metadata derived from observed session/tool context
- explicit selected artifacts according to method semantics and budgets

Exclude:

- thinking blocks always
- unsent editor buffer
- hidden/internal workbench records unless needed as provenance metadata
- full raw unbounded tool output

Assistant prose is included because it may contain plans, decisions, conclusions, and constraints.

## Tool Summaries

Summarize tool calls deterministically, not with an LLM pre-summary.

Suggested rules:

- `read`: path, success/error, first N lines/chars
- `grep`/`find`/`ls`: result preview up to cap
- `bash`: command, exit code/status, first and last output chunks
- `edit`/`write`: file path, success/error, concise details/diff summary when available, not full file
- unknown tools: name, args preview, status/result length

Record truncation metadata where useful.

## Artifacts in Extractive Mode

`--artifacts` means handoff package attachments.

For extractive mode:

- selected artifacts are visible to the extractor according to type/size/global budget
- selected artifacts are also recorded/attached in the target package via 03-2 artifact rules
- explicit user selection is a relevance signal, but must not blow the input budget

Small selected text/markdown artifacts may be included in extractor input. Oversized/source/binary artifacts should be represented by metadata/path only.

## Input Budgeting

Use deterministic global budgeting, not only per-artifact caps.

Example budget slices or equivalent deterministic priorities:

- extractor system prompt + user goal reserved first
- transcript budget
- selected artifact content budget
- file/reference/provenance metadata budget
- safety margin

Selected artifacts should not starve the conversation transcript, and transcript should not starve explicit artifact metadata.

If over budget:

1. include artifact metadata for all selected artifacts
2. include small selected artifact contents up to artifact slice
3. truncate/drop older/noisy tool outputs first
4. truncate older assistant messages before user goal/recent user intent
5. preserve file paths, errors, final decisions, constraints, and recent messages where possible

MVP may use character budgets instead of tokenizer-accurate budgets.

## Redaction

Apply best-effort redaction to serialized extractor input and generated prompt artifacts for common secret patterns:

- env var assignments containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`
- bearer/basic auth headers
- common provider keys where recognizable
- AWS-style keys

Do not mutate original source artifacts. Record redaction metadata such as whether redaction occurred and count/classes of patterns. User docs must state this is best-effort and not a security boundary.

## Target Prompt Format

Extractive handoff uses fixed package-owned structured markdown format version 1.

Store `handoffPromptFormatVersion: 1` in the handoff record.

Use a renderer such as `renderHandoffPromptV1(...)`.

V1 sections:

```md
# Handoff

## Goal

## Relevant Context

## Decisions and Constraints

## Files and Artifacts

## Suggested Next Steps
```

Do not include generic source citations/provenance in target prompt by default. Provenance belongs in the handoff record and lineage export. Include artifact/file paths only when actionable.

No dedicated failed-attempts section. Relevant failures appear only if they materially constrain future work or explain why an obvious approach should not be repeated, usually under `Decisions and Constraints` or `Relevant Context`.

## Events and Metrics

Add/use handoff extraction events:

- `handoff_extract_start`
- `handoff_extract_end`

Keep existing 03-2 lifecycle:

- `handoff_start`
- `handoff_end`
- `artifact`
- `error`

Extractor usage belongs to the source run because extraction happens while executing the source-session handoff command. Emit explicit `usage` events only when authoritative; unknown token/cache metrics are undefined, not zero.

If extractor call fails:

- fail the handoff
- emit/record failed handoff status and an explicit `error` event
- do not create successor session
- no fallback draft/model fallback in MVP

## Headless/Interactive Behavior

Interactive:

```text
/handoff implement phase one
/handoff --to scout find other affected auth code
/handoff --start review the remaining files
```

- default extractive mode runs extraction immediately from the user goal
- then creates successor session draft using 03-2 flow
- `--start` / `--auto-start` submits instead of draft
- no pre-extractor instruction editing in MVP

Headless/API:

```ts
handoff({ method: "extractive", goal, autoStart: false })
handoff({ method: "extractive", goal, autoStart: true, lineageExportPath })
```

- default is artifact/output-only
- `autoStart: true` creates successor session, submits, waits for completion, and may export lineage
- no fire-and-forget

## Testability

Use dependency injection around:

- `HandoffExtractor`
- compact transcript/source-context builder
- artifact resolver/reader
- redactor
- handoff foundation orchestrator from 03-2, including target named-agent/persona behavior

Tests must be offline:

- fake extractor returns deterministic structured output
- fixture session branches for transcript serialization
- tool summary fixtures
- artifact budget/truncation tests
- redaction tests
- extractor failure tests
- no provider credentials/network/real model calls

## Documentation Requirements

Update `docs/user/handoff.md` from 03-2 to include extractive mode:

- `/handoff <goal>` default behavior
- requirement for next-task goal
- generated target draft vs `--start`
- what source context is included/excluded
- no thinking blocks
- no extractor tools
- artifact behavior in extractive mode
- redaction caveat
- failure behavior

Developer docs/comments must explain:

- target-runtime handoff attachment: source handoff writes metadata, target runtime owns the actual target run, then updates the handoff record
- deterministic compact transcript rules
- artifact budget slices/priorities
- why extractor usage belongs to source run
- why extractor has no tools
- why named agents are targets, not extractors

## Acceptance Criteria

- Target handoff linkage no longer creates placeholder target runs; the handoff record points at the actual target runtime run.
- `/observe dump --lineage` from source or target includes source plus actual target runs, without extra zero-metric placeholder runs.
- Target linkage update is idempotent across reload/resume and works with auto-start.
- `/handoff <goal>` runs extractive flow with fake extractor in tests.
- Missing goal prompts interactively and fails in headless/API.
- Compact transcript includes user and assistant prose, excludes thinking, and summarizes tools deterministically.
- Explicit artifacts are visible to extractor according to budget and also attached to target package.
- Extractor input budget/truncation is deterministic and recorded.
- Generated prompt uses structured markdown v1.
- Extractor failure fails handoff and does not create target session.
- Extractor usage is recorded in source run only when authoritative.
- Existing manual/static and target named-agent/persona 03-2 behavior remains unchanged; 03-3 does not add new target-agent behavior unless explicitly justified.
- User docs updated.
