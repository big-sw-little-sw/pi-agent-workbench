import { createSpanId } from "../core/ids.js";
import type { ObservationEvent, ObservationSink, RunRecord, UsageBreakdown } from "../core/types.js";
import type { WorkbenchRuntime } from "../runtime/workbench-runtime.js";

type MinimalPi = {
  on(event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>): void;
};

type RuntimeLike = ObservationSink & {
  getStatus?: () => { initialized: boolean; run?: RunRecord };
  markTraceWriteFailed?: (reason: unknown) => void;
};

type ObserverOptions = { now?: () => number };

type State = {
  promptSpan?: string;
  promptKey?: string;
  activeTurnSpan?: string;
  turnSpans: Map<string, string>;
  messageSpans: Map<string, string>;
  toolSpans: Map<string, string>;
  notifiedWriteFailure: boolean;
};

export function registerParentObserver(pi: MinimalPi, sink: RuntimeLike | WorkbenchRuntime, options: ObserverOptions = {}): void {
  const state: State = {
    turnSpans: new Map(),
    messageSpans: new Map(),
    toolSpans: new Map(),
    notifiedWriteFailure: false,
  };
  const now = options.now ?? Date.now;

  const safe = (handler: (event: unknown, ctx: unknown) => Promise<void>) => async (event: unknown, ctx: unknown) => {
    try {
      await handler(event, ctx);
    } catch (error) {
      await emitError(sink, state, now, error, ctx);
    }
  };

  pi.on("agent_start", safe(async (event, ctx) => {
    state.promptKey = firstString(event, ["agentRunId", "agentId", "id", "promptId"]);
    state.promptSpan = createSpanId();
    await emitParent(sink, now, "prompt_start", state.promptSpan, undefined, metadata(event, ["reason", "promptLength", "imageCount", "agentRunId", "agentId", "id"]), ctx, state);
  }));

  pi.on("agent_end", safe(async (event, ctx) => {
    const span = state.promptSpan ?? createSpanId();
    const data = metadata(event, ["status", "reason", "agentRunId", "agentId", "id"]);
    if (!state.promptSpan) data.missingStart = true;
    await emitParent(sink, now, "prompt_end", span, undefined, data, ctx, state);
    state.promptSpan = undefined;
    state.promptKey = undefined;
    state.turnSpans.clear();
    state.activeTurnSpan = undefined;
  }));

  pi.on("turn_start", safe(async (event, ctx) => {
    const key = turnKey(event);
    const span = getOrCreate(state.turnSpans, key);
    state.activeTurnSpan = span;
    await emitParent(sink, now, "turn_start", span, state.promptSpan, metadata(event, ["turnIndex", "id", "status"]), ctx, state);
  }));

  pi.on("turn_end", safe(async (event, ctx) => {
    const key = turnKey(event);
    const known = state.turnSpans.get(key);
    const span = known ?? createSpanId();
    const data = metadata(event, ["turnIndex", "id", "status", "finishReason"]);
    if (!known) data.missingStart = true;
    await emitParent(sink, now, "turn_end", span, state.promptSpan, data, ctx, state);
    state.turnSpans.delete(key);
    if (state.activeTurnSpan === span) state.activeTurnSpan = undefined;
  }));

  pi.on("message_start", safe(async (event, ctx) => {
    const key = messageId(event);
    const span = key ? getOrCreate(state.messageSpans, key) : createSpanId();
    await emitParent(sink, now, "message_start", span, state.activeTurnSpan, messageData(event), ctx, state);
  }));

  pi.on("message_update", safe(async (event, ctx) => {
    const key = messageId(event);
    const known = key ? state.messageSpans.get(key) : undefined;
    const span = known ?? (key ? getOrCreate(state.messageSpans, key) : createSpanId());
    const data = messageData(event);
    if (!known) data.missingStart = true;
    await emitParent(sink, now, "message_update", span, state.activeTurnSpan, data, ctx, state);
  }));

  pi.on("message_end", safe(async (event, ctx) => {
    const key = messageId(event);
    const known = key ? state.messageSpans.get(key) : undefined;
    const span = known ?? (key ? getOrCreate(state.messageSpans, key) : createSpanId());
    const usage = normalizeUsage(firstObject(event, ["usage", "message.usage"]));
    const data = messageData(event);
    if (!known) data.missingStart = true;
    await emitParent(sink, now, "message_end", span, state.activeTurnSpan, data, ctx, state, usage);
    if (usage && isAssistantMessage(event)) {
      await emitParent(sink, now, "usage", createSpanId(), span, { fromEvent: "message_end" }, ctx, state, usage);
    }
    if (key) state.messageSpans.delete(key);
  }));

  pi.on("tool_execution_start", safe(async (event, ctx) => {
    const key = toolKey(event);
    const span = getOrCreate(state.toolSpans, key);
    await emitParent(sink, now, "tool_start", span, state.activeTurnSpan, toolData(event), ctx, state);
  }));

  pi.on("tool_execution_update", safe(async (event, ctx) => {
    const key = toolKey(event);
    const known = state.toolSpans.get(key);
    const span = known ?? getOrCreate(state.toolSpans, key);
    const data = toolData(event);
    if (!known) data.missingStart = true;
    await emitParent(sink, now, "tool_update", span, state.activeTurnSpan, data, ctx, state);
  }));

  pi.on("tool_execution_end", safe(async (event, ctx) => {
    const key = toolKey(event);
    const known = state.toolSpans.get(key);
    const span = known ?? getOrCreate(state.toolSpans, key);
    const data = toolData(event);
    if (!known) data.missingStart = true;
    await emitParent(sink, now, "tool_end", span, state.activeTurnSpan, data, ctx, state);
    state.toolSpans.delete(key);
  }));

  pi.on("session_before_compact", safe(async (event, ctx) => {
    await emitParent(sink, now, "compaction", createSpanId(), state.promptSpan, { phase: "start", ...metadata(event, ["reason"]) }, ctx, state);
  }));

  pi.on("session_compact", safe(async (event, ctx) => {
    await emitParent(sink, now, "compaction", createSpanId(), state.promptSpan, { phase: "end", status: "completed", ...metadata(event, ["reason"]) }, ctx, state);
  }));

  pi.on("after_provider_response", safe(async (event, ctx) => {
    const status = firstNumber(event, ["status", "statusCode", "response.status"]);
    if (status === 429) {
      await emitParent(sink, now, "rate_limit", createSpanId(), state.activeTurnSpan, metadata(event, ["status", "statusCode", "retryAfter", "retry-after"]), ctx, state);
    }
  }));
}

