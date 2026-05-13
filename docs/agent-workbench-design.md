# Pi Agent Workbench Design

Purpose: design a pi-based workbench for experimenting with agentic workflows, subagents, control strategies, and observability. This document is the shared reference for future discussion.

## Goals

- Run specialized subagents with isolated context.
- Compare workflow-control styles:
  - manual user control
  - programmatic/YAML workflow control
  - parent-LLM delegated control
  - hybrid control
- Measure real outputs and operational metrics.
- Observe parent and child agents live.
- Inspect subagent internals without giving unintended control to the parent LLM.
- Keep observability reusable outside subagents.

## Core Principle

Separate capability, control, and measurement.

```text
subagents:      can run agents
workflows:      decide what runs, when, and under which policy
delegation:     lets the parent LLM decide, only when enabled
observability:  records, renders, exports, and compares what happened
workbench:      experiment management, benchmarks, reports
```

Do not make subagent existence imply parent-LLM control.

## Proposed Package Layout

Code should live in a package repo, private or public, with all related pi extensions shipped together. Global config provides defaults; project config overrides global config.

Development target:

```text
~/sw/code/pi-agent-workbench/
```

Package shape:

```text
agent-workbench/
├── src/
│   ├── core/
│   │   ├── subagent-runtime.ts
│   │   ├── workflow-engine.ts
│   │   ├── model-iq.ts
│   │   ├── agent-definitions.ts
│   │   ├── observation-events.ts
│   │   ├── trace-store.ts
│   │   └── run-records.ts
│   └── extensions/
│       ├── subagents.ts
│       ├── workflows.ts
│       ├── delegation.ts
│       ├── observability.ts
│       └── workbench.ts
├── agents/
├── workflows/
├── prompts/
└── package.json
```

## Components

### `subagent-core`

Plain TypeScript library, not policy-aware.

Responsibilities:

- Load agent definitions.
- Resolve model/IQ mapping.
- Build child system prompts.
- Run child agents via process or SDK runner.
- Emit normalized events.
- Return structured results.

Non-responsibilities:

- Deciding when to use agents.
- Injecting parent-LLM guidance.
- Rendering UI.
- Evaluating workflow quality.

### `subagents` Extension

Thin pi extension around `subagent-core`.

Responsibilities:

- `/subagent list`
- `/subagent show <agent>`
- `/subagent run <agent> <task>`
- `/subagent cancel <agent-id>`
- Manual subagent execution.
- Optional direct configuration commands.

Default behavior:

- Do not register model-callable subagent tool.
- Do not inject subagent-selection guidance into the parent system prompt.

### `workflows` Extension

User/programmatic control plane.

Responsibilities:

- Run YAML/JSON/TS workflows.
- Validate and dry-run workflows.
- Execute chains, DAGs, fan-out/fan-in, gates, retries.
- Call `subagent-core` directly.
- Record structured workflow runs.

Example commands:

```text
/workflow list
/workflow validate <file-or-name>
/workflow dry-run <file-or-name>
/workflow run <file-or-name> key=value
/workflow inspect <run-id>
/workflow abort <run-id>
```

### `delegation` Extension

Optional LLM control surface.

Responsibilities:

- Register the model-callable `subagent` tool.
- Inject structured subagent catalog into the parent system prompt.
- State delegation policy clearly.
- Constrain allowed agents, tools, models, IQ, concurrency, and budget.

Enable only when testing LLM-controlled workflows.

### `observability` Extension

Measurement and live UI layer.

Responsibilities:

- Observe parent events.
- Observe child events.
- Observe workflow/delegation events.
- Normalize all events into a common schema.
- Maintain live run state.
- Render status, widgets, inspector views.
- Persist traces.
- Export reports.

Should work regardless of control mode and should be useful even when no subagents are enabled. In that case it observes only the parent pi session: parent turns, model usage, tool calls, cost, context usage, cache metrics when available, errors, and outputs.

### `workbench` Extension

Experiment manager.

Responsibilities:

- List runs.
- Compare runs.
- Benchmark workflow variants.
- Generate reports.
- Manage evaluation artifacts.

Example commands:

```text
/workbench runs
/workbench open <run-id>
/workbench compare <run-a> <run-b>
/workbench benchmark <workflow-or-dir>
/workbench report <run-id> <file>
```

## Control Modes

```ts
type ControlMode = "manual" | "workflow" | "llm-delegated" | "hybrid";
```

| Mode | Subagent tool active? | Prompt guidance injected? | Decision maker |
|---|---:|---:|---|
| `manual` | No | No | User commands |
| `workflow` | No | No | Workflow engine/YAML |
| `llm-delegated` | Yes | Yes | Parent LLM |
| `hybrid` | Bounded | Bounded | Workflow + LLM within policy |

Important: UI observability can be enabled in all modes without enabling LLM control.

## Avoiding Unintended LLM Control

Manual/workflow modes must:

- Not activate the `subagent` tool for the parent model.
- Not inject the agent catalog into the parent system prompt.
- Run subagents only through commands or workflow engine calls.
- Show subagent activity to the user via observability UI.

LLM-delegated mode may:

- Activate the `subagent` tool.
- Inject structured subagent guidance.
- Let the parent LLM choose agents within policy.

## Subagent Execution Backends

### Process Runner

Runs child agents via:

```bash
pi --mode json -p --no-session --model <model> --tools <tools> ...
```

Pros:

- Strong isolation.
- Easy crash containment.
- Easy abort by killing process.
- Works well with pi JSON stream.
- Good first implementation.

Cons:

- More process overhead.
- Requires JSON parsing.
- Harder to share in-memory services.
- More env/auth propagation details.

### SDK Runner

Runs child agents using `createAgentSession()`.

Pros:

- Typed direct events.
- Richer control.
- Easier custom system prompts/tools/context.
- Lower process overhead.

Cons:

- Less isolation.
- More lifecycle complexity.
- Must prevent recursive extension loading if undesired.
- Harder to hard-kill runaway tasks.

Recommendation: start with process runner; hide behind a `SubagentRunner` interface so SDK runner can be added later.

### Community Implementation References

Planning/implementation agents should review these repositories before changing subagent execution, but must keep this design and `docs/implementation/00-contracts-and-boundaries.md` authoritative.

- [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents): process-based runner and rich orchestration package. Reference `src/runs/shared/pi-args.ts` for child `pi --mode json -p` argument construction, recursion guard environment variables, temp prompt/task files, and model/thinking argument handling. Reference `src/runs/foreground/execution.ts`, `src/runs/background/subagent-runner.ts`, and `test/support/mock-pi*` for JSONL process parsing and fake process tests. Reference `agents/*.md` for practical named-agent prompts.
- [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents): SDK/session-based runner with strong UX and agent configuration. Reference `src/agent-runner.ts` for `createAgentSession` tradeoffs, event subscriptions, usage/tool tracking, max-turn behavior, and tool filtering. Reference `src/custom-agents.ts`, `src/default-agents.ts`, and `src/ui/agent-widget.ts` for configurable agent and monitor ideas.

Use them as reference implementations, not dependencies or architectural sources of truth. Borrow small proven patterns; avoid importing chain engines, async job persistence, scheduling, intercom/RPC, worktree isolation, steering/resume, memory systems, conversation viewers, and always-on delegation into the MVP.

## Agent Definitions

Markdown with frontmatter.

```md
---
name: scout
description: Fast codebase reconnaissance.
iq: low
model: anthropic/claude-haiku-4-5
thinking: low
tools: read, grep, find, ls
contextInheritance: none
maxTurns: 3
whenToUse: Use when relevant files are unknown.
---

You are a scout subagent. Find relevant files and return concise findings.
```

Suggested agent types:

- `scout`: fast discovery, read-only.
- `planner`: implementation plan, read-only.
- `worker`: implementation, write-capable when permitted.
- `reviewer`: bug/security/regression review.
- `evaluator`: judges outputs against rubric.

## Model IQ and Thinking Mapping

Config example:

