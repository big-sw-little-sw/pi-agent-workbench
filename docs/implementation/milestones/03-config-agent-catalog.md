# Milestone 03 — Config + Agent Catalog

## Goal

Implement configuration loading and markdown agent discovery/validation for named subagents.

This milestone should be implementable after reading `AGENTS.md`, the required implementation docs, prior milestone docs as needed, and this file.

## Depends On

- Milestone 01 core types for `AgentDefinition`-adjacent contracts.
- Milestone 02 runtime only if reload/status warnings are wired into runtime events.

## Scope

Implement:

- config loader
- agent markdown parser
- catalog discovery
- trust/precedence rules
- warnings/diagnostics suitable for `/subagent list` later

Do not implement process execution, manual run commands, or delegation.

## Config Locations

Global defaults:

```text
~/.pi/agent/workbench/config.json
```

Project overrides:

```text
<project>/.pi/workbench/config.json
```

Project config wins over global config.

Writers should write `schemaVersion: 1`; readers treat missing schema version as `1`.

Config should warn on unknown fields but continue.

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

Project agents require:

```json
{
  "agents": {
    "trustProjectAgents": true
  }
}
```

If project agents exist but trust is not enabled:

- do not load them
- expose warnings/diagnostics
- include useful reload/config hints for later `/subagent list`

Project self-trust is weak and accepted only for MVP. Trusted roots are post-MVP.

## Precedence

Agent precedence:

1. trusted project agents
2. global user agents
3. package examples/defaults if ever surfaced as references only

Duplicate names across tiers resolve by precedence.

Duplicate names within the same tier should produce warnings/conflicts and skip or choose deterministically; prefer skipping conflicting same-tier duplicates with a clear warning.

Invalid agent markdown should be skipped with warnings, not fail the whole catalog.

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

## Prompt/Frontmatter Decisions

- Agents are named markdown definitions.
- Markdown body is the child system prompt content.
- `systemPromptMode` supports `append` and `replace`; default `append`.
- Markdown body appends to child pi default prompt by default unless frontmatter says replace.
- Tool lists in frontmatter are strict allowlists.
- `loadContextFiles` may be set in frontmatter; default is `false`.
- Agent frontmatter must not set context defaults in MVP.
- Context mode is selected by caller/run request, not agent definition.

## Default Tools

`subagents.defaultTools` is configurable.

Fallback default tools:

```text
read, grep, find, ls
```

## Reload Behavior

Config and agent catalogs load at startup/reload.

Users use normal pi `/reload` after edits. Implement custom reload commands only if trivial; do not expand scope.

## Testing

Use temp HOME/project directories and fixture markdown files.

Test:

- global loading
- project trust gate
- precedence
- duplicate warnings
- invalid markdown warnings
- unknown config fields warning without failure
- schema version defaulting

## Acceptance Criteria

- `npm test` passes offline.
- Catalog loading does not require pi, network, or model credentials.
- Project agents are skipped unless trusted.
- Invalid agents do not fail the whole catalog.
- Diagnostics contain enough information for `/subagent list` to show loaded agents plus warnings/reload hints later.
