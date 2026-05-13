# Milestone 03 — Config + Agent Catalog

## Goal

Implement configuration loading and markdown agent discovery/validation for named subagents.

This milestone should be expanded and maintained as an implementation-ready specification, similar in depth and structure to Milestone 02. Config and catalog behavior is policy-heavy enough that implementers should not need to infer defaults, precedence, diagnostics, parsing behavior, or test coverage from surrounding milestones.

This milestone should be implementable after reading `AGENTS.md`, the required implementation docs, prior milestone docs as needed, and this file.

## Depends On

- Milestone 01 core trace/types foundation.
- Milestone 02 shared runtime, cohesive `workbench.ts` extension wiring, and `/observe status`.

## Scope

Implement:

- `src/config/workbench-config.ts`
- `src/config/index.ts`
- `src/subagents/agent-catalog.ts`
- `src/subagents/index.ts`
- config loader
- agent markdown parser
- catalog discovery
- trust/precedence rules
- warnings/diagnostics suitable for `/subagent list` later
- read-only startup wiring from the cohesive `src/extensions/workbench.ts`

Milestone 03 should load config and the agent catalog on workbench startup/reload after `runtime.start()` succeeds. Parent observability/run lifecycle should initialize even if config/catalog loading is broken. The wiring must remain read-only: do not implement process execution, manual `/subagent` commands, prompt injection, model-callable tools, or delegation.

Loaded config/catalog state should be kept in memory for the current extension attachment, in a small workbench services/state object owned by `workbench.ts` or runtime-adjacent wiring, not persisted into `RunRecord` and not written as trace history.

Suggested shape:

```ts
type WorkbenchServices = {
  configLoadResult?: WorkbenchConfigLoadResult;
  agentCatalog?: AgentCatalog;
  startupDiagnostics: WorkbenchDiagnostic[];
};
```

`/observe status` should read diagnostic counts from this state and combine them with `runtime.getStatus()` output in the extension/status renderer. Keep `WorkbenchRuntimeStatus` focused on run lifecycle and trace health; do not add catalog state to the runtime API. Later `/subagent list`, runner, and delegation milestones should consume this shared loaded catalog instead of reloading independently.

Normal config/catalog validation diagnostics should remain in runtime/status data and should not be emitted as observation trace events. If startup wiring encounters an unexpected loader exception, catch it so pi startup continues. Store an error diagnostic in startup state, keep parent observability working, and notify once via `ctx.ui.notify` when available with a concise message such as `workbench config/catalog load failed; subagents unavailable`. `/observe status` should reflect the config/catalog error count. Do not throw and break pi startup.

`/observe status` should include only terse config/catalog diagnostic counts when warnings/errors are present, for example `warnings: agent catalog warnings=2`. Do not print detailed diagnostics there, and do not introduce rich catalog browsing or subagent commands in Milestone 03.

## Config API

The config loader should return a rich load result, not only a merged config. Later commands and diagnostics need to explain where settings came from and why project agents were or were not loaded.

Suggested shape:

```ts
type WorkbenchConfigLoadResult = {
  effectiveConfig: WorkbenchConfig;
  globalConfig?: LoadedWorkbenchConfigFile;
  projectConfig?: LoadedWorkbenchConfigFile;
  diagnostics: WorkbenchDiagnostic[];
  paths: {
    globalConfigFile: string;
    projectConfigFile?: string;
    projectRoot?: string;
  };
};
```

`effectiveConfig` is the only value execution code should consult for policy. The additional fields are for diagnostics, status/list commands, and tests.

## Config Locations

Global defaults:

```text
~/.pi/agent/workbench/config.json
```

Production loading should use `os.homedir()` for `~`, but config/catalog APIs should accept an explicit `homeDir?: string` for offline tests and alternate harnesses. Tests must use temp home directories and must not read or mutate the real user config.

Suggested loader input:

```ts
type LoadWorkbenchConfigInput = {
  cwd: string;
  baseDir?: string;
  homeDir?: string;
};

async function loadWorkbenchConfig(input: LoadWorkbenchConfigInput): Promise<WorkbenchConfigLoadResult>;
```

Project overrides:

```text
<project>/.pi/workbench/config.json
```

Project location resolution should match the core `TraceStore` project/storage policy:

- if `cwd` is inside a git repository, `<project>` is the git repository root
- otherwise `<project>` is the resolved current working directory
- project agents and project config should be discovered from the same project root used for default workbench storage

