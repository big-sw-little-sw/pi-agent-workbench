import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyEventToMetrics,
  createAgentId,
  createEmptyMetrics,
  createRunId,
  createSpanId,
  createTraceId,
  normalizeReadSchemaVersion,
  prepareWriteSchemaVersion,
  recomputeRunRecord,
  resolveWorkbenchPaths,
  TraceStore,
  type ObservationEvent,
} from "../src/index.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "workbench-core-"));
}

function event(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
  return {
    runId: "run_test",
    traceId: "run_test",
    spanId: "span_test",
    source: "runtime",
    controlMode: "manual",
    eventType: "usage",
    timestamp: 100,
    ...overrides,
  };
}

test("ID helpers use compact prefixed shapes and are unique", () => {
  const runIds = new Set(Array.from({ length: 20 }, () => createRunId()));
  assert.equal(runIds.size, 20);
  assert.match(createRunId(), /^run_[a-z0-9]+_[a-f0-9]{12}$/);
  assert.match(createTraceId(), /^trace_[a-z0-9]+_[a-f0-9]{12}$/);
  assert.match(createSpanId(), /^span_[a-f0-9]{16}$/);
  assert.match(createAgentId(), /^agent_[a-f0-9]{16}$/);
});

test("metrics aggregate only explicit usage events and keep unknown usage undefined", () => {
  const empty = createEmptyMetrics();
  assert.equal(empty.inputTokens, undefined);
  const afterLifecycle = applyEventToMetrics(empty, event({ eventType: "subagent_end", usage: { inputTokens: 10 } }));
  assert.equal(afterLifecycle.inputTokens, undefined);

  const afterUsage = applyEventToMetrics(afterLifecycle, event({ usage: { inputTokens: 10, outputTokens: 3, totalTokens: -5, costUsd: 0.25 } }));
  assert.equal(afterUsage.inputTokens, 10);
  assert.equal(afterUsage.outputTokens, 3);
  assert.equal(afterUsage.totalTokens, undefined);
  assert.equal(afterUsage.costUsd, 0.25);
  assert.equal(empty.inputTokens, undefined, "input metrics are not mutated");
});

test("metrics count tools, errors, retry, fallback, rate limits, and compaction", () => {
  let metrics = createEmptyMetrics();
  for (const e of [
    event({ eventType: "tool_start" }),
    event({ eventType: "error" }),
    event({ eventType: "rate_limit" }),
    event({ eventType: "fallback" }),
    event({ eventType: "retry", data: { phase: "start" } }),
    event({ eventType: "retry", data: { phase: "end", status: "exhausted" } }),
    event({ eventType: "compaction", data: { phase: "start" } }),
    event({ eventType: "compaction", data: { phase: "end", status: "completed" } }),
    event({ eventType: "compaction", data: { phase: "end", status: "aborted" } }),
    event({ eventType: "compaction", data: { phase: "end", status: "error" } }),
  ]) metrics = applyEventToMetrics(metrics, e);
  assert.equal(metrics.toolCallCount, 1);
  assert.equal(metrics.errorCount, 1);
  assert.equal(metrics.rateLimitCount, 1);
  assert.equal(metrics.fallbackCount, 1);
  assert.equal(metrics.retryCount, 1);
  assert.equal(metrics.retryFailureCount, 1);
  assert.equal(metrics.compactionAttemptCount, 1);
  assert.equal(metrics.compactionCount, 1);
  assert.equal(metrics.compactionAbortedCount, 1);
  assert.equal(metrics.compactionErrorCount, 1);
});

test("schema helpers normalize reads and reject unsupported writes", () => {
  assert.equal(normalizeReadSchemaVersion({}).schemaVersion, 1);
  assert.equal(prepareWriteSchemaVersion({}).schemaVersion, 1);
  assert.throws(() => normalizeReadSchemaVersion({ schemaVersion: 2 }), /Unsupported/);
  assert.throws(() => prepareWriteSchemaVersion({ schemaVersion: 2 }), /Unsupported/);
});