```json
{
  "modelIQ": {
    "fallback": "anthropic/claude-sonnet-4-5",
    "defaultIq": "medium",
    "levels": {
      "tiny": "anthropic/claude-haiku-4-5",
      "low": "anthropic/claude-haiku-4-5",
      "medium": {
        "model": "anthropic/claude-sonnet-4-5",
        "thinking": "medium"
      },
      "high": {
        "model": "anthropic/claude-opus-4-5",
        "thinking": "high"
      },
      "max": {
        "model": "openai/gpt-5.1-codex-max",
        "thinking": "high"
      }
    }
  }
}
```

`iq` is an abstract workbench quality/cost tier. `thinking` is pi/provider reasoning effort and maps to pi's `--thinking` levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

Model resolution order:

1. Explicit task/request model, if allowed.
2. Agent preset model.
3. Request IQ, resolved through config.
4. Agent preset IQ, resolved through config.
5. Default IQ, resolved through config.
6. Fallback model.
7. Parent/default model.

Thinking resolution order:

1. Explicit task/request thinking, if allowed.
2. Agent preset thinking.
3. Thinking from the selected IQ level, if configured.
4. Pi/model default.

If both `model` and `iq` are present on an agent, `model` selects the concrete model and `iq` is fallback/metadata. If a model string uses pi's `model:thinking` shorthand and a separate `thinking` field is also supplied, the separate `thinking` field wins after normalization.

Emit fallback decisions as observation events.

## Context Inheritance

Subagent context must be explicit and policy-controlled. A child agent should not implicitly inherit the parent conversation unless requested by the control mode, workflow step, or agent preset.

| Policy | Behavior |
|---|---|
| `none` | Fresh child context: task + subagent runtime prompt + agent preset prompt only. |
| `summary` | Adds compressed parent/workflow context. Preferred default for most non-scout agents. |
| `recent` | Adds last N parent turns or last N workflow events. Useful but can leak irrelevant instructions. |
| `selected` | Adds explicit files/messages/artifacts selected by user, workflow, or parent LLM. Best for controlled experiments. |
| `full` | Adds full parent branch. Expensive, noisy, and rarely default. |

Context sources may include:

- Parent user request.
- Parent session summary.
- Recent parent turns.
- Workflow step outputs.
- Explicit files.
- Tool results.
- Artifacts from earlier agents.
- User-supplied notes.

Recommended defaults:

- `scout`: `none`
- `planner`: `summary`
- `reviewer`: `summary`
- `worker`: `selected` or `summary`

Context policy should be recorded in every run trace so comparisons are fair.

MVP note: implementation phases 3–4 intentionally support only `fresh` and explicit `full` context modes. `fresh` corresponds to a new child session with only agent prompt plus task text; any needed context must be provided in the task. `full` corresponds to community `inherit_context`/`fork` behavior and must be explicitly requested and trace-recorded. `summary`, `recent`, and `selected` are design targets for later phases, not MVP defaults.

## Recursive Subagents

Subagents should not get access to further subagents by default.

Default child behavior:

- No `subagent` tool.
- No delegation prompt injection.
- No workflow-control prompt injection.
- Only preset-approved tools.

Optional recursion policy:

| Policy | Behavior |
|---|---|
| `disabled` | Child cannot spawn subagents. Default. |
| `explicit` | Child may spawn only named allowed agent types. |
| `bounded` | Child may spawn within depth, count, budget, and tool limits. |
| `full` | Child has same delegation ability as parent. Avoid unless intentionally testing recursive autonomy. |

Required recursion limits when enabled:

- `maxDepth`
- `maxChildrenPerAgent`
- `maxTotalChildrenPerRun`
- `maxCostUsd`
- `maxWallClockMs`
- allowed agent types
- allowed tools
- allowed IQ/model levels

Every recursive spawn must preserve trace lineage with `parentSpanId`.

## Workflow Example