Implementation note: Milestone 01 already has `resolveWorkbenchPaths()` / git-root discovery for trace storage. Prefer refactoring or reusing that shared path-resolution helper instead of duplicating git-root walking logic in the config/catalog module. If the existing helper is too trace-store-specific, extract a small core project-path helper and keep trace/config callers aligned.

Project config wins over global config.

Writers should write `schemaVersion: 1`; readers treat missing schema version as `1`.

Missing files/directories are normal; unreadable files/directories are actionable:

- missing config file: no diagnostic; defaults are normal
- missing agents directory: no diagnostic; empty tier is normal
- unreadable config file: warning diagnostic; use defaults or the other config tier where possible
- unreadable agents directory: warning diagnostic; skip that tier
- unreadable individual agent file: warning diagnostic; skip that file

Config should warn on unknown fields but continue.

## Config Shape

Milestone 03 should define the full MVP-relevant config surface so later subagent and delegation milestones do not need to churn config format. Milestone 03 only consumes config fields needed for catalog loading and read-only status/diagnostics; later milestones consume execution/delegation fields.

```ts
type WorkbenchConfig = {
  schemaVersion: 1;
  agents: {
    trustProjectAgents: boolean;
  };
  subagents: {
    defaultTools: string[];
    defaultTimeoutMs: number;
    loadExtensions: boolean;
  };
  delegation: {
    enabledByDefault: boolean;
    allowFullContext: boolean;
    maxParallel: number;
  };
};
```

Defaults:

```json
{
  "schemaVersion": 1,
  "agents": { "trustProjectAgents": false },
  "subagents": {
    "defaultTools": ["read", "grep", "find", "ls"],
    "defaultTimeoutMs": 600000,
    "loadExtensions": false
  },
  "delegation": {
    "enabledByDefault": false,
    "allowFullContext": false,
    "maxParallel": 4
  }
}
```

Validation/coercion policy:

- readers treat missing `schemaVersion` as `1`
- unsupported schema versions produce a diagnostic and ignore that file
- malformed/invalid JSON config files produce `config_invalid_json`, skip that entire config file, and continue with built-in defaults plus the other valid config tier; do not attempt partial recovery from malformed JSON
- unknown fields produce warning diagnostics and are ignored
- invalid field values produce diagnostics and fall back to defaults for those fields
- `subagents.defaultTimeoutMs` must be an integer greater than `0` and no more than `86_400_000` milliseconds; invalid values fall back to the default
- `delegation.maxParallel` must be an integer from `1` through `16`; invalid values fall back to the default
- `subagents.defaultTools` must be an array of valid tool-name strings; `[]` is valid and means no default tools
- invalid `subagents.defaultTools` type/item values produce a diagnostic and fall back to the default `['read', 'grep', 'find', 'ls']` rather than silently disabling tools
- project config overrides global config with a deep field-by-field merge after validation/defaulting
- top-level project sections do not replace global sections wholesale

Example: if global config sets `subagents.defaultTimeoutMs` and `subagents.defaultTools`, while project config sets only `subagents.loadExtensions`, the effective config preserves the global timeout/tools and applies the project load-extensions override.

## Diagnostics

Config loading and agent catalog loading should use one shared diagnostic shape so commands, tests, and future UI can render warnings consistently. Define this shared type in `src/core/diagnostics.ts` and export it from `src/core/index.ts`; config, catalog, runtime/status, delegation, and future UI should import the shared core type rather than defining local diagnostic shapes.

Suggested shape:

```ts
type WorkbenchDiagnostic = {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  filePath?: string;
  relatedFilePath?: string;
  agentName?: string;
  count?: number;
  fieldPath?: string;
  hint?: string;
};
```

Initial diagnostic codes should be stable enough for tests and UI, while allowing additional codes when useful.

Config codes:

- `config_unreadable`
- `config_invalid_json`
- `config_unsupported_schema`
- `config_unknown_field`
- `config_invalid_field`

Catalog codes:

- `agents_dir_unreadable`
- `agent_file_unreadable`
- `project_agents_untrusted`
- `project_agents_globally_trusted`
- `agent_frontmatter_invalid`
- `agent_unknown_field`
- `agent_name_invalid`
- `agent_description_missing`
- `agent_description_invalid`
- `agent_prompt_empty`
- `agent_field_invalid`
- `agent_duplicate_name`
- `agent_case_collision`
- `agent_shadowed`

