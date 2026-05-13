import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import workbenchExtension, { formatMetrics } from "../src/extensions/workbench.js";
import { registerParentObserver, WorkbenchRuntime, type WorkbenchRuntimeLink, type ObservationEvent } from "../src/index.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "workbench-runtime-"));
}

class FakePi {
  handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];

  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }): void {
    this.commands.set(name, options);
  }

  appendEntry(customType: string, data: unknown): void {
    this.entries.push({ type: "custom", customType, data });
  }

  async emit(event: string, payload: unknown, ctx: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
  }
}

function ctx(cwd: string, entries: unknown[] = []) {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    cwd,
    model: { id: "test-model" },
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
    notifications,
    sessionManager: {
      getSessionId: () => "session_one",
      getSessionFile: () => path.join(cwd, ".pi", "sessions", "one.jsonl"),
      getSessionName: () => "Test Session",
      getEntries: () => entries,
    },
  };
}

async function startRuntime(cwd: string, links: WorkbenchRuntimeLink[] = [], now = 100): Promise<WorkbenchRuntime> {
  const runtime = new WorkbenchRuntime({ cwd, now: () => now });
  await runtime.start({ reason: "startup", sessionId: "s1", sessionFile: path.join(cwd, "s.jsonl"), existingLinks: links });
  return runtime;
}

test("Runtime creates a run, persists run_start/runtime_attach, and appends link data", async () => {
  const cwd = await tmpDir();
  const appended: WorkbenchRuntimeLink[] = [];
  const runtime = new WorkbenchRuntime({ cwd, now: () => 10 });
  const run = await runtime.start({ reason: "startup", sessionId: "s1", sessionFile: "session.jsonl", appendLink: (link) => { appended.push(link); } });

  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.runId, run.runId);
  const events = await runtime.store.readTrace(run.runId);
  assert.deepEqual(events.map((event) => event.eventType), ["run_start", "runtime_attach"]);
  assert.equal((await runtime.store.readRun(run.runId))?.status, "running");
});

test("Runtime resumes linked runs without another run_start", async () => {
  const cwd = await tmpDir();
  const runtime = await startRuntime(cwd, [], 20);
  const run = runtime.getStatus().run!;
  await runtime.detach({ reason: "quit" });

  const resumed = new WorkbenchRuntime({ cwd, now: () => 30 });
  await resumed.start({ existingLinks: [{ runId: run.runId, traceId: run.traceId }] });
  assert.equal(resumed.getStatus().run?.runId, run.runId);
  assert.equal(resumed.getStatus().resumed, true);
  const events = await resumed.store.readTrace(run.runId);
  assert.deepEqual(events.map((event) => event.eventType), ["run_start", "runtime_attach", "runtime_detach", "runtime_attach"]);
});

test("Runtime resumes linked runs from another cwd inside the same git repository", async () => {
  const root = await tmpDir();
  await fs.mkdir(path.join(root, ".git"));
  const nested = path.join(root, "nested");
  await fs.mkdir(nested);
  const runtime = await startRuntime(root, [], 20);
  const run = runtime.getStatus().run!;
  await runtime.detach({ reason: "quit" });

  const resumed = new WorkbenchRuntime({ cwd: nested, now: () => 30 });
  await resumed.start({ existingLinks: [{ runId: run.runId, traceId: run.traceId }] });
  assert.equal(resumed.getStatus().run?.runId, run.runId);
  assert.equal(resumed.getStatus().run?.cwd, root);
  assert.equal(resumed.getStatus().resumed, true);
  const events = await resumed.store.readTrace(run.runId);
  assert.equal(events.at(-1)?.eventType, "runtime_attach");
  assert.equal(events.at(-1)?.data?.cwd, nested);
});

