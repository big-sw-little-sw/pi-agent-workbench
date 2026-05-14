import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSlashArgs } from "../src/core/slash-args.js";
import { TraceStore } from "../src/core/trace-store.js";
import { runHandoff, exportHandoffLineage, type HandoffSessionAdapter } from "../src/handoff/index.js";
import { HandoffStore } from "../src/handoff/store.js";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "workbench-handoff-"));
}

function sinkFor(store: TraceStore) {
  return { emit: (event: Parameters<TraceStore["appendEvent"]>[0]) => store.appendEvent(event) };
}

test("parseSlashArgs supports booleans, strings, lists, equals, quotes, and errors", () => {
  const parsed = parseSlashArgs("--mode=manual --start --to scout --artifacts 'a b.md' c.md tail", {
    mode: { kind: "string" }, start: { kind: "boolean" }, to: { kind: "string" }, artifacts: { kind: "stringList" },
  });
  assert.equal(parsed.flags.mode, "manual");
  assert.equal(parsed.flags.start, true);
  assert.equal(parsed.flags.to, "scout");
  assert.deepEqual(parsed.flags.artifacts, ["a b.md", "c.md", "tail"]);
  assert.throws(() => parseSlashArgs("--mode 'unterminated", { mode: { kind: "string" } }), /unclosed quote/);
  assert.throws(() => parseSlashArgs("--start=false", { start: { kind: "boolean" } }), /does not accept/);
});

test("manual handoff writes record, prompt artifact, and handoff trace events only", async () => {
  const cwd = await tempDir();
  const store = new TraceStore({ cwd });
  const source = await store.createRun({ sessionId: "source-session", sessionFile: path.join(cwd, "source.jsonl") });

  const record = await runHandoff({
    request: { method: "manual", prompt: "Continue exactly here", headless: true },
    sourceRun: source,
    store,
    sink: sinkFor(store),
    now: () => 1000,
  });

  assert.equal(record.status, "completed");
  assert.equal(record.activation, "artifact_only");
  assert.equal(await fs.readFile(record.targetPromptArtifact!.path, "utf8"), "Continue exactly here");
  const persisted = JSON.parse(await fs.readFile(path.join(source.storageRoot, "handoffs", `${record.handoffId}.json`), "utf8"));
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.sourceRunId, source.runId);
  const events = await store.readTrace(source.runId);
  assert.deepEqual(events.map((event) => event.eventType), ["handoff_start", "artifact", "handoff_end"]);
  assert.ok(events.every((event) => event.source === "handoff"));
  assert.ok(events.every((event) => event.eventType !== "subagent_start" && event.eventType !== "subagent_end"));
});