Rules:

- diagnostics are returned as data, not printed directly by loaders
- normal config/catalog validation diagnostics are not emitted as observation trace events by default
- invalid config files produce diagnostics and the loader continues with defaults where possible
- invalid individual agents produce diagnostics and that agent is skipped
- unknown config or frontmatter fields produce warning diagnostics and loading continues
- diagnostics should contain enough path/name/code detail for later `/subagent list` output and offline tests

## Catalog API

Avoid duplicating catalog state by returning a deterministic agent array plus lookup helpers, rather than both an array and a map.

Suggested shape:

```ts
type AgentCatalog = {
  agents: AgentDefinition[];
  diagnostics: WorkbenchDiagnostic[];
  paths: {
    globalAgentsDir: string;
    projectAgentsDir?: string;
  };
};

function findAgent(catalog: AgentCatalog, name: string): AgentDefinition | undefined;

type LoadAgentCatalogInput = {
  cwd: string;
  homeDir?: string;
  config: WorkbenchConfigLoadResult;
};
```

`loadAgentCatalog()` should be async and accept the full `WorkbenchConfigLoadResult` so it can reuse resolved paths and diagnostics context while consulting `config.effectiveConfig` for policy such as `agents.trustProjectAgents`. Avoid recomputing project-root/global paths independently from config loading.

Rules:

- `agents` is the canonical loaded catalog representation
- sort `agents` by name for stable `/subagent list`, tests, and later prompt/catalog injection
- `findAgent()` is case-sensitive and matches exact names only
- MVP catalog sizes are expected to be small, so linear lookup over the sorted array is acceptable
- lookup helpers may optimize internally later if needed, but the public catalog result should not store duplicate array/map state
- skipped/duplicate/invalid agents are represented only through diagnostics, not hidden catalog entries

## Agent Discovery

MVP discovery locations:

```text
~/.pi/agent/workbench/agents/*.md
<project>/.pi/workbench/agents/*.md
```

Examples/package defaults are reference-only in MVP:

- no auto-loading package defaults
- no auto-copy/init behavior

## Project Trust

Project agents require effective config:

```json
{
  "agents": {
    "trustProjectAgents": true
  }
}
```

If project agent `.md` files exist but trust is not enabled, this must not be silent:

- do not load them
- add one warning diagnostic summarizing the skipped project agent files, including count, agents directory path, and a reload/config hint
- include useful reload/config hints for later `/subagent list`
- evaluate trust before reading/parsing individual project agent files
- when untrusted, count `.md` files for the summary diagnostic but do not parse their contents
- do not emit one warning per file unless there is a distinct per-file problem that must be surfaced

Suggested diagnostic:

```ts
{
  severity: "warning",
  code: "project_agents_untrusted",
  message: "project agents are present but not trusted; skipped 3 agent file(s)",
  filePath: "<project>/.pi/workbench/agents",
  hint: "set agents.trustProjectAgents=true in <project>/.pi/workbench/config.json and reload"
}
```

Project self-trust is weak and accepted only for MVP. Trusted roots are post-MVP.

`agents.trustProjectAgents` may come from global or project config through normal effective config merging. If global config sets `agents.trustProjectAgents: true`, honor it but emit a warning diagnostic because it trusts project agents for all projects. Suggested code: `project_agents_globally_trusted`; suggested hint: prefer project-local trust for specific repositories when possible.

## Precedence

Agent precedence:

1. trusted project agents
2. global user agents
3. package examples/defaults if ever surfaced as references only

Duplicate names across tiers resolve by precedence.

Duplicate detection and precedence should operate on parsed/inferred agent names, not just filenames. Parse each trusted/readable file enough to determine a valid name, skip invalid-name files individually, group valid candidates by name within each tier, skip all same-tier duplicate groups with diagnostics, then apply cross-tier precedence.

Duplicate names within the same tier should be warning-only conflicts, not startup failures. Skip all files for the conflicting name within that tier, emit warning diagnostics for each conflicting file, and continue loading the rest of the catalog. Do not keep one arbitrarily based on filename order.