async function emitParent(
  sink: RuntimeLike,
  now: () => number,
  eventType: ObservationEvent["eventType"],
  spanId: string,
  parentSpanId: string | undefined,
  data: Record<string, unknown>,
  ctx: unknown,
  state: State,
  usage?: UsageBreakdown,
): Promise<void> {
  const status = sink.getStatus?.();
  const run = status?.run;
  if (!status?.initialized || !run) return;
  const event: ObservationEvent = {
    schemaVersion: 1,
    runId: run.runId,
    traceId: run.traceId,
    spanId,
    parentSpanId,
    source: "parent",
    controlMode: run.controlMode,
    eventType,
    timestamp: eventTimestamp(data, now),
    usage,
    data: cleanData(data),
  };
  try {
    await sink.emit(event);
  } catch (error) {
    sink.markTraceWriteFailed?.(error);
    notifyWriteFailure(ctx, state);
  }
}

async function emitError(sink: RuntimeLike, state: State, now: () => number, error: unknown, ctx: unknown): Promise<void> {
  const status = sink.getStatus?.();
  const run = status?.run;
  if (!status?.initialized || !run) return;
  try {
    await sink.emit({
      schemaVersion: 1,
      runId: run.runId,
      traceId: run.traceId,
      spanId: createSpanId(),
      source: "runtime",
      controlMode: run.controlMode,
      eventType: "error",
      timestamp: now(),
      data: { phase: "parent_observer", message: cap(error instanceof Error ? error.message : String(error), 500) },
    });
  } catch (writeError) {
    sink.markTraceWriteFailed?.(writeError);
    notifyWriteFailure(ctx, state);
  }
}

