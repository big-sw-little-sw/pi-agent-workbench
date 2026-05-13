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

The status command is read-only and shows the current workbench run, trace path, run status, known metrics, and warnings. It also shows terse config/catalog warning or error counts when named-agent loading has diagnostics.

Observability also works when pi runs headless. For headless/CI runs, configure metrics export with CLI flags, environment variables, or user/project config so a JSON report is written on graceful shutdown.

Export a JSON metrics report interactively:

```text
/observe dump metrics/workbench-metrics.json
/observe dump --template metrics/{runId}.json
```

Enable export on graceful pi shutdown with environment variables:

```bash
PI_WORKBENCH_METRICS_FILE='./metrics/{runId}.json' \
PI_WORKBENCH_METRICS_TEMPLATE=true \
pi
```

Or with extension flags when starting pi:

```bash
pi \
  --workbench-metrics-file './metrics/{runId}.json' \
  --workbench-metrics-export onShutdown \
  --workbench-metrics-template
```

For a headless run, combine the same export settings with pi's non-interactive mode:

```bash
PI_WORKBENCH_METRICS_FILE='./metrics/{runId}.json' \
PI_WORKBENCH_METRICS_TEMPLATE=true \
pi --mode json -p "summarize this repository"
```

Config may also enable export at either level:

```text
~/.pi/agent/workbench/config.json
<project>/.pi/workbench/config.json
```

```json
{
  "schemaVersion": 1,
  "observability": {
    "metricsExportFile": "./metrics/workbench-metrics.json",
    "metricsExportMode": "onShutdown",
    "metricsExportTemplate": false
  }
}
```

Project config overrides user/global config field-by-field. Precedence is CLI flag, environment, project config, global config, defaults. `{runId}` is the current workbench observation run ID used to correlate the run summary and trace; separate pi invocations normally get different run IDs, so templated export paths avoid clashes. Quote shell values containing `{runId}` as shown above so your shell does not perform brace expansion; slash-command examples do not need quotes unless the path contains spaces. Review project `.pi/workbench/config.json` before loading the extension: project config can configure filesystem writes. Absolute export paths are allowed for config/env/CLI/slash commands and are treated as explicit user-controlled writes.

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

## Config and Named Agent Catalog

Config files are optional JSON files:

```text
~/.pi/agent/workbench/config.json
<project>/.pi/workbench/config.json
```

Project config overrides global config field-by-field. The `observability.metricsExportFile` option may be relative to the project root or absolute; project config with an absolute export path is allowed but reported as a warning. Named agent markdown files are discovered from:

```text
~/.pi/agent/workbench/agents/*.md
<project>/.pi/workbench/agents/*.md
```

Project agents are skipped unless the effective config sets `agents.trustProjectAgents: true`. `/subagent` commands are not available yet.

## Privacy

Parent observability records lifecycle, usage, tool names/status, and small metadata. It does not persist full prompts, assistant messages, streaming chunks, tool arguments, or tool results by default.

Subagent commands and delegation are not available yet; they will be documented when implemented.