Cross-tier duplicates are resolved by precedence only for actually loaded higher-precedence agents: a valid trusted project agent overrides a global user agent. Untrusted project agents, invalid/skipped project agents, and same-tier duplicate-conflicted project names do not shadow global agents. Emit an `info` diagnostic with code `agent_shadowed` when a global agent is shadowed by a project agent; this is expected precedence behavior, not a warning.

Invalid agent markdown should be skipped with warnings, not fail the whole catalog.

## Agent Name Rules

Agent names should be strict and friendly for CLI commands and model-callable delegation tools.

Rules:

- name comes from frontmatter `name` if present, otherwise the markdown filename stem
- trim surrounding whitespace
- max length is 64 characters
- valid pattern: `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`
- names are case-sensitive internally
- case-insensitive collisions should be treated as conflicts because they can confuse manual commands and delegated tool calls; skip all affected agents and emit warning diagnostics such as `agent_case_collision`
- invalid names skip that agent with a diagnostic

## Skipped Agent Behavior

Invalid individual agents must not fail startup/reload or prevent other agents from loading. Skipping an agent should:

- omit that agent from the loaded catalog
- add a structured diagnostic with file path, code, concise reason, and fix/reload hint when useful
- avoid noisy per-agent user notifications during startup
- allow `/observe status` to show terse warning/error counts
- allow later `/subagent list` to display loaded agents plus skipped-agent diagnostics

Missing required fields, invalid names, invalid YAML, invalid tool lists, and same-tier duplicate conflicts are all handled by skipping the affected agent file with diagnostics rather than throwing.

## Description vs System Prompt

`description` and the markdown body have different audiences:

- `description` is short parent-facing catalog text. It helps later delegation prompt/tool guidance explain when the parent LLM should call a named subagent.
- The markdown body is the child-facing system prompt used when launching that subagent.

Milestone 03 validates and stores both, but does not inject agent descriptions into the parent prompt. Delegation prompt/catalog injection is Milestone 06 behavior and remains gated by `/delegation on` or equivalent session-scoped enablement.

`description` is required for loaded named agents: it must be a non-empty string after trimming. Missing, invalid, or excessively long descriptions skip the agent with a diagnostic. The maximum description length is 500 characters.

The markdown body/system prompt is also required for loaded named agents. After removing frontmatter and trimming whitespace, the body must be non-empty; otherwise skip the agent with a diagnostic.

These requirements apply only to named catalog agents loaded from markdown files. Later manual ad-hoc subagents are not catalog entries, do not require `name` or `description`, and are not exposed as named delegation targets in the MVP.

## Agent Definition

MVP shape:

```ts
type AgentDefinition = {
  name: string;
  description: string;
  systemPrompt: string;
  iq?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools?: string[];
  source: "user" | "project" | "package";
  filePath?: string;
  systemPromptMode?: "append" | "replace";
  loadContextFiles?: boolean;
};
```

Keep MVP definitions simple. Defer fallback models, memory, skills, scheduling, worktrees, and rich policies.

Milestone 03 should not validate `iq` or `model` against actual available pi models/providers. Catalog loading must remain offline and independent of provider credentials. Validate only basic shape:

- `iq`: optional non-empty string
- `model`: optional non-empty string
- `thinking`: optional enum `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`

Concrete model/IQ availability and fail-fast behavior belong to the Milestone 04 model/IQ resolver and runner path. However, if `iq` or `model` is explicitly present in frontmatter, it must be a non-empty string after trimming; invalid or empty explicit values skip the agent with a diagnostic rather than silently falling back to defaults.

## Frontmatter Validation Helpers

Implement frontmatter validation through small reusable pure helpers rather than one-off checks for each field. Optional policy fields should follow one consistent rule: missing means default/undefined, but explicitly invalid values skip the agent when the field affects execution behavior.

Useful helper categories:

```ts
readRequiredStringField(...)
readOptionalStringField(...)
readOptionalBooleanField(...)
readOptionalEnumField(...)
readOptionalStringArrayField(...)
warnUnknownFields(...)
```

Keep the helpers simple and local to catalog parsing unless they clearly benefit config validation too. Config validation may share low-level primitives such as object checks, optional booleans, positive integers, string arrays, and unknown-field detection, but config and frontmatter policy should remain explicit because invalid config fields fall back to defaults while invalid agent execution-policy fields usually skip that agent. Avoid building a large validation framework.

## Prompt/Frontmatter Decisions