test("static handoff validates artifacts and creates deterministic wrapper", async () => {
  const cwd = await tempDir();
  const artifact = path.join(cwd, "plan.md");
  await fs.writeFile(artifact, "# Plan\nTOKEN=secret-value\n");
  const store = new TraceStore({ cwd });
  const source = await store.createRun();

  const record = await runHandoff({
    request: { method: "static", artifacts: ["plan.md"], note: "Use this", headless: true },
    sourceRun: source,
    store,
    sink: sinkFor(store),
    now: () => 2000,
  });

  const prompt = await fs.readFile(record.targetPromptArtifact!.path, "utf8");
  assert.match(prompt, /# Static handoff context/);
  assert.match(prompt, /Use this/);
  assert.match(prompt, /plan\.md/);
  assert.doesNotMatch(prompt, /secret-value/);
  assert.equal(record.selectedArtifacts?.[0]?.appliedMode, "snapshot");
  assert.ok(record.selectedArtifacts?.[0]?.snapshotPath);
  await assert.rejects(() => runHandoff({ request: { method: "static", artifacts: [], headless: true }, sourceRun: source, store, sink: sinkFor(store) }), /requires at least one/);
});

test("draft handoff creates linked target run through injected adapter", async () => {
  const cwd = await tempDir();
  const store = new TraceStore({ cwd });
  const source = await store.createRun({ sessionFile: path.join(cwd, "source.jsonl") });
  let seenPromptArtifact = "";
  const adapter: HandoffSessionAdapter = {
    createDraft: async (input) => { seenPromptArtifact = input.promptArtifactPath; return { sessionId: "target-session", sessionFile: path.join(cwd, "target.jsonl") }; },
    autoStart: async () => { throw new Error("unexpected"); },
  };

  const record = await runHandoff({ request: { method: "manual", prompt: "Draft this", headless: false }, sourceRun: source, store, sink: sinkFor(store), adapter });

  assert.equal(record.activation, "draft");
  assert.ok(record.targetRunId);
  assert.equal(record.targetSessionId, "target-session");
  assert.equal(seenPromptArtifact, record.targetPromptArtifact!.path);
  const target = await store.readRun(record.targetRunId!);
  assert.equal(target?.sessionFile, path.join(cwd, "target.jsonl"));
});

test("target agent partial model/tools require explicit allowance", async () => {
  const cwd = await tempDir();
  const store = new TraceStore({ cwd });
  const source = await store.createRun();
  const catalog = { diagnostics: [], paths: { globalAgentsDir: cwd }, agents: [{ name: "scout", description: "Scout", systemPrompt: "Be precise", source: "user" as const, model: "x", tools: ["read"] }] };

  await assert.rejects(() => runHandoff({ request: { method: "manual", prompt: "x", targetAgentName: "scout", headless: true }, sourceRun: source, store, sink: sinkFor(store), catalog }), /allowPartialProfile/);
  const record = await runHandoff({ request: { method: "manual", prompt: "x", targetAgentName: "scout", headless: true, allowPartialProfile: true }, sourceRun: source, store, sink: sinkFor(store), catalog });
  assert.equal(record.targetAgentName, "scout");
  assert.equal(record.desiredTargetModel, "x");
  assert.deepEqual(record.desiredTargetTools, ["read"]);
});

test("static handoff snapshots same-basename artifacts without collision", async () => {
  const cwd = await tempDir();
  await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
  await fs.mkdir(path.join(cwd, "archive"), { recursive: true });
  await fs.writeFile(path.join(cwd, "docs", "plan.md"), "# Current\n");
  await fs.writeFile(path.join(cwd, "archive", "plan.md"), "# Old\n");
  const store = new TraceStore({ cwd });
  const source = await store.createRun();

  const record = await runHandoff({
    request: { method: "static", artifacts: ["docs/plan.md", "archive/plan.md"], headless: true },
    sourceRun: source,
    store,
    sink: sinkFor(store),
  });

  const [first, second] = record.selectedArtifacts ?? [];
  assert.ok(first?.snapshotPath);
  assert.ok(second?.snapshotPath);
  assert.notEqual(first.snapshotPath, second.snapshotPath);
  assert.equal(await fs.readFile(first.snapshotPath, "utf8"), "# Current\n");
  assert.equal(await fs.readFile(second.snapshotPath, "utf8"), "# Old\n");
});

test("static handoff references large binary artifacts without snapshotting", async () => {
  const cwd = await tempDir();
  const artifact = path.join(cwd, "large.bin");
  await fs.writeFile(artifact, Buffer.concat([Buffer.from([0]), Buffer.alloc(70 * 1024, 1)]));
  const store = new TraceStore({ cwd });
  const source = await store.createRun();

  const record = await runHandoff({ request: { method: "static", artifacts: ["large.bin"], headless: true }, sourceRun: source, store, sink: sinkFor(store) });

  assert.equal(record.selectedArtifacts?.[0]?.appliedMode, "reference");
  assert.equal(record.selectedArtifacts?.[0]?.contentType, "binary");
  assert.equal(record.selectedArtifacts?.[0]?.sha256, undefined);
});

test("static interactive callbacks can skip invalid and rejected external artifacts", async () => {
  const cwd = await tempDir();
  const externalDir = await tempDir();
  await fs.writeFile(path.join(cwd, "ok.md"), "ok");
  await fs.writeFile(path.join(externalDir, "skip.md"), "external");
  const store = new TraceStore({ cwd });
  const source = await store.createRun();

  const record = await runHandoff({
    request: {
      method: "static",
      artifacts: ["missing.md", path.join(externalDir, "skip.md"), "ok.md"],
      headless: false,
      continueWithoutInvalidArtifact: async () => true,
      confirmExternalArtifact: async () => false,
    },
    sourceRun: source,
    store,
    sink: sinkFor(store),
  });

  assert.equal(record.selectedArtifacts?.length, 1);
  assert.equal(path.basename(record.selectedArtifacts![0].originalPath), "ok.md");
});

test("static interactive callbacks can skip artifacts that fail during read", async (t) => {
  const cwd = await tempDir();
  const unreadable = path.join(cwd, "unreadable.md");
  await fs.writeFile(unreadable, "secret");
  await fs.writeFile(path.join(cwd, "ok.md"), "ok");
  await fs.chmod(unreadable, 0o000);
  t.after(async () => { await fs.chmod(unreadable, 0o600).catch(() => undefined); });
  try {
    await fs.readFile(unreadable);
    t.skip("filesystem allows reading chmod 000 files");
    return;
  } catch {
    // Expected on normal user-owned temp files.
  }
  const store = new TraceStore({ cwd });
  const source = await store.createRun();

  const record = await runHandoff({
    request: { method: "static", artifacts: ["unreadable.md", "ok.md"], headless: false, continueWithoutInvalidArtifact: async () => true },
    sourceRun: source,
    store,
    sink: sinkFor(store),
  });

  assert.equal(record.selectedArtifacts?.length, 1);
  assert.equal(path.basename(record.selectedArtifacts![0].originalPath), "ok.md");
});

test("headless static handoff rejects invalid artifacts despite permissive callback", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "ok.md"), "ok");
  const store = new TraceStore({ cwd });
  const source = await store.createRun();
  let called = false;

  await assert.rejects(() => runHandoff({
    request: { method: "static", artifacts: ["missing.md", "ok.md"], headless: true, continueWithoutInvalidArtifact: async () => { called = true; return true; } },
    sourceRun: source,
    store,
    sink: sinkFor(store),
  }), /ENOENT|no such file/i);
  assert.equal(called, false);
});

