export type ObservationSource =
  | "runtime"
  | "parent"
  | "subagent"
  | "workflow"
  | "delegation"
  | "evaluator";

export type ControlMode = "manual" | "workflow" | "llm-delegated" | "hybrid";

export type KnownObservationEventType =
  | "run_start"
  | "runtime_attach"
  | "runtime_detach"
  | "run_end"
  | "prompt_start"
  | "prompt_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "usage"
  | "rate_limit"
  | "retry"
  | "fallback"
  | "compaction"
  | "error"
  | "artifact"
  | "subagent_start"
  | "subagent_end";

export type ObservationEventType = KnownObservationEventType | (string & {});

export type UsageBreakdown = {
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

export type AgentType = "parent" | "subagent" | "adhoc" | (string & {});

export type ObservationEvent = {
  schemaVersion?: number;
  runId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  source: ObservationSource;
  controlMode: ControlMode;
  eventType: ObservationEventType;
  timestamp: number;
  agent?: {
    id?: string;
    name?: string;
    type?: AgentType;
    iq?: string;
    model?: string;
    tools?: string[];
  };
  workflow?: {
    id?: string;
    stepId?: string;
    variantId?: string;
  };
  usage?: UsageBreakdown;
  data?: Record<string, unknown>;
};

export interface ObservationSink {
  emit(event: ObservationEvent): void | Promise<void>;
}

export type RunMetrics = UsageBreakdown & {
  toolCallCount: number;
  errorCount: number;
  rateLimitCount: number;
  retryCount: number;
  retryFailureCount: number;
  fallbackCount: number;
  compactionAttemptCount: number;
  compactionCount: number;
  compactionAbortedCount: number;
  compactionErrorCount: number;
};

export type RunStatus = "running" | "detached" | "completed" | "failed" | "aborted" | "unknown";

export type RunRecord = {
  schemaVersion?: number;
  runId: string;
  traceId: string;
  spanId?: string;
  cwd: string;
  projectRoot?: string;
  storageRoot: string;
  controlMode: ControlMode;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  traceFile: string;
  metrics: RunMetrics;
  sessionId?: string;
  sessionFile?: string;
  displayName?: string;
  fallbackTitle?: string;
  primaryModel?: string;
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type SubagentRunRequest = {
  runId: string;
  traceId: string;
  parentSpanId?: string;
  agentName: string;
  task: string;
  cwd: string;
  model?: string;
  iq?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  systemPrompt?: string;
  context?: "fresh" | "full";
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type SubagentRunResult = {
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

export interface SubagentRunner {
  run(request: SubagentRunRequest, sink?: ObservationSink): Promise<SubagentRunResult>;
  runParallel?(
    requests: SubagentRunRequest[],
    options: { maxConcurrency: number },
    sink?: ObservationSink,
  ): Promise<SubagentRunResult[]>;
}

export type AgentDefinition = {
  name: string;
  description: string;
  systemPrompt: string;
  iq?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  source: "user" | "project" | "package";
  filePath?: string;
  systemPromptMode?: "append" | "replace";
  loadContextFiles?: boolean;
};

export type ModelIqRequest = {
  requestedModel?: string;
  requestedIq?: string;
  requestedThinking?: ThinkingLevel;
  agent?: AgentDefinition;
  defaultIq?: string;
  fallbackModel?: string;
  parentModel?: string;
};

export type ModelIqResolution = {
  requestedModel?: string;
  selectedModel?: string;
  requestedIq?: string;
  selectedIq?: string;
  selectedThinking?: ThinkingLevel;
  reason?: string;
  iqChanged?: boolean;
};

export interface ModelIqResolver {
  resolve(request: ModelIqRequest): Promise<ModelIqResolution> | ModelIqResolution;
}
