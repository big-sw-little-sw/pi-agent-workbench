# 03-1 — Observability Metrics Export

## Goal

Add a small, headless-friendly observability export path that writes the current run metrics/report to a user-chosen file.

This is a follow-on to Milestone 03 because it extends CLI/env/config-driven runtime behavior after config loading exists, while still being independent of subagent execution, delegation, and the live monitor.

## Scope

Implement metrics export for the parent/workbench run only, using already persisted observability state.

In scope:

- CLI/env/config-driven metrics export for headless pi runs
- slash command for interactive export
- user-overridable export file location
- concise JSON report format with metrics plus run metadata/warnings
- offline tests using temp directories and synthetic events

Out of scope:

- separate `pi-workbench` CLI
- GUI/report dashboards
- HTML reports
- workflow/YAML integration
- provider/network/model calls
- changing core metric aggregation semantics

## Decisions Recorded So Far

- The feature should not invent a separate CLI tool for MVP.
- Headless operation should be driven by pi extension CLI flags, environment variables, and/or config available when starting `pi`.
- Users must be able to override the metrics export location.
- Export should write a small report object, not bare `RunMetrics`, so consumers can identify the run and detect incomplete/degraded metrics.
- Existing durable files remain canonical:
  - `.pi/workbench/runs/<run-id>.json`
  - `.pi/workbench/traces/<run-id>.jsonl`
- Unknown token/cache/cost metrics remain absent/`undefined`; exporters must not coerce them to `0`.

## Headless Startup Options

The preferred MVP-compatible headless controls are:

1. **Environment variable path override**

   ```bash
   PI_WORKBENCH_METRICS_FILE=./metrics/workbench-metrics.json pi --no-extensions -e ./src/extensions/workbench.ts ...
   ```

   This remains useful for shells, CI, and wrappers even though pi also supports extension-defined flags.

2. **Config file option**

   ```json
   {
     "schemaVersion": 1,
     "observability": {
       "metricsExportFile": "./metrics/workbench-metrics.json",
       "metricsExportMode": "onShutdown"
     }
   }
   ```

   Project config should override global config using the existing Milestone 03 precedence rules. Project config may enable export by itself; user-facing docs should tell users to review project `.pi/workbench/config.json` because it can configure filesystem writes.

3. **Pi extension CLI flag**

   Pi supports extension-defined CLI flags via `pi.registerFlag()` / `pi.getFlag()`, so the workbench extension may provide a native startup flag in addition to env/config, for example:

   ```bash
   pi --no-extensions -e ./src/extensions/workbench.ts --workbench-metrics-file ./metrics/workbench-metrics.json
   ```

   Register the flag during extension initialization, but read it during `session_start`; pi example extensions note that CLI flag values are not available during the extension factory.

   Use the narrow path-oriented flag name `--workbench-metrics-file`. Use `--workbench-metrics-export=off|onShutdown` for mode control and `--workbench-metrics-template` to enable `{runId}` expansion.

Do not add or require a separate top-level wrapper CLI from this package.

## Config Shape Addition

Extend `WorkbenchConfig` with an `observability` section:

```ts
type WorkbenchConfig = {
  schemaVersion: 1;
  agents: { trustProjectAgents: boolean };
  subagents: { defaultTools: string[]; defaultTimeoutMs: number; loadExtensions: boolean };
  delegation: { enabledByDefault: boolean; allowFullContext: boolean; maxParallel: number };
  observability: {
    metricsExportFile?: string;
    metricsExportMode: "off" | "onShutdown";
    metricsExportTemplate: boolean;
  };
};
```

Default:

```json
{
  "observability": {
    "metricsExportMode": "off",
    "metricsExportTemplate": false
  }
}
```

Validation policy:

- Config, env, and CLI export options should share validation/coercion behavior where practical and surface diagnostics/warnings in `/observe status` for invalid values. Headless misconfiguration must be discoverable.
- `metricsExportMode` defaults to `off` and accepts exact string values `"off"` and `"onShutdown"` only across config, env, and CLI. Do not add aliases in MVP.
- `metricsExportFile` is optional when mode is `off`.
- If mode is not `off`, `metricsExportFile` must be a non-empty string.
- Invalid explicit mode values produce a diagnostic and are treated as unset for fallback purposes. Therefore, if a metrics file is provided and mode is invalid, the file still implies `onShutdown`.
- Relative export paths resolve against the same project root/storage policy used by workbench traces, not against arbitrary process cwd drift.
- Parent directories should be created automatically with recursive directory creation before writing the export file.
- Export writes should be atomic-ish: write JSON to a temporary file in the target directory, then rename it over the resolved target file.
- JSON output should be pretty-printed with 2 spaces.
- Reuse or extract the existing temp-file-then-rename pattern from `TraceStore.writeRun()` rather than duplicating write logic. Add a tiny dependency-free core helper in `src/core/fs.ts` or `src/core/atomic-write.ts`. The primitive should be `writeFileAtomic(file, data, options)`, unless implementation needs a text/binary distinction. A convenience `writeJsonFileAtomic(file, value, options)` may wrap it with 2-space formatting if useful. Refactor `TraceStore.writeRun()` and metrics export to use the helper. Export helpers from `src/core/index.ts` only if needed outside core.
- Atomic write helper options should include `createParentDirs?: boolean`, defaulting to `false`. Metrics export should call it with `{ createParentDirs: true }`. `TraceStore.writeRun()` may keep its explicit directory creation or call the helper with the option enabled.
- Atomic temp file names should include pid, timestamp, and a small random suffix to reduce same-process and concurrent-write collisions.
- If atomic write fails after creating the temp file, attempt best-effort temp cleanup and throw/report the original error.
- Export overwrites the resolved target file each time; it does not append or rotate. Canonical history remains in `.pi/workbench/runs` and `.pi/workbench/traces`, and the export report includes `runId` for correlation.
- Concurrent pi instances writing the same resolved export path are last-writer-wins. MVP does not provide cross-process locking. Use distinct paths or template mode for concurrent headless runs.
- `metricsExportTemplate` defaults to `false`; when `false`, `metricsExportFile` is treated as a literal path.
- Invalid template boolean values produce a diagnostic and fall back to `false`. If the path contains `{runId}` while template mode is false, it remains a literal filename; emit a warning diagnostic because this is likely an intent mismatch, and `/observe status` should make `template=false` visible when export is enabled.
- When `metricsExportTemplate` is `true`, replace a small supported placeholder set in `metricsExportFile`; MVP supports `{runId}` only. Treat any `{...}` sequence as a placeholder candidate; if it is not exactly `{runId}`, it is unknown and fatal to that export. Unmatched `{` or `}` is invalid in template mode. Produce a diagnostic/warning early when possible, and skip the export rather than silently writing an unexpected literal placeholder path. For shutdown export, emit an export-failure `error` event when possible and fail soft. In non-template mode, braces remain literal, with the separate `{runId}`-while-template-off warning described above.
- If template mode is enabled but the path contains no `{runId}`, allow it; template mode means "expand supported placeholders if present".
- Template mode does not preclude static stable paths: with `metricsExportTemplate: false`, the path is literal and stable; with `true`, placeholders are expanded. MVP writes a single output only, not both stable and templated files.
- Curly braces are valid filename characters on Unix/macOS and Windows, but users should quote CLI/env examples containing braces to avoid shell-specific expansion surprises. Slash-command examples do not need quotes for braces unless pi command parsing requires quotes for spaces.
- Absolute export paths outside the project are allowed from config, environment variables, CLI flags, and slash commands because this is an explicit user-controlled filesystem write. Relative paths still resolve against the project root/workbench storage policy. Document this security implication in user-facing docs when the feature ships.
- Project config using an absolute `observability.metricsExportFile` should produce a warning diagnostic but remain allowed. Global config, env, CLI, and slash-command absolute paths do not need this warning.

## CLI Flags and Environment Variables

Names:

- `--workbench-metrics-file`: export destination path
- `--workbench-metrics-export`: optional mode override (`off` or `onShutdown`)
- `--workbench-metrics-template`: enable placeholder expansion in the destination path
- `PI_WORKBENCH_METRICS_FILE`: export destination path
- `PI_WORKBENCH_METRICS_EXPORT`: optional mode override (`off` or `onShutdown`)
- `PI_WORKBENCH_METRICS_TEMPLATE`: enable placeholder expansion in the destination path (`true`/`false`)

Precedence is field-by-field, matching existing config deep-merge behavior:

```text
pi extension CLI flag > environment variables > project config > global config > defaults
```

Each higher-precedence source overrides only the fields it sets; it does not replace the entire observability export configuration.

