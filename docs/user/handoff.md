# Handoff

Handoff starts focused successor work in a new conversation. It is not a subagent: no child process or `subagent` tool is used, and source/target conversations keep separate workbench runs and metrics.

## Modes in this milestone

Manual:

```text
/handoff --mode manual --prompt "Continue by implementing phase one..."
/handoff --mode manual
```

If `--prompt` is omitted in interactive use, pi opens an editor. Headless/API use must provide `prompt`.

Static:

```text
/handoff --mode static --artifacts docs/plan.md trace-summary.md --note "Use these as context"
/handoff --mode static --artifact docs/plan.md --artifact notes.md
```

Static mode packages selected artifacts without summarization and requires at least one artifact. The default extractive form (`/handoff <goal>`) is reserved for milestone 03-3.

## Draft vs start

Interactive default creates a successor session draft and pre-fills the editor from the persisted prompt artifact. `--start` and `--auto-start` submit that artifact content and wait; there is no fire-and-forget mode in MVP.

Headless/API default writes only the durable handoff record and artifacts unless `autoStart: true` is passed.

## Target persona

Use `--to <agent>` to apply a named agent as persona guidance for the target conversation. In MVP, persona/thinking are applied; target model and tools are not changed. If the target profile includes model/tools, interactive use asks for confirmation and headless/API use must explicitly allow partial profile application.

## Artifacts

`--artifacts` and repeated `--artifact` are handoff package attachments, not extractor input. Files are resolved from the current working directory. Directories are unsupported.

Default artifact policy is `auto`:

- small text/markdown/code files are snapshotted and may be included in the static prompt;
- large text snapshots are stored but referenced by path/metadata only;
- binary or unknown files are referenced only.

Generated prompt artifacts and lineage exports get best-effort redaction of common secret patterns. This is not a security boundary and original files are never mutated.

## Lineage export

Export current run metrics as before:

```text
/observe dump metrics.json
```

Export linked source/target handoff lineage:

```text
/observe dump --lineage lineage.json
```

Lineage export works from either side when links are available, includes per-run and combined metrics, and references artifact paths/hashes/sizes without embedding prompt contents.