```yaml
name: implement-with-review
inputs:
  task:
    type: string

settings:
  maxConcurrency: 3
  trace: true

steps:
  - id: scout
    type: subagent
    agent: scout
    iq: low
    context:
      inheritance: none
    task: |
      Find files relevant to: {{ inputs.task }}

  - id: plan
    type: subagent
    agent: planner
    iq: medium
    dependsOn: [scout]
    task: |
      Create a plan using scout findings:
      {{ steps.scout.output }}

  - id: implement
    type: subagent
    agent: worker
    iq: high
    dependsOn: [plan]
    tools: [read, grep, find, ls, edit, write, bash]
    task: |
      Implement this plan:
      {{ steps.plan.output }}

  - id: review
    type: subagent
    agent: reviewer
    iq: high
    dependsOn: [implement]
    task: |
      Review implementation for bugs, regressions, and tests.
```

## Hybrid Control Patterns

### Workflow Skeleton, LLM Chooses Details

```yaml
steps:
  - id: choose_recon
    type: llm_decision
    allowedAgents: [scout, reviewer]
    maxAgents: 3

  - id: run_selected
    type: subagent_batch
    from: choose_recon.selectedAgents
```

### LLM Proposes, Workflow Validates

```yaml
steps:
  - id: proposal
    type: llm_plan
    outputSchema: SubagentPlan

  - id: validate
    type: policy_check
    rules:
      - maxAgents <= 5
      - noWriteToolsBeforeApproval
      - allowedIQ <= high

  - id: execute
    type: subagent_plan
    from: proposal.output
```

## Observation Event Schema

All parent, child, workflow, and delegation events should normalize to one envelope.

Schema versioning rule: writers should include `schemaVersion`. Readers should treat a missing `schemaVersion` as `1` so early traces remain readable if versioning is added or tightened later.

```ts
type ObservationEvent = {
  schemaVersion: 1;
  runId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;

  source: "parent" | "subagent" | "workflow" | "delegation" | "evaluator";
  controlMode: "manual" | "workflow" | "llm-delegated" | "hybrid";

  eventType:
    | "run_start"
    | "run_end"
    | "agent_start"
    | "agent_end"
    | "turn_start"
    | "turn_end"
    | "message_start"
    | "message_update"
    | "message_end"
    | "tool_start"
    | "tool_update"
    | "tool_end"
    | "usage"
    | "error"
    | "artifact";

  timestamp: number;

  agent?: {
    id: string;
    name: string;
    type: string;
    iq?: string;
    model?: string;
    tools?: string[];
  };

  workflow?: {
    id: string;
    stepId?: string;
    variantId?: string;
  };

  data: unknown;
};
```

## Identity Model

Use stable IDs at different levels:

| ID | Meaning |
|---|---|
| `sessionId` | Pi session UUID from the pi session manager/header. |
| `observationRunId` / `runId` | Durable workbench observation run. MVP: one per pi session start/resume. |
| `traceId` | Correlation ID for one observable execution graph. Usually same as `runId` for MVP. |
| `spanId` | One operation within a trace: parent turn, subagent run, tool call, fallback, etc. |
| `parentSpanId` | Parent operation for tree/DAG reconstruction. |
| `agentId` | Stable ID for a subagent invocation, not just agent type. |
| `workflowRunId` | Later: one YAML/programmatic workflow execution. |
| `workflowStepId` | Later: one workflow step. |

MVP identity model:

- Start one observation run per pi session.
- Represent parent prompts, tool calls, subagents, rate limits, and fallbacks as spans/events within that run.
- Allow multiple subagent invocations inside one observation run.
- Later workflow runs can be nested spans or separate run records linked to the same pi `sessionId`.

## Run Record

```ts
type WorkflowRunRecord = {
  runId: string;
  workflowId?: string;
  controlMode: "manual" | "workflow" | "llm-delegated" | "hybrid";
  input: unknown;
  steps: WorkflowStepRecord[];
  artifacts: Artifact[];
  metrics: {
    totalCost: number;
    totalTokens: number;
    wallClockMs: number;
    agentCount: number;
    toolCallCount: number;
    errorCount: number;
    retryCount: number;
  };
  outputs: {
    finalAnswer?: string;
    changedFiles?: string[];
    testsRun?: string[];
    testResults?: unknown;
  };
};
```

