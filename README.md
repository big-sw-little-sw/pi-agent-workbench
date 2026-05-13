# pi-agent-workbench

A pi workbench extension for durable parent-session observability, with subagents and opt-in delegation planned in later MVP milestones.

## Install

Install globally from GitHub:

```bash
pi install git:github.com/big-sw-little-sw/pi-agent-workbench
```

Or install for the current project only:

```bash
pi install -l git:github.com/big-sw-little-sw/pi-agent-workbench
```

Pi packages run with your local permissions. Review the source before installing.

## Use

From any project you want to observe, start pi normally after installation:

```bash
pi
```

Then run:

```text
/observe status
```

## Development

```bash
npm install
npm test
```

For local development without installing the package:

```bash
pi --no-extensions \
  -e ~/sw/code/pi-agent-workbench/src/extensions/workbench.ts
```

## Observability Quick Start

1. Install the package, or load the extension with `-e` for local development.
2. Use pi normally.
3. Run:

```text
/observe status
```

The status command is read-only and shows the current workbench run, trace path, run status, known metrics, and warnings.

Default storage is project-local:

```text
.pi/workbench/runs/<run-id>.json
.pi/workbench/traces/<run-id>.jsonl
```

When launched inside a git repository, storage is rooted at the git repository root.

## Run Lifecycle

- `run_start`: written once when a logical workbench observation run is created.
- `runtime_attach`: written whenever the extension attaches to the run, including reload/resume.
- `runtime_detach`: written on normal pi shutdown/reload; the run remains resumable.
- `run_end`: reserved for explicit future finalization, not normal shutdown.

Statuses:

- `running`: a workbench runtime is currently attached.
- `detached`: the run is open/resumable but no runtime is currently attached.

If a persisted session-to-run link is invalid, workbench creates a replacement run and `/observe status` warns that metrics may be incomplete.

## Privacy

Parent observability records lifecycle, usage, tool names/status, and small metadata. It does not persist full prompts, assistant messages, streaming chunks, tool arguments, or tool results by default.

Subagent commands and delegation are not available yet; they will be documented when implemented.