Milestone 03 supports YAML frontmatter only, using the common `--- ... ---` block at the start of the markdown file. Do not support JSON or TOML frontmatter in the MVP.

Use the `yaml` package for frontmatter parsing and add it as a runtime `dependencies` entry if it is not already present. This is acceptable because parsing occurs only during startup/reload catalog loading, not on parent event/tool hot paths. Keep YAML imports scoped to the catalog parser module rather than core/runtime modules. Cache the loaded catalog in workbench state after startup so status/lookup paths do not repeatedly parse files.

Parsing rules:

- if no frontmatter exists, infer the name from the filename stem and use the full markdown body as the system prompt
- invalid YAML frontmatter skips that agent with a diagnostic
- frontmatter values must have the expected scalar/array types; invalid known execution-policy values skip the agent rather than falling back silently
- unknown/deferred frontmatter fields produce warning diagnostics and are ignored
- do not coerce objects or unusual values into strings/arrays

Allowed frontmatter fields:

- required: `description`
- optional: `name`, `iq`, `model`, `thinking`, `tools`, `systemPromptMode`, `loadContextFiles`

Explicitly deferred/unknown fields include `context`, `fallbackModel`, `memory`, `skills`, `worktree`, `schedule`, `permissions`, and anything else not in the allowed list. These fields should warn and be ignored, not skip the agent by themselves.

Invalid required fields such as `description`, invalid/inferred `name`, or empty body skip the agent. Invalid execution-policy fields that would make behavior ambiguous or unsafe, such as `tools`, `systemPromptMode`, or `thinking`, should also skip the agent. Unknown/deferred fields alone should not skip the agent.

Prompt decisions:

- Agents are named markdown definitions.
- Markdown body is the child system prompt content.
- `systemPromptMode` supports `append` and `replace`; default `append`.
- Missing `systemPromptMode` means `append`.
- Invalid `systemPromptMode` type/value skips the agent with a diagnostic because prompt composition policy would otherwise be ambiguous.
- Markdown body appends to child pi default prompt by default unless frontmatter says replace.
- Tool lists in frontmatter are strict allowlists.
- `loadContextFiles` may be set in frontmatter; default is `false`.
- Missing `loadContextFiles` means `false`.
- Invalid `loadContextFiles` type/value skips the agent with a diagnostic because explicit context-loading policy would otherwise be ambiguous.
- Agent frontmatter must not set context defaults in MVP.
- Context mode is selected by caller/run request, not agent definition.

## Tool Allowlist Rules

Tool lists are strict allowlists.

Rules:

- if agent frontmatter has `tools`, use it exactly as the agent's strict allowlist
- if `tools` is absent, use `effectiveConfig.subagents.defaultTools`
- `tools: []` is valid and means no tools
- tool names must be non-empty strings matching `^[a-zA-Z0-9_.:-]+$`
- invalid tool lists skip the agent with a diagnostic because execution policy would otherwise be ambiguous

## Default Tools

`subagents.defaultTools` is configurable.

Fallback default tools:

```text
read, grep, find, ls
```

## Package Manifest Update

Because Milestone 03 uses YAML parsing at runtime, add `yaml` to `dependencies`, not only `devDependencies`. Pi package installs use production/runtime dependencies, so a parser used by `src/extensions/workbench.ts` through catalog loading must be installed for normal package loading.

Keep `@earendil-works/pi-coding-agent` as a peer/dev dependency as currently appropriate, keep `package.json` `pi.extensions` pointing at `src/extensions/workbench.ts`, and do not move the cohesive workbench extension entrypoint.

## README Update

Update `README.md` minimally for implemented Milestone 03 behavior:

- global and project config file locations
- named agent markdown file locations
- project agents require `agents.trustProjectAgents: true`
- `/observe status` shows terse config/catalog warning/error counts when present
- `/subagent` commands are not available until later milestones

Keep Milestone 03 README content brief. Do not add full user-agent documentation or an examples directory yet; richer docs/examples are better introduced with Milestone 05 when users can list and run agents. Do not document how to run subagents yet.

## Reload Behavior

Config and agent catalogs load at startup/reload.

Users use normal pi `/reload` after edits. Do not add a custom workbench reload command in Milestone 03; explicit config/catalog reload semantics can wait until a concrete UX requires them.

## Testing

Add two focused test files:

```text
tests/config-agent-catalog.test.ts
tests/workbench-config-startup.test.ts
```