test("Invalid link recovery creates replacement run and marks incomplete metrics", async () => {
  const cwd = await tmpDir();
  const runtime = new WorkbenchRuntime({ cwd, now: () => 40 });
  const appended: WorkbenchRuntimeLink[] = [];
  const run = await runtime.start({
    existingLinks: [{ runId: "run_missing", traceId: "run_missing", traceFile: "/missing" }],
    appendLink: (link) => { appended.push(link); },
  });

  assert.notEqual(run.runId, "run_missing");
  assert.equal(appended[0]?.metricsMayBeIncomplete, true);
  assert.equal(runtime.getStatus().metricsMayBeIncomplete, true);
  const events = await runtime.store.readTrace(run.runId);
  assert.deepEqual(events.map((event) => event.eventType), ["run_start", "runtime_attach", "error"]);
});

test("Runtime recovers when a linked run record exists but its trace file is missing", async () => {
  const cwd = await tmpDir();
  const runtime = await startRuntime(cwd, [], 50);
  const oldRun = runtime.getStatus().run!;
  await runtime.detach({ reason: "quit" });
  await fs.rm(oldRun.traceFile);

  const appended: WorkbenchRuntimeLink[] = [];
  const recovered = new WorkbenchRuntime({ cwd, now: () => 60 });
  const run = await recovered.start({
    existingLinks: [{ runId: oldRun.runId, traceId: oldRun.traceId, traceFile: oldRun.traceFile }],
    appendLink: (link) => { appended.push(link); },
  });

  assert.notEqual(run.runId, oldRun.runId);
  assert.equal(appended[0]?.metricsMayBeIncomplete, true);
  assert.equal(recovered.getStatus().metricsMayBeIncomplete, true);
  const events = await recovered.store.readTrace(run.runId);
  assert.deepEqual(events.map((event) => event.eventType), ["run_start", "runtime_attach", "error"]);
});

test("Detach is idempotent, writes runtime_detach, and leaves endedAt unset", async () => {
  const cwd = await tmpDir();
  const runtime = await startRuntime(cwd);
  const runId = runtime.getStatus().run!.runId;
  await runtime.detach({ reason: "quit" });
  await runtime.detach({ reason: "quit" });
  const run = await runtime.store.readRun(runId);
  assert.equal(run?.status, "detached");
  assert.equal(run?.endedAt, undefined);
  const events = await runtime.store.readTrace(runId);
  assert.equal(events.filter((event) => event.eventType === "runtime_detach").length, 1);
});

test("Parent observer normalizes prompt, turn, message, tool, compaction, and rate-limit events", async () => {
  const cwd = await tmpDir();
  const runtime = await startRuntime(cwd);
  const pi = new FakePi();
  const context = ctx(cwd);
  registerParentObserver(pi, runtime, { now: () => 50 });

  await pi.emit("agent_start", { id: "prompt1" }, context);
  await pi.emit("turn_start", { turnIndex: 0 }, context);
  await pi.emit("message_start", { messageId: "m1", role: "assistant" }, context);
  await pi.emit("message_end", { messageId: "m1", role: "assistant", usage: { inputTokens: 2, outputTokens: 3 } }, context);
  await pi.emit("tool_execution_start", { toolCallId: "t1", toolName: "read", input: { path: "secret" } }, context);
  await pi.emit("tool_execution_update", { toolCallId: "t1", toolName: "read" }, context);
  await pi.emit("tool_execution_end", { toolCallId: "t1", toolName: "read", isError: false, content: [{ type: "text", text: "hidden" }] }, context);
  await pi.emit("turn_end", { turnIndex: 0 }, context);
  await pi.emit("agent_end", { id: "prompt1" }, context);
  await pi.emit("session_before_compact", {}, context);
  await pi.emit("session_compact", {}, context);
  await pi.emit("after_provider_response", { status: 429, retryAfter: "1" }, context);

  const trace = await runtime.store.readTrace(runtime.getStatus().run!.runId);
  const types = trace.map((event) => event.eventType);
  for (const type of ["prompt_start", "turn_start", "message_start", "message_end", "usage", "tool_start", "tool_update", "tool_end", "turn_end", "prompt_end", "compaction", "rate_limit"]) {
    assert.equal(types.includes(type), true, `missing ${type}`);
  }
  const toolStart = trace.find((event) => event.eventType === "tool_start")!;
  assert.deepEqual(toolStart.data?.argumentKeys, ["path"]);
  assert.equal((toolStart.data as Record<string, unknown>).path, undefined, "raw arg values are not persisted");
  const run = await runtime.store.readRun(runtime.getStatus().run!.runId);
  assert.equal(run?.metrics.toolCallCount, 1);
  assert.equal(run?.metrics.inputTokens, 2);
  assert.equal(run?.metrics.outputTokens, 3);
  assert.equal(run?.metrics.totalTokens, undefined);
  assert.equal(run?.metrics.compactionAttemptCount, 1);
  assert.equal(run?.metrics.compactionCount, 1);
  assert.equal(run?.metrics.rateLimitCount, 1);
});