test("path resolution handles no git, git directories/files, nesting, and explicit baseDir", async () => {
  const root = await tmpDir();
  const noGit = path.join(root, "nogit");
  await fs.mkdir(noGit);
  assert.equal(resolveWorkbenchPaths({ cwd: noGit }).storageRoot, path.join(noGit, ".pi", "workbench"));

  const repo = path.join(root, "repo");
  const nested = path.join(repo, "a", "b");
  await fs.mkdir(path.join(repo, ".git"), { recursive: true });
  await fs.mkdir(nested, { recursive: true });
  const nestedPaths = resolveWorkbenchPaths({ cwd: nested });
  assert.equal(nestedPaths.projectRoot, repo);
  assert.equal(nestedPaths.storageRoot, path.join(repo, ".pi", "workbench"));

  const worktree = path.join(root, "worktree");
  await fs.mkdir(path.join(worktree, "sub"), { recursive: true });
  await fs.writeFile(path.join(worktree, ".git"), "gitdir: somewhere");
  assert.equal(resolveWorkbenchPaths({ cwd: path.join(worktree, "sub") }).projectRoot, worktree);

  const explicit = resolveWorkbenchPaths({ cwd: nested, baseDir: "custom-store" });
  assert.equal(explicit.projectRoot, repo);
  assert.equal(explicit.storageRoot, path.join(nested, "custom-store"));
});

test("TraceStore creates runs and persists events/metrics/status", async () => {
  const cwd = await tmpDir();
  const store = new TraceStore({ cwd });
  const run = await store.createRun({ runId: "run_one", startedAt: 10, spanId: "span_run" });
  assert.equal(fsSync.existsSync(run.traceFile), true);
  assert.equal(run.traceId, "run_one");
  assert.equal(run.schemaVersion, 1);

  await store.appendEvent(event({ runId: run.runId, traceId: run.traceId, spanId: " span_usage ", usage: { inputTokens: 5 } }));
  await store.appendEvent(event({ runId: run.runId, traceId: run.traceId, spanId: "span_end", eventType: "run_end", timestamp: 200, data: { status: "completed" } }));
  const saved = await store.readRun(run.runId);
  assert.equal(saved?.metrics.inputTokens, 5);
  assert.equal(saved?.status, "completed");
  assert.equal(saved?.endedAt, 200);
  const trace = await store.readTrace(run.runId);
  assert.equal(trace.length, 2);
  assert.equal(trace[0]?.spanId, "span_usage");
});

test("TraceStore rejects path-like run and trace ids", async () => {
  const cwd = await tmpDir();
  const store = new TraceStore({ cwd });
  const invalidIds = ["../outside", "a/b", "/absolute", "C:\\absolute", "with space"];
  for (const id of invalidIds) {
    await assert.rejects(() => store.createRun({ runId: id }), /Invalid runId/);
    await assert.rejects(() => store.createRun({ runId: "safe", traceId: id }), /Invalid traceId/);
    await assert.rejects(() => store.appendEvent(event({ runId: id })), /Invalid runId/);
    await assert.rejects(() => store.readRun(id), /Invalid runId/);
    await assert.rejects(() => store.readTrace(id), /Invalid runId/);
  }

  const run = await store.createRun({ runId: "run_safe", startedAt: 10 });
  await assert.rejects(() => store.writeRun({ ...run, runId: "../outside" }), /Invalid runId/);
});

test("TraceStore createRun ignores forbidden runtime fields", async () => {
  const cwd = await tmpDir();
  const store = new TraceStore({ cwd });
  const run = await store.createRun({
    runId: "run_whitelist",
    status: "completed",
    endedAt: 123,
    metrics: { ...createEmptyMetrics(), toolCallCount: 99 },
  } as unknown as Parameters<TraceStore["createRun"]>[0]);

  assert.equal(run.status, "running");
  assert.equal(run.endedAt, undefined);
  assert.equal(run.metrics.toolCallCount, 0);
  assert.equal((await store.readRun(run.runId))?.status, "running");
});

test("TraceStore write/read schema behavior", async () => {
  const cwd = await tmpDir();
  const store = new TraceStore({ cwd });
  const run = await store.createRun({ runId: "run_schema", startedAt: 10 });
  const runFile = path.join(store.runsDir, `${run.runId}.json`);
  const raw = JSON.parse(await fs.readFile(runFile, "utf8"));
  delete raw.schemaVersion;
  await fs.writeFile(runFile, JSON.stringify(raw));
  assert.equal((await store.readRun(run.runId))?.schemaVersion, 1);
  raw.schemaVersion = 2;
  await fs.writeFile(runFile, JSON.stringify(raw));
  await assert.rejects(() => store.readRun(run.runId), /Unsupported/);

  await assert.rejects(() => store.appendEvent(event({ schemaVersion: 2, runId: run.runId, traceId: run.traceId })), /Unsupported/);
});