If `PI_WORKBENCH_METRICS_FILE` or the equivalent pi extension flag is set and no mode is set, imply `onShutdown`. Explicit `off` at a higher-precedence layer disables export; lower-precedence file values must not re-enable export.

This field-by-field overlay is a refactor/reuse opportunity. Milestone 03 currently implements config field merging in `src/config/workbench-config.ts` (`mergePresentConfig`). Extract a small reusable overlay helper for present fields rather than adding another ad hoc precedence merger for CLI/env/config export options. Place it in a config-common location such as `src/config/merge.ts` unless it proves broadly non-config-specific; avoid over-generalized deep-merge magic. Reuse this primitive for both existing global/project config merge and metrics export effective option resolution; keep feature-specific policy such as env var names, CLI flag names, file-implies-`onShutdown`, and template validation in the metrics export module.

## Slash Command

Add interactive command forms:

```text
/observe dump <file>
/observe dump --template <file>
```

Rules:

- slash command arguments are one-shot direct inputs and do not participate in CLI/env/config precedence or mutate configured export settings
- read-only with respect to run/session state and trace events, except that export failures may emit an `error` observation event
- writes the current metrics report to the requested file
- without `--template`, treats `<file>` as a literal path
- with `--template`, expands the same MVP placeholder set as config/env/CLI export (`{runId}` only)
- does not append success observation events
- returns a terse success/failure notification
- path resolution should match config export path rules

`/observe status` should include one terse export line when metrics export is enabled. If the configured display path and resolved display path are the same, show only `file`:

```text
export: metrics=onShutdown file=metrics/latest.json template=false
```

If they differ because of template expansion or absolute/relative resolution, show both:

```text
export: metrics=onShutdown file=metrics/{runId}.json resolved=metrics/run_abc123.json template=true
```

Omit the line when export is off. Render paths concisely for display, but report JSON still uses absolute paths.

## Export Timing

MVP default: write on pi `session_shutdown`.

For this feature, "shutdown" means the extension receives pi's graceful `session_shutdown` lifecycle event. This should cover normal pi exits such as `/quit`, graceful Ctrl-C quit behavior, and reload/session shutdown paths that pi reports through that event. It does not cover process crashes, `SIGKILL`, terminal death without graceful cleanup, or any path where pi does not deliver `session_shutdown`.

Shutdown export should happen after `runtime_detach` is appended so the run record status is `detached` and the report reflects final graceful shutdown state. Successful metrics export should not emit an observation event in MVP. The export file is derived from canonical run state, and success events would complicate shutdown ordering. Export failure on shutdown should emit an `error` observation event when possible because export is observability behavior and should be auditable. If emitting the error event also fails, fail soft and do not block shutdown. Do not retry export after emitting an export-failure error event; avoid shutdown loops and complexity.

Open design branch for later conversation:

- whether to also support periodic/after-event export for long-running headless sessions or crash resilience

Recommended MVP answer: only `onShutdown`; periodic export is post-MVP unless CI/headless use cases require mid-run snapshots.

## Report Format

Suggested JSON shape:

```ts
type MetricsExportReport = {
  schemaVersion: 1;
  exportedAt: number;
  exportFile: string;
  run: {
    runId: string;
    traceId: string;
    status: string;
    startedAt: number;
    endedAt?: number;
    cwd: string;
    projectRoot?: string;
    storageRoot: string;
    traceFile: string;
    primaryModel?: string;
  };
  metrics: RunMetrics;
  warnings?: string[];
};
```

Do not include empty/reserved projection fields in Milestone 03-1. If exported reports later include live-state/subagent projections, add that field when Milestone 07 projection support exists.

Report path fields (`exportFile`, `cwd`, `projectRoot`, `storageRoot`, and `traceFile`) should be absolute, matching `RunRecord` path conventions where applicable, so automation can open them directly. User-facing displays may still render relative paths elsewhere. Include only the resolved `exportFile`; do not include the raw configured path/template in MVP.

Report `warnings` should include runtime/export-relevant warnings only, such as incomplete metrics, degraded trace writes, or session-file-change ambiguity. Do not include config/catalog diagnostics in the metrics export report unless they directly affect export behavior.

Writers should write `schemaVersion: 1`. Future readers must treat missing schema version as `1` if a reader is added.

## Integration Notes