test("Parent observer handles pi-shaped message events without IDs as one-off spans", async () => {
  const cwd = await tmpDir();
  const runtime = await startRuntime(cwd);
  const pi = new FakePi();
  const context = ctx(cwd);
  registerParentObserver(pi, runtime, { now: () => 65 });

  await pi.emit("message_start", { message: { role: "assistant", content: "hello" } }, context);
  await pi.emit("message_update", { message: { role: "assistant", content: "hello world" } }, context);
  await pi.emit("message_end", { message: { role: "assistant", content: "done" } }, context);

  const trace = await runtime.store.readTrace(runtime.getStatus().run!.runId);
  const messageEvents = trace.filter((event) => event.eventType.startsWith("message_"));
  assert.deepEqual(messageEvents.map((event) => event.eventType), ["message_start", "message_update", "message_end"]);
  assert.notEqual(messageEvents[0]?.spanId, messageEvents[1]?.spanId);
  assert.notEqual(messageEvents[1]?.spanId, messageEvents[2]?.spanId);
  assert.equal(messageEvents[1]?.data?.missingStart, true);
  assert.equal(messageEvents[2]?.data?.missingStart, true);
});

test("Parent observer reuses spans for orphan update-before-end message and tool lifecycles", async () => {
  const cwd = await tmpDir();
  const runtime = await startRuntime(cwd);
  const pi = new FakePi();
  const context = ctx(cwd);
  registerParentObserver(pi, runtime, { now: () => 70 });

  await pi.emit("message_update", { messageId: "m_orphan", role: "assistant" }, context);
  await pi.emit("message_end", { messageId: "m_orphan", role: "assistant" }, context);
  await pi.emit("tool_execution_update", { toolCallId: "t_orphan", toolName: "read" }, context);
  await pi.emit("tool_execution_end", { toolCallId: "t_orphan", toolName: "read" }, context);

  const trace = await runtime.store.readTrace(runtime.getStatus().run!.runId);
  const messageEvents = trace.filter((event) => event.eventType === "message_update" || event.eventType === "message_end");
  const toolEvents = trace.filter((event) => event.eventType === "tool_update" || event.eventType === "tool_end");
  assert.equal(messageEvents.length, 2);
  assert.equal(toolEvents.length, 2);
  assert.equal(messageEvents[0]?.spanId, messageEvents[1]?.spanId);
  assert.equal(toolEvents[0]?.spanId, toolEvents[1]?.spanId);
  assert.equal(messageEvents[0]?.data?.missingStart, true);
  assert.equal(messageEvents[1]?.data?.missingStart, undefined);
  assert.equal(toolEvents[0]?.data?.missingStart, true);
  assert.equal(toolEvents[1]?.data?.missingStart, undefined);
});

test("Parent usage totals update only from explicit usage events", async () => {
  const cwd = await tmpDir();
  const runtime = await startRuntime(cwd);
  const run = runtime.getStatus().run!;
  const lifecycleUsage: ObservationEvent = {
    runId: run.runId,
    traceId: run.traceId,
    spanId: "span_lifecycle",
    source: "parent",
    controlMode: "manual",
    eventType: "message_end",
    timestamp: 1,
    usage: { inputTokens: 99 },
  };
  await runtime.emit(lifecycleUsage);
  assert.equal((await runtime.store.readRun(run.runId))?.metrics.inputTokens, undefined);
});

