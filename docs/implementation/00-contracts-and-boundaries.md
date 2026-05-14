# 00 — Contracts and Boundaries

This file defines shared interfaces and ownership boundaries so teams can work in parallel.

## Shared Event Contract

All modules communicate observability through `ObservationEvent` and an `ObservationSink`.

```ts
interface ObservationSink {
  emit(event: ObservationEvent): void | Promise<void>;
}
```

Do not make the subagent runner or handoff implementation depend directly on TUI, trace store, or pi event bus. They should emit to an `ObservationSink`.

## Core Interfaces

### SubagentRunner

```ts
interface SubagentRunner {
  run(request: SubagentRunRequest, sink?: ObservationSink): Promise<SubagentRunResult>;
  runParallel?(requests: SubagentRunRequest[], options: { maxConcurrency: number }, sink?: ObservationSink): Promise<SubagentRunResult[]>;
}
```

### SubagentRunRequest

Minimum shape:

```ts
type SubagentRunRequest = {
  runId: string;
  traceId: string;
  parentSpanId?: string;
  agentName: string;
  task: string;
  cwd: string;
  model?: string;
  iq?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools?: string[];
  systemPrompt?: string;
  context?: "fresh" | "full";
  timeoutMs?: number;
  signal?: AbortSignal;
};
```

### SubagentRunResult

Minimum shape:

```ts
type SubagentRunResult = {
  agentId: string;
  agentName: string;
  status: "completed" | "failed" | "aborted";
  finalOutput?: string;
  errorMessage?: string;
  usage?: UsageBreakdown;
  startedAt: number;
  endedAt: number;
  events?: ObservationEvent[];
};
```

### AgentDefinition

Agent definitions are reusable agent profiles/personas. They are not inherently subagents; handoff, manual subagent execution, and delegation may consume the same catalog.

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
};
```

Keep MVP agent definitions simple. Add `fallbackModel`, `contextInheritance`, and richer policy fields later only if needed.

### ModelIqResolver

```ts
interface ModelIqResolver {
  resolve(request: ModelIqRequest): Promise<ModelIqResolution> | ModelIqResolution;
}
```

Resolution should return requested model, selected model, selected thinking level when explicit, fallback/change reason if any, and whether quality/IQ changed. Model precedence is request model, agent model, request IQ, agent IQ, default IQ, fallback model, parent/default model. Thinking precedence is request thinking, agent thinking, selected IQ-level thinking, then pi/model default.

## Extension Boundaries

### Workbench Extension

Normal user/demo loading should use one cohesive `workbench` extension entrypoint. It owns shared runtime/run initialization and wires parent observability, manual subagent commands, optional delegation, and monitor projections into one run/trace. Separate module-specific entrypoints may exist for development/testing, but incomplete combinations should be documented as degraded.

### Observability Extension

Owns:

- parent event subscriptions
- trace store integration
- live state store
- CLI/env/config-driven metrics export
- `/observe ...` commands

Does not own:

- child process spawning
- agent profiles
- delegation policy

### Agent Catalog Module

Owns:

- loading and validating reusable agent profiles/personas
- catalog diagnostics and lookup helpers
- project-agent trust/precedence behavior

Does not own:

- handoff execution
- subagent process execution
- delegation policy

### Subagents Module/Extension

Owns:

- process runner
- subagent execution semantics over shared agent profiles
- model/IQ resolver
- optional manual `/subagent ...` commands

Does not own:

- parent LLM prompt injection
- TUI dashboard internals

### Handoff Module/Extension

Owns:

- new-conversation handoff commands/API
- built-in extractor prompt/model call orchestration
- durable handoff records and prompt/context artifacts
- handoff-specific observation events and lineage metadata

Does not own:

- subagent execution
- delegation policy
- current-conversation replacement in MVP

### Delegation Extension

Owns:

- `subagent` tool
- delegation prompt injection
- `/delegation ...` commands
- delegation policy enforcement

Does not own:

- runner internals
- trace persistence internals

### UI Module

Owns:

- rendering state from observation events
- widgets/status/render helpers

Does not own:

- execution
- persistence
- model resolution

## Integration Pattern

Preferred flow:

```text
pi parent events ─┐
subagents ────────┼─ ObservationEvent → ObservationSink → TraceStore + LiveState + pi.events
handoff ──────────┤
future workflow ──┘
```

Modules should accept sinks/callbacks so they are testable without pi.

## Parallelism Contract

MVP supports parallel independent subagent tasks with bounded concurrency.

Rules:

- Parallel tasks must be independent.
- No chain/dependency handling in MVP.
- Each child gets its own `agentId` and span.
- The parent parallel tool call/span is the `parentSpanId` of each child.
- Aggregate usage is computed from child results/events.

## Context Contract

MVP supports:

- `fresh`: agent prompt + task text only.
- `full`: explicit serialized parent context/conversation.

Any use of `full` must be trace-recorded. Richer modes are stretch goals.

## Handoff Contract

MVP handoff is a context transition to a successor conversation, not subagent execution and not compaction/replacement of the current conversation.

Rules:

- Handoff creates a durable record plus prompt/context artifact.
- Handoff emits `handoff_*` events, not `subagent_*` events.
- When handoff creates a successor session, that session gets a successor workbench run linked to the source run; it does not merge source and target metrics into one run. Headless artifact-only handoff may have no target run yet.
- Minimal lineage export should provide per-run and combined metrics from either side of the handoff.
- Extractive handoff uses a built-in extractor for MVP.
- Extractor usage belongs to the source run; target conversation usage belongs to the target run.
- Manual and static handoffs must not invoke summarization.
- Interactive default is draft/edit; headless default is artifact/output-only.
- Auto-start must be explicit.