- Keep extension entrypoint thin; place report/export helpers in `src/observability/metrics-export.ts`. Observability owns metrics export; runtime provides run/status/store access.
- Use the current `RunRecord.metrics` from the persisted run record when possible.
- Both `/observe dump` and configured shutdown export should re-read the run record from disk best-effort before exporting; if read fails, fall back to the runtime's in-memory run status.
- Shutdown export ordering is: append `runtime_detach`, re-read the run record from disk best-effort, then write the export report.
- Do not recompute metrics from the trace during normal export unless needed for repair/recovery; the trace remains canonical but export should be cheap.
- Export failures must not disrupt pi execution, model/tool flows, or shutdown.
- Tests must not require real pi, network, credentials, or model calls.

## Suggested Implementation Sequence

1. Extract/reuse a small field-by-field present-value overlay helper for config precedence.
2. Extract `writeFileAtomic(file, data, options)` and refactor `TraceStore.writeRun()` to use it.
3. Extend `WorkbenchConfig` defaults, validation, merge behavior, and diagnostics with `observability` export fields.
4. Add `src/observability/metrics-export.ts` with pure option resolution, path/template resolution, report construction, and export writing helpers.
5. Register workbench CLI flags and wire startup/shutdown export in `src/extensions/workbench.ts` while keeping the entrypoint thin.
6. Extend `/observe status` and add `/observe dump` / `/observe dump --template`.
7. Add offline tests for config/env/CLI precedence, template validation, atomic write behavior, report shape, status rendering, slash command export, shutdown ordering, and failure handling.
8. Update user-facing `README.md` only once the implementation is complete.

## Acceptance Criteria

- Config loader accepts and validates the new `observability` section.
- CLI flags and environment variables can enable export and override destination.
- Relative destination paths resolve predictably.
- Export creates parent directories automatically.
- Export uses temp-file-then-rename writes to avoid partially written JSON under normal conditions.
- Export JSON is pretty-printed with 2 spaces.
- Implementation reuses/extracts the existing atomic-ish write pattern instead of duplicating it.
- Shutdown export writes a JSON report containing resolved export file, run identity, trace path, metrics, and warnings.
- Unknown usage metrics are omitted/undefined, not written as zero.
- `/observe dump <file>` writes the same report shape with literal path behavior.
- `/observe dump --template <file>` expands `{runId}` and writes the same report shape.
- Both slash-command and shutdown exports re-read the persisted run record best-effort before writing and fall back to in-memory runtime state if needed.
- Export failures fail soft and do not break observability persistence.
- Shutdown-triggered export is tied to pi `session_shutdown`; tests cover graceful shutdown and do not claim crash/SIGKILL export guarantees.
- `/observe status` shows a terse export line only when metrics export is enabled, including both configured and resolved display paths when they differ.
- Invalid config/env/CLI export values produce diagnostics visible via `/observe status` instead of silently disappearing.
- `README.md` user-facing docs include CLI/env/config examples and quote paths containing braces in shell examples; slash-command examples only quote paths when needed for spaces.
- `README.md` documents that absolute export paths are allowed and are user-controlled filesystem writes.
- `README.md` tells users to review project `.pi/workbench/config.json` because project config can enable metrics export.
- Project config absolute export paths produce a warning diagnostic but are still allowed.
- `npm test` passes offline.

## Future Conversation Decisions

Record resolved answers here as the design is grilled:

- Export location override: **yes, user-controlled via CLI/env/config/slash command**.
- Separate CLI: **no for MVP**.
- Command-line startup control: **yes; pi supports extension-defined flags via `registerFlag`, so provide a workbench metrics-file flag in addition to env/config**.
- Precedence: **field-by-field pi extension CLI flag > environment variables > project config > global config > defaults; higher layers override only fields they set**.
- Setting only a metrics file via env or CLI flag: **implies `onShutdown` unless explicitly disabled by a higher-precedence `off`**.
- CLI flag names: **use `--workbench-metrics-file` for the destination path; reserve `--workbench-metrics-export=off|onShutdown` for mode control**.
- Export write behavior: **overwrite the resolved file each time; do not append or rotate in MVP**.
- Concurrent runs targeting the same resolved file: **last writer wins; no cross-process locking in MVP**.
- Template mode: **add a simple opt-in `metricsExportTemplate` / `--workbench-metrics-template` / `PI_WORKBENCH_METRICS_TEMPLATE`; default off treats paths literally; support `{runId}` only in MVP**.
- Static vs templated output: **template mode does not preclude static stable paths; MVP writes one configured output only, not both latest and per-run files**.
- Template mode with no placeholder: **allowed; it behaves like a literal path**.
- Curly braces in file names: **allowed on common target filesystems, but quote shell examples containing braces**.
- Export failure handling: **emit an `error` observation event when possible, then fail soft**.
- Shutdown definition: **pi `session_shutdown` graceful lifecycle event; no guarantee for crashes, `SIGKILL`, or terminal death without graceful cleanup**.
- Slash command template behavior: **include both literal `/observe dump <file>` and explicit templated `/observe dump --template <file>`**.
- Slash command quoting: **do not quote `{runId}` solely for braces in slash-command examples; reserve quotes for paths with spaces if pi parsing requires them**.
- Projection fields in export report: **omit entirely in 03-1; add later only when live-state projection support exists**.
- Report path fields: **absolute paths, matching `RunRecord`, not display-relative paths**.
- Report export path: **include absolute resolved `exportFile` in the report; omit raw configured path/template in MVP**.
- Report warnings: **runtime/export-relevant warnings only; omit config/catalog diagnostics unless they directly affect export behavior**.
- Successful export event: **none in MVP; only failures emit `error` when possible**.
- Shutdown export ordering: **append `runtime_detach` first, then export so report status reflects detached**.
- Export failure retry: **no retry in MVP, including after emitting an export-failure `error` event**.
- Run record freshness: **both `/observe dump` and configured shutdown export re-read the persisted run record best-effort; fallback to in-memory runtime state; no trace recompute in MVP**.
- Parent directories: **create automatically with recursive directory creation; failures fail soft and may emit `error` where appropriate**.
- Export write atomicity: **use temp-file-then-rename in the target directory rather than direct writes**.
- Atomic write reuse: **extract/reuse the existing `TraceStore.writeRun()` pattern into a tiny dependency-free core helper (`src/core/fs.ts` or `src/core/atomic-write.ts`); primitive is `writeFileAtomic(file, data, options)` unless text/binary distinction is needed; refactor `TraceStore.writeRun()` and metrics export to use it**.
- Atomic write parent dirs: **helper takes `createParentDirs?: boolean`, default `false`; metrics export passes `true`**.
- JSON formatting: **pretty-print with 2 spaces; optional JSON helper may wrap `writeFileAtomic`**.
- Atomic temp name: **include pid + timestamp + random suffix**.
- Atomic temp cleanup: **best-effort unlink temp file on failure; preserve original error**.
- Export path containment: **allow absolute paths outside project from config/env/CLI/slash command; relative paths resolve against project root; document user-controlled filesystem write behavior**.
- Project config opt-in: **project config may enable export by itself; document review/security implication**.
- Project config absolute path warning: **warn but allow absolute `observability.metricsExportFile` in project config; no warning needed for global/env/CLI/slash absolute paths**.
- `/observe status` export display: **include one terse export line when metrics export is enabled; show both configured and resolved display paths when they differ; omit when off**.
- Precedence implementation reuse: **extract/reuse field-by-field present-value overlay logic from config merging instead of duplicating precedence code for export options; likely place it in `src/config/merge.ts`; reuse it for global/project config merge and metrics export option resolution; keep feature-specific policy outside the primitive; avoid over-generalized deep-merge magic**.
- Slash command precedence: **`/observe dump` is a one-shot action and does not participate in or mutate CLI/env/config export precedence**.
- Export module location: **`src/observability/metrics-export.ts`; keep `workbench.ts` thin**.
- Invalid export option handling: **config/env/CLI invalid values produce diagnostics visible in `/observe status`; do not silently ignore**.
- Mode names: **use exact string values `"off"` and `"onShutdown"` across config/env/CLI; no aliases in MVP; invalid values warn**.
- Invalid mode fallback: **invalid explicit mode is treated as unset; a provided metrics file still implies `onShutdown` with a warning, except explicit higher-precedence `off` wins and lower-precedence file values do not re-enable export**.
- Invalid template fallback: **warn and fall back to `false`; `{runId}` remains literal when template mode is false**.
- Placeholder-with-template-off warning: **warn but allow literal path when `{runId}` appears and template mode is false**.
- Unknown placeholders with template on: **treat any `{...}` as a placeholder candidate; anything except `{runId}` is fatal to that export; unmatched braces are invalid; warn/error and skip rather than leave literal**.