test("Parent observer write failures do not throw, mark degraded, and notify once", async () => {
  const cwd = await tmpDir();
  const runtime = await startRuntime(cwd);
  const run = runtime.getStatus().run!;
  await fs.rm(path.join(runtime.store.runsDir, `${run.runId}.json`));
  const pi = new FakePi();
  const context = ctx(cwd);
  registerParentObserver(pi, runtime);

  await pi.emit("agent_start", { id: "p" }, context);
  await pi.emit("agent_end", { id: "p" }, context);
  assert.equal(runtime.getStatus().traceWriteFailed, true);
  assert.equal(context.notifications.filter((n) => n.message.includes("trace write failed")).length, 1);
});

test("status metric formatting shows defined usage fields and omits unknowns", () => {
  const full = formatMetrics({
    toolCallCount: 1,
    errorCount: 2,
    retryCount: 3,
    rateLimitCount: 4,
    retryFailureCount: 0,
    fallbackCount: 0,
    compactionAttemptCount: 0,
    compactionCount: 0,
    compactionAbortedCount: 0,
    compactionErrorCount: 0,
    totalTokens: 100,
    inputTokens: 40,
    outputTokens: 30,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    reasoningTokens: 7,
    toolResultTokens: 3,
    systemPromptTokens: 2,
    contextTokens: 200,
    costUsd: 0.0123,
  });
  assert.equal(full, "tools=1 errors=2 retries=3 rate_limits=4 tokens=100 in=40 out=30 cache_read=10 cache_write=5 reasoning=7 tool_result=3 system=2 context=200 cost=$0.0123");

  const partial = formatMetrics({
    toolCallCount: 0,
    errorCount: 0,
    retryCount: 0,
    rateLimitCount: 0,
    retryFailureCount: 0,
    fallbackCount: 0,
    compactionAttemptCount: 0,
    compactionCount: 0,
    compactionAbortedCount: 0,
    compactionErrorCount: 0,
    inputTokens: 9,
    cacheWriteTokens: 0,
  });
  assert.equal(partial, "tools=0 errors=0 retries=0 rate_limits=0 in=9 cache_write=0");
  assert.equal(partial.includes("tokens=0"), false);
  assert.equal(partial.includes("out=0"), false);
  assert.equal(partial.includes("cost="), false);
});

test("Workbench extension wires session_start, /observe status, parent events, and shutdown", async () => {
  const cwd = await tmpDir();
  const oldCwd = process.cwd();
  process.chdir(cwd);
  try {
    const pi = new FakePi();
    workbenchExtension(pi as never);
    const context = ctx(cwd, pi.entries);
    await pi.emit("session_start", { reason: "startup" }, context);
    assert.equal(pi.entries.length, 1);
    const link = pi.entries[0]!.data as WorkbenchRuntimeLink;

    await pi.emit("tool_execution_start", { toolCallId: "tool1", toolName: "bash" }, context);
    await pi.commands.get("observe")!.handler("status", context);
    assert.equal(context.notifications.some((n) => n.message.includes(`run: ${link.runId}`)), true);

    await pi.emit("session_shutdown", { reason: "quit" }, context);
    const runFile = path.join(cwd, ".pi", "workbench", "runs", `${link.runId}.json`);
    const record = JSON.parse(await fs.readFile(runFile, "utf8"));
    assert.equal(record.status, "detached");
  } finally {
    process.chdir(oldCwd);
  }
});

test("/observe status warns when invalid-link recovery fragments metrics", async () => {
  const cwd = await tmpDir();
  const oldCwd = process.cwd();
  process.chdir(cwd);
  try {
    const invalidEntry = { type: "custom" as const, customType: "workbench-runtime", data: { runId: "run_missing", traceId: "run_missing" } };
    const pi = new FakePi();
    workbenchExtension(pi as never);
    const context = ctx(cwd, [invalidEntry]);
    await pi.emit("session_start", { reason: "reload" }, context);
    await pi.commands.get("observe")!.handler("status", context);
    assert.equal(context.notifications.some((n) => n.message.includes("metrics may be incomplete")), true);
  } finally {
    process.chdir(oldCwd);
  }
});
