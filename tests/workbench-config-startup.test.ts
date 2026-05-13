import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkbenchExtension } from "../src/extensions/workbench.js";
import type { WorkbenchConfigLoadResult, AgentCatalog } from "../src/index.js";

async function tmpDir(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "workbench-startup-")); }

class FakePi {
  handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  on(event: string, handler: (event: any, ctx: any) => unknown): void { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]); }
  registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }): void { this.commands.set(name, options); }
  appendEntry(customType: string, data: unknown): void { this.entries.push({ type: "custom", customType, data }); }
  async emit(event: string, payload: unknown, ctx: unknown): Promise<void> { for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx); }
}

function ctx(cwd: string, entries: unknown[] = []) {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    cwd,
    model: { id: "model" },
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
    notifications,
    sessionManager: {
      getSessionId: () => "s1",
      getSessionFile: () => path.join(cwd, ".pi", "sessions", "s.jsonl"),
      getSessionName: () => "startup",
      getEntries: () => entries,
    },
  };
}

function configResult(cwd: string): WorkbenchConfigLoadResult {
  return {
    effectiveConfig: {
      schemaVersion: 1,
      agents: { trustProjectAgents: false },
      subagents: { defaultTools: ["read"], defaultTimeoutMs: 600_000, loadExtensions: false },
      delegation: { enabledByDefault: false, allowFullContext: false, maxParallel: 4 },
    },
    diagnostics: [{ severity: "warning", code: "config_unknown_field", message: "unknown" }],
    paths: { globalConfigFile: path.join(cwd, "home", "config.json"), projectConfigFile: path.join(cwd, ".pi", "workbench", "config.json") },
  };
}

test("startup wiring loads config/catalog after runtime start and status shows terse counts", async () => {
  const cwd = await tmpDir();
  const oldCwd = process.cwd();
  process.chdir(cwd);
  try {
    const pi = new FakePi();
    let loaded = false;
    createWorkbenchExtension({
      loadConfig: async () => configResult(cwd),
      loadCatalog: async (): Promise<AgentCatalog> => {
        loaded = true;
        return { agents: [], paths: { globalAgentsDir: path.join(cwd, "agents") }, diagnostics: [{ severity: "warning", code: "project_agents_untrusted", message: "skip" }] };
      },
    })(pi as never);
    const context = ctx(cwd, pi.entries);
    await pi.emit("session_start", { reason: "startup" }, context);
    assert.equal(loaded, true);
    assert.equal(pi.entries.length, 1);
    await pi.commands.get("observe")!.handler("status", context);
    assert.equal(context.notifications.at(-1)?.message.includes("config/catalog warnings=2"), true);
    assert.equal(context.notifications.at(-1)?.message.includes("project_agents_untrusted"), false);
  } finally {
    process.chdir(oldCwd);
  }
});

test("unexpected config/catalog loader failure fails soft and preserves parent observability", async () => {
  const cwd = await tmpDir();
  const oldCwd = process.cwd();
  process.chdir(cwd);
  try {
    const pi = new FakePi();
    createWorkbenchExtension({ loadConfig: async () => { throw new Error("boom"); } })(pi as never);
    const context = ctx(cwd, pi.entries);
    await pi.emit("session_start", { reason: "startup" }, context);
    assert.equal(context.notifications.some((n) => n.message.includes("config/catalog load failed")), true);
    await pi.emit("tool_execution_start", { toolCallId: "t", toolName: "read" }, context);
    await pi.commands.get("observe")!.handler("status", context);
    const status = context.notifications.at(-1)?.message ?? "";
    assert.equal(status.includes("config/catalog errors=1"), true);
    assert.equal(status.includes("tools=1"), true);
    const link = pi.entries[0]!.data as { runId: string };
    const trace = await fs.readFile(path.join(cwd, ".pi", "workbench", "traces", `${link.runId}.jsonl`), "utf8");
    assert.equal(trace.includes("tool_start"), true);
    assert.equal(trace.includes("startup_config_catalog_failed"), false);
  } finally {
    process.chdir(oldCwd);
  }
});