function notifyWriteFailure(ctx: unknown, state: State): void {
  if (state.notifiedWriteFailure) return;
  state.notifiedWriteFailure = true;
  const ui = typeof ctx === "object" && ctx !== null ? (ctx as { ui?: { notify?: (message: string, type?: "warning") => void } }).ui : undefined;
  ui?.notify?.("workbench trace write failed; observability degraded", "warning");
}

function getOrCreate(map: Map<string, string>, key: string): string {
  const existing = map.get(key);
  if (existing) return existing;
  const span = createSpanId();
  map.set(key, span);
  return span;
}

function turnKey(event: unknown): string {
  return firstString(event, ["turnId", "id"]) ?? `turn:${firstNumber(event, ["turnIndex"]) ?? "active"}`;
}

function messageId(event: unknown): string | undefined {
  return firstString(event, ["messageId", "id", "message.id"]);
}

function toolKey(event: unknown): string {
  return firstString(event, ["toolCallId", "callId", "id"]) ?? createSpanId();
}

function messageData(event: unknown): Record<string, unknown> {
  const data = metadata(event, ["messageId", "id", "role", "type", "status", "finishReason", "message.id", "message.role"]);
  const text = firstString(event, ["content", "text", "message.content"]);
  if (text !== undefined) data.contentLength = text.length;
  const content = getPath(event, "content");
  if (Array.isArray(content)) data.contentPartCount = content.length;
  return data;
}

function toolData(event: unknown): Record<string, unknown> {
  const data = metadata(event, ["toolName", "name", "toolCallId", "callId", "id", "status", "isError"]);
  const input = firstObject(event, ["input", "args", "arguments"]);
  if (input) {
    data.argumentKeyCount = Object.keys(input).length;
    data.argumentKeys = Object.keys(input).sort();
  }
  const content = getPath(event, "content");
  if (Array.isArray(content)) data.contentPartCount = content.length;
  return data;
}

function metadata(event: unknown, fields: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const timestamp = getPath(event, "timestamp");
  if (isFiniteNonNegative(timestamp)) data.timestamp = timestamp;
  for (const field of fields) {
    const value = getPath(event, field);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") data[field.replaceAll(".", "_")] = value;
  }
  return data;
}

function normalizeUsage(value: Record<string, unknown> | undefined): UsageBreakdown | undefined {
  if (!value) return undefined;
  const usage: UsageBreakdown = {};
  copyNumber(value, usage, ["input", "inputTokens"], "inputTokens");
  copyNumber(value, usage, ["output", "outputTokens"], "outputTokens");
  copyNumber(value, usage, ["total", "totalTokens"], "totalTokens");
  copyNumber(value, usage, ["cacheRead", "cacheReadTokens"], "cacheReadTokens");
  copyNumber(value, usage, ["cacheWrite", "cacheWriteTokens"], "cacheWriteTokens");
  copyNumber(value, usage, ["reasoning", "reasoningTokens"], "reasoningTokens");
  const cost = getPath(value, "cost.total");
  if (isFiniteNonNegative(cost)) usage.costUsd = cost;
  return Object.keys(usage).length ? usage : undefined;
}

function copyNumber(source: Record<string, unknown>, usage: UsageBreakdown, names: string[], target: keyof UsageBreakdown): void {
  for (const name of names) {
    const value = source[name];
    if (isFiniteNonNegative(value)) {
      usage[target] = value;
      return;
    }
  }
}

function isAssistantMessage(event: unknown): boolean {
  const role = firstString(event, ["role", "message.role"]);
  return role === undefined || role === "assistant";
}

function cleanData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function eventTimestamp(data: Record<string, unknown>, now: () => number): number {
  const timestamp = data.timestamp;
  return isFiniteNonNegative(timestamp) ? timestamp : now();
}

function firstString(obj: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = getPath(obj, path);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(obj: unknown, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = getPath(obj, path);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstObject(obj: unknown, paths: string[]): Record<string, unknown> | undefined {
  for (const path of paths) {
    const value = getPath(obj, path);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

function getPath(obj: unknown, path: string): unknown {
  let current = obj;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function cap(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}