test("readTrace tolerates bad lines and normalizes valid missing schemaVersion events", async () => {
  const cwd = await tmpDir();
  const store = new TraceStore({ cwd });
  const run = await store.createRun({ runId: "run_trace", startedAt: 10 });
  const validNoSchema = event({ runId: run.runId, traceId: run.traceId, spanId: " span_ok ", eventType: "custom_event" });
  delete validNoSchema.schemaVersion;
  await fs.writeFile(run.traceFile, [
    "",
    "not json",
    JSON.stringify({ schemaVersion: 2, ...validNoSchema }),
    JSON.stringify({ ...validNoSchema, runId: "other" }),
    JSON.stringify({ ...validNoSchema, traceId: "other" }),
    JSON.stringify({ ...validNoSchema, spanId: "   " }),
    JSON.stringify(validNoSchema),
  ].join("\n"));
  const events = await store.readTrace(run.runId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.schemaVersion, 1);
  assert.equal(events[0]?.spanId, "span_ok");
});

test("appendEvent validates run existence, trace matching, source, mode, timestamp, and parentSpanId", async () => {
  const cwd = await tmpDir();
  const store = new TraceStore({ cwd });
  const run = await store.createRun({ runId: "run_validate", startedAt: 10 });
  await assert.rejects(() => store.appendEvent(event({ runId: "missing" })), /Missing run/);
  await assert.rejects(() => store.appendEvent(event({ runId: run.runId, traceId: "wrong" })), /traceId/);
  await assert.rejects(() => store.appendEvent(event({ runId: run.runId, traceId: run.traceId, source: "bad" as never })), /source/);
  await assert.rejects(() => store.appendEvent(event({ runId: run.runId, traceId: run.traceId, controlMode: "bad" as never })), /controlMode/);
  await assert.rejects(() => store.appendEvent(event({ runId: run.runId, traceId: run.traceId, timestamp: Number.NaN })), /timestamp/);
  await assert.rejects(() => store.appendEvent(event({ runId: run.runId, traceId: run.traceId, parentSpanId: " " })), /parentSpanId/);
});

test("writeRun rejects conflicting storage metadata", async () => {
  const cwd = await tmpDir();
  const store = new TraceStore({ cwd });
  const run = await store.createRun({ runId: "run_write", startedAt: 10 });
  await assert.rejects(() => store.writeRun({ ...run, cwd: path.join(cwd, "other") }), /cwd/);
  await assert.rejects(() => store.writeRun({ ...run, storageRoot: path.join(cwd, "other") }), /storageRoot/);
  await assert.rejects(() => store.writeRun({ ...run, traceFile: path.join(cwd, "escape.jsonl") }), /outside/);
});

test("listRuns sorts by startedAt descending", async () => {
  const cwd = await tmpDir();
  const store = new TraceStore({ cwd });
  await store.createRun({ runId: "older", startedAt: 1 });
  await store.createRun({ runId: "newer", startedAt: 2 });
  assert.deepEqual((await store.listRuns()).map((r) => r.runId), ["newer", "older"]);
});

test("concurrent appendEvent calls serialize metrics updates", async () => {
  const cwd = await tmpDir();
  const store = new TraceStore({ cwd });
  const run = await store.createRun({ runId: "run_concurrent", startedAt: 10 });
  await Promise.all(Array.from({ length: 25 }, (_, i) => store.appendEvent(event({ runId: run.runId, traceId: run.traceId, spanId: `span_${i}`, usage: { inputTokens: 1 } }))));
  assert.equal((await store.readRun(run.runId))?.metrics.inputTokens, 25);
  assert.equal((await store.readTrace(run.runId)).length, 25);
});

test("run status derives only from run_end events", async () => {
  const cwd = await tmpDir();
  const store = new TraceStore({ cwd });
  const run = await store.createRun({ runId: "run_status", startedAt: 10 });
  await store.appendEvent(event({ runId: run.runId, traceId: run.traceId, eventType: "error", data: { status: "failed" } }));
  await store.appendEvent(event({ runId: run.runId, traceId: run.traceId, eventType: "subagent_end", data: { status: "failed" } }));
  assert.equal((await store.readRun(run.runId))?.status, "running");
  await store.appendEvent(event({ runId: run.runId, traceId: run.traceId, eventType: "run_end", timestamp: 300, data: { status: "aborted" } }));
  assert.equal((await store.readRun(run.runId))?.status, "aborted");

  const recomputed = recomputeRunRecord({ record: run, events: [
    event({ runId: run.runId, traceId: run.traceId, eventType: "error", timestamp: 50 }),
    event({ runId: run.runId, traceId: run.traceId, eventType: "run_end", timestamp: 100, data: { status: "completed" } }),
    event({ runId: run.runId, traceId: run.traceId, eventType: "run_end", timestamp: 200, data: { status: "nonsense" } }),
  ] });
  assert.equal(recomputed.status, "unknown");
  assert.equal(recomputed.endedAt, 200);
  assert.equal(recomputed.metrics.errorCount, 1);
});