`tests/config-agent-catalog.test.ts` covers pure config/catalog loading with temp home/project directories and fixture markdown files.

`tests/workbench-config-startup.test.ts` covers cohesive extension startup wiring with a fake pi extension harness, including status warning counts and fail-soft loader behavior.

Use temp HOME/project directories and fixture markdown files.

Tests should assert stable diagnostic `code`, `severity`, relevant paths/counts, and important hints where applicable rather than exact full prose messages. Diagnostic message text may evolve for clarity; codes are the stable test/UI contract.

Test:

- config defaults, missing files, and schema version defaulting
- global/project config loading and deep field-by-field merge
- invalid JSON/config field fallback behavior
- unknown config fields warning without failure
- project-root resolution aligned with trace storage, including git-root and non-git cwd cases
- global loading
- project trust gate, including untrusted project-agent summary diagnostics
- global `trustProjectAgents: true` warning behavior
- precedence and shadowing info diagnostics
- exact duplicate warnings/skips
- case-insensitive collision warnings/skips
- invalid markdown/frontmatter warnings/skips
- unknown/deferred frontmatter warnings without skipping
- strict field validation for `description`, body, `tools`, `systemPromptMode`, `loadContextFiles`, `iq`, `model`, and `thinking`
- catalog sorting and case-sensitive `findAgent()`
- startup wiring loads config/catalog after runtime start
- `/observe status` includes terse config/catalog warning/error counts
- unexpected loader failure does not break startup or parent observability

## Suggested Implementation Sequence

1. Add `src/core/diagnostics.ts` and export `WorkbenchDiagnostic` from `src/core/index.ts`.
2. Refactor/reuse core project path resolution so config/catalog and `TraceStore` use the same git-root/fallback behavior.
3. Add `src/config/workbench-config.ts` with defaults, async config loading, validation, deep merge, diagnostics, and tests.
4. Add `yaml` to runtime `dependencies` in `package.json`.
5. Add `src/subagents/agent-catalog.ts` with YAML frontmatter parsing, validation helpers, trust gate, precedence, sorting, `findAgent()`, and tests.
6. Wire read-only config/catalog loading into `src/extensions/workbench.ts` after `runtime.start()` and keep loaded state in an in-memory services object.
7. Update `/observe status` rendering to include terse config/catalog warning/error counts.
8. Update `README.md` minimally for implemented config/catalog discovery behavior.
9. Run `npm test` offline.

## Acceptance Criteria

- `npm test` passes offline.
- `yaml` is listed as a runtime dependency and the cohesive workbench extension entrypoint remains `src/extensions/workbench.ts`.
- Config/catalog loading does not require pi, network, provider credentials, or model availability.
- Config loader supports global and project config locations, missing schema version as `1`, malformed JSON file skipping, unknown-field diagnostics, validation fallback, and deep field-by-field project-over-global merge.
- Config/catalog project-root resolution matches trace storage behavior and reuses/refactors shared path logic rather than duplicating git-root discovery.
- Project agents are skipped unless effective config trusts them; untrusted project agent files produce a non-silent summary warning diagnostic.
- Global `agents.trustProjectAgents: true` is honored and produces a warning diagnostic.
- Agent catalog loading supports YAML frontmatter, required descriptions, required non-empty markdown body for named agents, strict name validation, strict tool allowlists, prompt-mode/context-file flags, and offline-only model/IQ/thinking shape validation.
- Unknown/deferred frontmatter fields warn and are ignored without skipping the agent by themselves.
- Invalid required fields and invalid execution-policy fields skip only the affected agent with diagnostics.
- Same-tier exact duplicates and case-insensitive name collisions skip affected agents with diagnostics.
- Valid trusted project agents shadow global agents; shadowed global agents produce `info` diagnostics.
- Catalog returns a canonical name-sorted `agents` array and a case-sensitive `findAgent()` helper, without storing duplicate public map state.
- Read-only startup wiring loads config/catalog after runtime initialization, stores state in memory, and does not persist config/catalog as run records or trace events.
- Unexpected config/catalog loader exceptions fail soft, notify once when possible, preserve parent observability, and surface error counts in `/observe status`.
- `/observe status` remains concise and shows only terse config/catalog diagnostic counts.
- README is updated with brief implemented config/catalog locations, trust behavior, status-count note, and no premature subagent execution docs.