## UI Layer: Current TUI Approach

Pi already supports rich terminal UI through extensions:

- `ctx.ui.setStatus()` for footer status.
- `ctx.ui.setWidget()` for live dashboard widgets.
- `ctx.ui.custom()` for full-screen/modal inspectors.
- `ctx.ui.custom(..., { overlay: true })` for floating overlays.
- Tool `renderCall` / `renderResult` for inline tool display.
- `pi.registerMessageRenderer()` for custom trace/run messages.
- Slash commands and shortcuts for navigation.

### Recommended TUI Surfaces

#### Footer Status

```text
subagents: 2 running, 1 done, $0.041, 38k tok
```

Use for persistent low-noise awareness.

#### Live Widget

```text
Subagents
  ⏳ scout    low    haiku    grep /auth|session/ src
  ✓ planner  medium sonnet   2 turns ↑14k ↓1.2k $0.02
  ✗ review   high   opus     failed: test timeout
```

Use for live overview above/below editor.

#### Inline Tool Rendering

For LLM-delegated `subagent` tool calls:

```text
subagent parallel 3 tasks [llm-delegated]
  ⏳ scout: locating auth/session code
  ✓ planner: created implementation plan
  ⏳ reviewer: running tests
```

Expanded view shows per-agent task, model, tools, messages, tool calls, output, usage.

#### Inspector Overlay

Command examples:

```text
/observe open
/observe inspect latest
/observe inspect failed
/observe transcript <agent-id>
```

Views:

- Overview
- Timeline
- Agent tree/DAG
- Tool calls
- Messages/transcript
- Metrics
- Artifacts
- Errors
- Raw JSON trace

#### Timeline View

```text
00.000 parent    user prompt received
00.421 workflow  run started: implement-with-review
00.610 scout     started, model=haiku, iq=low
01.204 scout     grep /auth|session/ src
07.119 scout     done, cost=$0.002
07.220 planner   started, model=sonnet, iq=medium
```

#### Agent Tree/DAG

```text
parent session
└─ workflow: implement-with-review
   ├─ scout [done]
   ├─ planner [done]
   ├─ worker [running]
   └─ reviewer [queued]
```

## Should We Consider a GUI?

Yes. A GUI is worth considering, especially for the workbench and analysis layer. It should not replace the TUI initially; it should consume the same trace/event data.

### GUI Options

#### Local Web App

- Observability extension writes/serves events over local HTTP/WebSocket.
- Browser shows dashboard, timelines, transcripts, comparisons.

Best fit for rich inspection and reports.

#### Desktop App

- Electron/Tauri wrapper over the web UI.
- Optional deeper OS integration.

Best fit if this becomes a standalone product.

#### Static HTML Reports

- Export run traces into self-contained HTML.
- No live control, but excellent sharing and offline analysis.

Best first GUI-like artifact.

## TUI vs GUI Comparison

| Dimension | TUI in pi | GUI/Web UI |
|---|---|---|
| Setup | Already available | Requires server/app/browser |
| Development speed | Fast for first version | Slower |
| Live integration | Native to pi session | Needs event bridge |
| Keyboard workflow | Excellent | Good, but separate context |
| Rich layout | Limited | Excellent |
| Large transcripts | Usable but cramped | Much better |
| Graph/DAG views | Possible but limited | Strong |
| Timeline analysis | Basic to good | Excellent |
| Run comparison | Possible | Much better |
| Reports | Basic | Strong |
| Sharing | Terminal-only unless exported | Easy via HTML/files |
| Remote/headless | Works over SSH | Needs tunneling or report export |
| Failure modes | Minimal | More moving parts |
| Security | Local terminal scope | Need local server/browser threat model |
| Implementation coupling | Direct pi APIs | Needs stable event protocol |

## TUI Pros

