import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TraceStore, createRunRecord, resolveMetricsExportOptions, resolveMetricsExportPath, exportMetricsReport, writeFileAtomic } from "../src/index.js";
import type { WorkbenchConfig } from "../src/index.js";

async function tmpDir(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "workbench-metrics-")); }

const config: WorkbenchConfig = {
  schemaVersion: 1,
  agents: { trustProjectAgents: false },
  subagents: { defaultTools: [], defaultTimeoutMs: 600_000, loadExtensions: false },
  delegation: { enabledByDefault: false, allowFullContext: false, maxParallel: 4 },
  observability: { metricsExportFile: "global.json", metricsExportMode: "onShutdown", metricsExportTemplate: false },
};

test("metrics export options apply env/cli precedence, invalid mode fallback, and template warnings", () => {
  const options = resolveMetricsExportOptions({
    config,
    env: { PI_WORKBENCH_METRICS_FILE: "env/{runId}.json", PI_WORKBENCH_METRICS_EXPORT: "bad", PI_WORKBENCH_METRICS_TEMPLATE: "wat" },
    cli: { file: "cli.json", mode: "off", template: true },
  });
  assert.equal(options.file, "cli.json");
  assert.equal(options.mode, "off");
  assert.equal(options.template, true);
  assert.equal(options.diagnostics.some((d) => d.code === "metrics_export_mode_invalid"), true);
  assert.equal(options.diagnostics.some((d) => d.code === "metrics_export_template_invalid"), true);

  const implied = resolveMetricsExportOptions({ config: { ...config, observability: { metricsExportMode: "off", metricsExportTemplate: false } }, env: { PI_WORKBENCH_METRICS_FILE: "env/{runId}.json" } });
  assert.equal(implied.mode, "onShutdown");
  assert.equal(implied.diagnostics.some((d) => d.code === "metrics_export_template_disabled"), true);
});

test("metrics export file implies shutdown mode per highest-priority layer", () => {
  const envOffCliFile = resolveMetricsExportOptions({
    config,
    env: { PI_WORKBENCH_METRICS_EXPORT: "off" },
    cli: { file: "cli.json" },
  });
  assert.equal(envOffCliFile.file, "cli.json");
  assert.equal(envOffCliFile.mode, "onShutdown");

  const cliOffWins = resolveMetricsExportOptions({
    config,
    env: { PI_WORKBENCH_METRICS_FILE: "env.json" },
    cli: { mode: "off" },
  });
  assert.equal(cliOffWins.file, "env.json");
  assert.equal(cliOffWins.mode, "off");

  const invalidCliModeWithFile = resolveMetricsExportOptions({
    config,
    env: { PI_WORKBENCH_METRICS_EXPORT: "off" },
    cli: { file: "cli.json", mode: "bad" },
  });
  assert.equal(invalidCliModeWithFile.file, "cli.json");
  assert.equal(invalidCliModeWithFile.mode, "onShutdown");
  assert.equal(invalidCliModeWithFile.diagnostics.some((d) => d.code === "metrics_export_mode_invalid"), true);

  const cliFalseTemplateIsAbsent = resolveMetricsExportOptions({
    config,
    env: { PI_WORKBENCH_METRICS_FILE: "env/{runId}.json", PI_WORKBENCH_METRICS_TEMPLATE: "true" },
    cli: { template: false },
  });
  assert.equal(cliFalseTemplateIsAbsent.template, true);

  const cliTrueOverridesEnvFalse = resolveMetricsExportOptions({
    config,
    env: { PI_WORKBENCH_METRICS_TEMPLATE: "false" },
    cli: { template: true },
  });
  assert.equal(cliTrueOverridesEnvFalse.template, true);

  const envFalseOverridesConfigTrue = resolveMetricsExportOptions({
    config: { ...config, observability: { ...config.observability, metricsExportTemplate: true } },
    env: { PI_WORKBENCH_METRICS_TEMPLATE: "false" },
  });
  assert.equal(envFalseOverridesConfigTrue.template, false);
});

test("metrics export path resolves relative to project root and validates templates", () => {
  const run = createRunRecord({ cwd: "/tmp/project/sub", projectRoot: "/tmp/project", storageRoot: "/tmp/project/.pi/workbench", runId: "run_abc", traceId: "run_abc", startedAt: 1 });
  const resolved = resolveMetricsExportPath({ file: "metrics/{runId}.json", run, template: true });
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.file, path.resolve("/tmp/project/metrics/run_abc.json"));
  assert.equal(resolveMetricsExportPath({ file: "metrics/{bad}.json", run, template: true }).ok, false);
  const literal = resolveMetricsExportPath({ file: "metrics/{runId}.json", run, template: false });
  assert.equal(literal.ok, true);
  if (literal.ok) assert.equal(literal.warnings.length, 1);
});

test("atomic write creates parent directories and cleans temp files on successful rename", async () => {
  const dir = await tmpDir();
  const file = path.join(dir, "a", "b", "out.txt");
  await writeFileAtomic(file, "ok", { createParentDirs: true });
  assert.equal(await fs.readFile(file, "utf8"), "ok");
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter((entry) => entry.includes(".tmp")), []);
});

test("metrics export writes pretty report from fresh persisted run without zeroing unknown usage", async () => {
  const cwd = await tmpDir();
  const store = new TraceStore({ cwd });
  const run = await store.createRun({ startedAt: 10, primaryModel: "m" });
  await store.appendEvent({ schemaVersion: 1, runId: run.runId, traceId: run.traceId, spanId: run.spanId!, source: "parent", controlMode: "manual", eventType: "tool_start", timestamp: 11 });
  const result = await exportMetricsReport({ store, run, file: "metrics/{runId}.json", template: true, warnings: ["metrics may be incomplete"], now: () => 20 });
  const text = await fs.readFile(result.file, "utf8");
  assert.equal(text.startsWith("{\n  \"schemaVersion\": 1"), true);
  const report = JSON.parse(text);
  assert.equal(report.exportedAt, 20);
  assert.equal(report.run.runId, run.runId);
  assert.equal(report.run.status, "running");
  assert.equal(report.metrics.toolCallCount, 1);
  assert.equal("totalTokens" in report.metrics, false);
  assert.deepEqual(report.warnings, ["metrics may be incomplete"]);
});