test("headless static handoff requires allowExternalArtifacts despite permissive callback", async () => {
  const cwd = await tempDir();
  const externalDir = await tempDir();
  const external = path.join(externalDir, "external.md");
  await fs.writeFile(external, "external");
  const store = new TraceStore({ cwd });
  const source = await store.createRun();
  let called = false;

  await assert.rejects(() => runHandoff({
    request: { method: "static", artifacts: [external], headless: true, confirmExternalArtifact: async () => { called = true; return true; } },
    sourceRun: source,
    store,
    sink: sinkFor(store),
  }), /external artifact requires/);
  assert.equal(called, false);

  const record = await runHandoff({ request: { method: "static", artifacts: [external], headless: true, allowExternalArtifacts: true }, sourceRun: source, store, sink: sinkFor(store) });
  assert.equal(record.selectedArtifacts?.[0]?.external, true);
});

test("pre-artifact validation failures persist failed handoff records", async () => {
  const cwd = await tempDir();
  const store = new TraceStore({ cwd });
  const source = await store.createRun();

  await assert.rejects(() => runHandoff({ request: { method: "static", artifacts: [], headless: true }, sourceRun: source, store, sink: sinkFor(store) }), /requires at least one/);

  const records = await new HandoffStore(source.storageRoot).list();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "failed");
  assert.equal(records[0].failureStage, "validation");
  assert.equal(records[0].sourceRunId, source.runId);
});

test("cancelled target session keeps linked partial target run lineage", async () => {
  const cwd = await tempDir();
  const store = new TraceStore({ cwd });
  const source = await store.createRun({ sessionFile: path.join(cwd, "source.jsonl") });
  const adapter: HandoffSessionAdapter = {
    createDraft: async () => ({ cancelled: true }),
    autoStart: async () => { throw new Error("unexpected"); },
  };

  const record = await runHandoff({ request: { method: "manual", prompt: "Draft", headless: false }, sourceRun: source, store, sink: sinkFor(store), adapter });

  assert.equal(record.status, "partial");
  assert.ok(record.targetRunId);
  const targetEvents = await store.readTrace(record.targetRunId!);
  assert.equal(targetEvents[0]?.eventType, "run_start");
  assert.equal(targetEvents[0]?.data?.handoffId, record.handoffId);
});

test("auto-start target task failure is persisted separately from handoff status", async () => {
  const cwd = await tempDir();
  const store = new TraceStore({ cwd });
  const source = await store.createRun();
  const adapter: HandoffSessionAdapter = {
    createDraft: async () => { throw new Error("unexpected"); },
    autoStart: async () => ({ sessionId: "target", targetTaskStatus: "failed", targetTaskErrorMessage: "model failed" }),
  };

  const record = await runHandoff({ request: { method: "manual", prompt: "Go", autoStart: true, headless: true }, sourceRun: source, store, sink: sinkFor(store), adapter });

  assert.equal(record.status, "completed");
  assert.equal(record.targetTaskStatus, "failed");
  assert.equal(record.targetTaskErrorMessage, "model failed");
});

test("lineage export includes source and target metrics when available", async () => {
  const cwd = await tempDir();
  const store = new TraceStore({ cwd });
  const source = await store.createRun();
  const targetSessionFile = path.join(cwd, "target-session.jsonl");
  const adapter: HandoffSessionAdapter = {
    createDraft: async () => ({ sessionId: "target", sessionFile: targetSessionFile }),
    autoStart: async () => ({ sessionId: "target", sessionFile: targetSessionFile }),
  };
  const record = await runHandoff({ request: { method: "manual", prompt: "Go", autoStart: true, headless: true }, sourceRun: source, store, sink: sinkFor(store), adapter });
  assert.ok(record.targetRunId);
  await store.appendEvent({ runId: record.targetRunId!, traceId: record.targetTraceId!, spanId: "span_usage", source: "parent", controlMode: "manual", eventType: "usage", timestamp: 5000, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });

  const result = await exportHandoffLineage({ store, currentRun: source, file: "lineage.json", now: () => 6000 });
  assert.equal(result.report.handoffs.length, 1);
  assert.equal(result.report.runs.length, 2);
  assert.equal(result.report.combinedMetrics.totalTokens, 5);

  const replacementTargetRun = await store.createRun({ sessionId: "target", sessionFile: targetSessionFile });
  const targetSide = await exportHandoffLineage({ store, currentRun: replacementTargetRun, file: "target-lineage.json", now: () => 6001 });
  assert.equal(targetSide.report.handoffs[0]?.handoffId, record.handoffId);
  assert.equal(targetSide.report.runs.length, 3);
});