- Fits current pi workflow.
- No context switch for user.
- Works over SSH/tmux.
- Fast to implement with pi extension APIs.
- Great for live status, quick inspection, and commands.
- Lower security and deployment complexity.
- Best initial user experience for terminal-first workflows.

## TUI Cons

- Limited screen real estate.
- Harder to inspect large transcripts.
- Harder to compare many runs.
- Graphs, timelines, filters, and drill-down are more constrained.
- Not ideal for sharing experiment results.

## GUI Pros

- Best for workbench analysis.
- Better run comparison and benchmarking views.
- Better DAG/timeline visualization.
- Better transcript browsing and search.
- Easier charts for cost/tokens/latency/tool usage.
- Easier artifact viewing: diffs, files, test output, reports.
- Easier sharing via HTML exports.

## GUI Cons

- More infrastructure.
- Requires event bridge and data model stability.
- More security concerns if serving local HTTP.
- More implementation time.
- Possible workflow context switch from terminal.
- Needs careful lifecycle handling when pi exits/reloads.

## Recommended UI Strategy

Build in layers.

### Phase 1: TUI First

Implement:

- Footer status.
- Live widget.
- Inline subagent rendering.
- `/observe open` inspector overlay.
- Timeline/tree/transcript views.
- JSONL trace persistence.

Rationale: fastest path, native to pi, enough for live debugging.

### Phase 2: Static HTML Reports

Implement:

```text
/workbench report latest ./report.html
```

Report includes:

- Input task.
- Control mode.
- Workflow definition/version.
- Agent graph.
- Timeline.
- Final output.
- Diffs/artifacts.
- Metrics.
- Errors/retries.
- Child transcripts.
- Evaluation scores.

Rationale: high value with low runtime complexity.

### Phase 3: Optional Local Web Dashboard

Implement:

```text
/observe server start
/observe server stop
/observe server open
```

Dashboard consumes the same JSONL/event schema.

Use for:

- live multi-agent view
- run comparison
- benchmark dashboards
- advanced search/filtering
- charts
- transcript drill-down

Rationale: best long-term workbench experience.

## UI Control and Safety

Observability UI may offer control actions, but only through explicit user input.

Examples:

```text
/subagent cancel <agent-id>
/workflow pause <run-id>
/workflow resume <run-id>
/workflow abort <run-id>
/workflow retry <step-id>
```

In inspector:

```text
a abort selected child
p pause workflow
r retry failed step
o open transcript
q close
```

These actions belong to subagent/workflow control APIs, not observability internals.

## Security Defaults

- User-level agents enabled by default.
- Project-level `.pi/agents/*.md` disabled or confirmation-required.
- Tool broadening disabled by default.
- Write tools require explicit permission.
- CWD constrained to project unless allowed.
- Model override restricted to configured model/IQ policy.
- Log all child model/tool decisions.
- GUI server, if any, binds to localhost by default.
- GUI server requires explicit start.

## Persistence

Use both:

- Pi session custom entries for session-local restore.
- JSONL trace files for analysis/export.

Persist human-friendly run metadata for easy lookup:

- `displayName`: pi session name if set via `/name` or `pi.setSessionName()`.
- `fallbackTitle`: first user message or first meaningful prompt preview.
- `sessionId`: pi session UUID.
- `sessionFile`: pi session JSONL path, when persisted.
- `cwd`: working directory.
- `startedAt` / `endedAt`.
- `controlMode`: manual, workflow, LLM-delegated, or hybrid.
- `primaryModel`: first/active parent model.

Pi does not appear to auto-generate a separate LLM title summary for every session. It stores an explicit session display name only when set, and `/resume` otherwise uses session metadata such as the first message. Workbench persistence should mirror pi behavior: use the explicit session name when available, otherwise use the same style of first-message/title fallback pi uses for session lists.

Suggested layout:

```text
.pi/workbench/
├── runs/
│   └── <run-id>.json
├── traces/
│   └── <run-id>.jsonl
├── reports/
│   └── <run-id>.html
└── artifacts/
    └── <run-id>/...
```

## Evaluation Metrics

Capture:

- Final output quality.
- Changed files.
- Tests run and result.
- Tool-call count.
- Agent count.
- Error/retry count.
- Rate-limit count and impact.
- Fallback count and reason.
- Wall-clock time.
- Tokens by agent and total.
- Cost by agent and total.
- Context usage.
- Context compaction attempts/completions/aborts/errors when pi exposes them.
- Number of parent turns.
- Number of child turns.
- Workflow-control source.
- Human interventions.

### Token and Cache Metrics

Capture token breakdown when provider/pi usage metadata exposes it. Treat all fields as optional because providers differ.

Recommended fields:

```ts
type UsageBreakdown = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  toolResultTokens?: number;
  systemPromptTokens?: number;
  contextTokens?: number;
  costUsd?: number;
};

type CompactionMetrics = {
  compactionAttemptCount: number;
  compactionCount: number;
  compactionAbortedCount: number;
  compactionErrorCount: number;
};
```

Minimum reliable pi fields today are typically:

- input tokens
- output tokens
- cache read tokens, when provider reports them
- cache write tokens, when provider reports them
- total/context tokens, when available
- cost, when model pricing is known

Display unknown fields as unavailable, not zero.

Context compaction reporting should include, when pi exposes it:

- compaction attempts/starts
- completed compactions
- aborted compactions
- compaction errors
- trigger reason (`manual`, `threshold`, `overflow`)
- pre-compaction context tokens (`tokensBefore`)
- kept-context boundary (`firstKeptEntryId`)
- retry-after-overflow flag (`willRetry`)
- whether an extension supplied the compaction (`fromExtension`)

Do not store full compaction summaries in aggregate metrics; if needed for trace inspection, store only metadata such as summary length in events.

Cache reporting should include:

- cache read tokens
- cache write tokens
- estimated cache savings, if pricing supports it
- cache hit ratio, if derivable
- cache retention mode, if known

Aggregate usage at these levels:

- parent session
- workflow run
- workflow step
- subagent
- model
- control mode
- experiment variant

### Rate Limits and Fallbacks

Observability should collect rate-limit events from parent and child agents, even when no fallback is enabled.

Capture:

```ts
type RateLimitEvent = {
  provider?: string;
  model?: string;
  agentId?: string;
  workflowStepId?: string;
  statusCode?: number;      // usually 429
  retryAfterMs?: number;
  attempt: number;
  maxAttempts?: number;
  action: "recorded" | "retry" | "fallback" | "wait_for_user" | "failed";
  fallbackModel?: string;
  humanApproved?: boolean;
  delayMs?: number;
  timestamp: number;
};
```

Metrics:

- rate-limit errors by provider/model/agent/workflow step
- retry count
- fallback count
- human approval count
- time lost to rate limits
- final failure count due to rate limits
- cost/token deltas after fallback
- quality/output differences after fallback

Fallback should be policy-controlled and optional.

| Policy | Behavior |
|---|---|
| `off` | Record rate limit and fail or use pi/provider retry behavior only. |
| `auto-same-iq` | Automatically fallback to another configured model at same IQ. |
| `auto-lower-iq` | Automatically fallback to cheaper/lower IQ model if allowed. |
| `ask` | Pause and ask user to approve fallback. |
| `workflow` | Workflow file defines fallback behavior per step. |

Recommended default: `ask` for interactive work, `off` or `workflow` for benchmarks, and explicit `auto-*` only when reproducibility impact is acceptable.

Fallback resolution order:

1. Step-specific fallback model.
2. Agent preset fallback model.
3. Same-IQ fallback from model/IQ map.
4. Lower-IQ fallback if policy allows.
5. Global fallback model.
6. Fail with recorded rate-limit event.

Human-controlled fallback prompt should show:

- provider/model that rate-limited
- retry-after value, if known
- task/agent/workflow step
- proposed fallback model
- expected IQ change
- whether output comparability may be affected

Every fallback must be recorded in the trace and run record.

Optional commands:

```text
/observe rate-limits
/observe fallbacks
/workflow set-fallback <policy>
/subagent fallback <policy>
```

Optional evaluators:

- LLM judge.
- Test suite result.
- Static analysis.
- User rating.
- Rubric-based scoring.

## Suggested Commands

### Observability

```text
/observe on
/observe off
/observe status
/observe monitor on
/observe monitor off
/observe monitor compact
/observe monitor detailed
/observe open
/observe inspect <agent-id|latest|failed>
/observe timeline
/observe tree
/observe transcript <agent-id>
/observe metrics
/observe export <file>
/observe raw <run-id>
/observe rate-limits
/observe fallbacks
```

### Subagents

```text
/subagent list
/subagent show <agent>
/subagent run <agent> <task>
/subagent cancel <agent-id>
/subagent logs <agent-id>
/subagent config
/subagent iq list
/subagent iq set <level> <model>
/subagent fallback <off|ask|auto-same-iq|auto-lower-iq>
```

### Workflows

```text
/workflow list
/workflow validate <file-or-name>
/workflow dry-run <file-or-name>
/workflow run <file-or-name> key=value
/workflow inspect <run-id>
/workflow pause <run-id>
/workflow resume <run-id>
/workflow abort <run-id>
/workflow set-fallback <off|ask|auto-same-iq|auto-lower-iq|workflow>
```

### Delegation

```text
/delegation on
/delegation off
/delegation status
/delegation policy
/delegation set maxAgents 4
/delegation set mode conservative
```

### Workbench

```text
/workbench runs
/workbench open <run-id>
/workbench compare <run-a> <run-b>
/workbench benchmark <workflow-or-dir>
/workbench report <run-id> <file>
```

## Implementation Roadmap

### Fast MVP Roadmap

Assumption: frontier LLMs can follow explicit user instructions well enough to orchestrate early workflows through a delegated `subagent` tool. Therefore manually defined YAML workflows can come later.

1. Define observation event schema and trace store.
2. Build parent-session observability with token/cache/rate-limit capture.
3. Build process-based subagent runner.
4. Add agent definitions and model/IQ resolver.
5. Add delegated `subagent` tool with gated prompt injection.
6. Add minimal live TUI monitor: footer, widget, inline subagent rendering.
7. Add manual `/subagent list/show/run` commands for debugging and override.
8. Add context inheritance controls: `none`, `summary`, `recent`, `selected`.
9. Add rate-limit recording and optional fallback policies.
10. Add basic transcript/timeline inspection.
11. Add report export.
12. Add YAML workflow engine only after delegated/manual flows are useful.
13. Add run comparison and benchmark commands.
14. Add optional SDK runner.
15. Add optional local GUI dashboard.

### Full Roadmap Positioning

Earlier:

- Observability without subagents.
- Delegated subagent tool.
- Agent presets.
- Context policy.
- Token/cache/rate-limit metrics.
- TUI monitor.

Later:

- YAML workflow engine.
- Complex DAG execution.
- Workbench benchmarking.
- GUI dashboard.

## Recommended First Build

Start with the fastest useful loop:

- `observability` extension for parent events and JSONL traces.
- `subagent-core` process runner.
- agent markdown definitions.
- model/IQ resolver.
- opt-in `delegation` extension exposing the `subagent` tool.
- minimal TUI monitor.
- manual `/subagent` commands for debugging.

Do not build first:

- YAML workflow engine.
- GUI dashboard.
- complex inspector.
- SDK runner.
- recursive subagents.

Reason: the first useful experiment is whether a parent LLM, given clear delegation instructions and a constrained subagent tool, can orchestrate scout/planner/reviewer/worker effectively. Programmatic workflows are valuable, but can be added after the runtime, observability, and delegation loop works.

## Summary

Use pi TUI first for live awareness and inspection. Add static HTML reports next. Consider a local GUI/web dashboard for deeper analysis once event schemas and run records stabilize.

Most important separation:

```text
subagent runtime emits events
workflow/delegation decides control
observability renders and records
GUI/TUI consume the same trace model
```

This enables rigorous experiments without accidentally giving workflow control to the parent LLM in manual or programmatic modes.
