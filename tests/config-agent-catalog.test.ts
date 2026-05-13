import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWorkbenchConfig, DEFAULT_WORKBENCH_CONFIG, loadAgentCatalog, findAgent } from "../src/index.js";

async function tmpDir(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "workbench-config-")); }
async function writeJson(file: string, value: unknown): Promise<void> { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
async function writeAgent(file: string, body: string): Promise<void> { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body); }
function codes(diags: { code: string }[]): string[] { return diags.map((d) => d.code); }

const validAgent = (name: string, description = "does work") => `---\nname: ${name}\ndescription: ${description}\n---\nYou are ${name}.\n`;

test("config defaults, missing files, and schema version defaulting", async () => {
  const home = await tmpDir();
  const cwd = await tmpDir();
  let result = await loadWorkbenchConfig({ cwd, homeDir: home });
  assert.deepEqual(result.effectiveConfig, DEFAULT_WORKBENCH_CONFIG);
  assert.deepEqual(result.diagnostics, []);

  await writeJson(result.paths.globalConfigFile, { agents: { trustProjectAgents: true } });
  result = await loadWorkbenchConfig({ cwd, homeDir: home });
  assert.equal(result.effectiveConfig.agents.trustProjectAgents, true);
  assert.equal(codes(result.diagnostics).includes("project_agents_globally_trusted"), true);
});

test("config global/project deep merge, invalid fallback, invalid JSON, and unknown fields", async () => {
  const home = await tmpDir();
  const cwd = await tmpDir();
  await fs.mkdir(path.join(cwd, ".git"));
  await writeJson(path.join(home, ".pi/agent/workbench/config.json"), {
    subagents: { defaultTimeoutMs: 1234, defaultTools: ["read"], extra: true },
    delegation: { maxParallel: 8 },
  });
  await writeJson(path.join(cwd, ".pi/workbench/config.json"), {
    subagents: { loadExtensions: true, defaultTimeoutMs: -1 },
    delegation: { enabledByDefault: true },
    unknown: 1,
  });
  const result = await loadWorkbenchConfig({ cwd: path.join(cwd), homeDir: home });
  assert.equal(result.paths.projectRoot, cwd);
  assert.equal(result.effectiveConfig.subagents.defaultTimeoutMs, 600_000);
  assert.deepEqual(result.effectiveConfig.subagents.defaultTools, ["read"]);
  assert.equal(result.effectiveConfig.subagents.loadExtensions, true);
  assert.equal(result.effectiveConfig.delegation.maxParallel, 8);
  assert.equal(result.effectiveConfig.delegation.enabledByDefault, true);
  assert.equal(codes(result.diagnostics).includes("config_unknown_field"), true);
  assert.equal(codes(result.diagnostics).includes("config_invalid_field"), true);

  await fs.writeFile(path.join(cwd, ".pi/workbench/config.json"), "{");
  const invalid = await loadWorkbenchConfig({ cwd, homeDir: home });
  assert.equal(codes(invalid.diagnostics).includes("config_invalid_json"), true);
  assert.equal(invalid.effectiveConfig.subagents.defaultTimeoutMs, 1234);
});

test("config project root resolution aligns with git and non-git cwd cases", async () => {
  const home = await tmpDir();
  const root = await tmpDir();
  await fs.mkdir(path.join(root, ".git"));
  await fs.mkdir(path.join(root, "a", "b"), { recursive: true });
  const git = await loadWorkbenchConfig({ cwd: path.join(root, "a", "b"), homeDir: home });
  assert.equal(git.paths.projectRoot, root);
  assert.equal(git.paths.projectConfigFile, path.join(root, ".pi", "workbench", "config.json"));
  const plain = await tmpDir();
  const nonGit = await loadWorkbenchConfig({ cwd: plain, homeDir: home });
  assert.equal(nonGit.paths.projectRoot, undefined);
  assert.equal(nonGit.paths.projectConfigFile, path.join(plain, ".pi", "workbench", "config.json"));
});

test("agent catalog loads globals, gates project trust, and warns on global trust", async () => {
  const home = await tmpDir();
  const project = await tmpDir();
  await writeAgent(path.join(home, ".pi/agent/workbench/agents/global.md"), validAgent("global"));
  await writeAgent(path.join(project, ".pi/workbench/agents/project.md"), validAgent("project"));
  let config = await loadWorkbenchConfig({ cwd: project, homeDir: home });
  let catalog = await loadAgentCatalog({ cwd: project, homeDir: home, config });
  assert.deepEqual(catalog.agents.map((a) => a.name), ["global"]);
  assert.equal(catalog.diagnostics.find((d) => d.code === "project_agents_untrusted")?.count, 1);

  await writeJson(path.join(project, ".pi/workbench/config.json"), { agents: { trustProjectAgents: true } });
  config = await loadWorkbenchConfig({ cwd: project, homeDir: home });
  catalog = await loadAgentCatalog({ cwd: project, homeDir: home, config });
  assert.deepEqual(catalog.agents.map((a) => a.name), ["global", "project"]);
  assert.equal(findAgent(catalog, "Project"), undefined);
  assert.equal(findAgent(catalog, "project")?.source, "project");
});

test("agent precedence, duplicate skips, case collisions, sorting, and shadowing diagnostics", async () => {
  const home = await tmpDir();
  const project = await tmpDir();
  await writeJson(path.join(project, ".pi/workbench/config.json"), { agents: { trustProjectAgents: true } });
  await writeAgent(path.join(home, ".pi/agent/workbench/agents/a.md"), validAgent("same"));
  await writeAgent(path.join(home, ".pi/agent/workbench/agents/dup1.md"), validAgent("dup"));
  await writeAgent(path.join(home, ".pi/agent/workbench/agents/dup2.md"), validAgent("dup"));
  await writeAgent(path.join(home, ".pi/agent/workbench/agents/case1.md"), validAgent("Case"));
  await writeAgent(path.join(home, ".pi/agent/workbench/agents/case2.md"), validAgent("case"));
  await writeAgent(path.join(home, ".pi/agent/workbench/agents/reviewer.md"), validAgent("reviewer"));
  await writeAgent(path.join(project, ".pi/workbench/agents/z.md"), validAgent("same"));
  await writeAgent(path.join(project, ".pi/workbench/agents/b.md"), validAgent("aaa"));
  await writeAgent(path.join(project, ".pi/workbench/agents/Reviewer.md"), validAgent("Reviewer"));
  const config = await loadWorkbenchConfig({ cwd: project, homeDir: home });
  const catalog = await loadAgentCatalog({ cwd: project, homeDir: home, config });
  assert.deepEqual(catalog.agents.map((a) => a.name), ["aaa", "same"]);
  assert.equal(findAgent(catalog, "same")?.source, "project");
  assert.equal(findAgent(catalog, "reviewer"), undefined);
  assert.equal(findAgent(catalog, "Reviewer"), undefined);
  assert.equal(codes(catalog.diagnostics).includes("agent_shadowed"), true);
  assert.equal(codes(catalog.diagnostics).includes("agent_duplicate_name"), true);
  assert.equal(codes(catalog.diagnostics).includes("agent_case_collision"), true);
});

test("agent frontmatter validation, defaults, unknown fields, and strict execution policy fields", async () => {
  const home = await tmpDir();
  const project = await tmpDir();
  const dir = path.join(home, ".pi/agent/workbench/agents");
  await writeJson(path.join(home, ".pi/agent/workbench/config.json"), { subagents: { defaultTools: [] } });
  await writeAgent(path.join(dir, "ok.md"), `---\ndescription: ok\ncontext: full\ntools: [read, bash:run]\nsystemPromptMode: replace\nloadContextFiles: true\niq: high\nmodel: model-x\nthinking: low\n---\nPrompt\n`);
  await writeAgent(path.join(dir, "bad-yaml.md"), `---\nname: [\n---\nPrompt\n`);
  await writeAgent(path.join(dir, "bad-name.md"), validAgent("bad name"));
  await writeAgent(path.join(dir, "missing-description.md"), `Prompt\n`);
  await writeAgent(path.join(dir, "empty-body.md"), `---\ndescription: empty\n---\n`);
  await writeAgent(path.join(dir, "bad-tools.md"), `---\ndescription: bad\ntools: [\"\"]\n---\nPrompt\n`);
  await writeAgent(path.join(dir, "bad-mode.md"), `---\ndescription: bad\nsystemPromptMode: nope\n---\nPrompt\n`);
  await writeAgent(path.join(dir, "bad-context.md"), `---\ndescription: bad\nloadContextFiles: yes\n---\nPrompt\n`);
  await writeAgent(path.join(dir, "bad-model.md"), `---\ndescription: bad\nmodel: \"\"\n---\nPrompt\n`);
  await writeAgent(path.join(dir, "bad-thinking.md"), `---\ndescription: bad\nthinking: huge\n---\nPrompt\n`);
  const config = await loadWorkbenchConfig({ cwd: project, homeDir: home });
  const catalog = await loadAgentCatalog({ cwd: project, homeDir: home, config });
  assert.deepEqual(catalog.agents.map((a) => a.name), ["ok"]);
  const ok = catalog.agents[0]!;
  assert.deepEqual(ok.tools, ["read", "bash:run"]);
  assert.equal(ok.systemPromptMode, "replace");
  assert.equal(ok.loadContextFiles, true);
  assert.equal(ok.iq, "high");
  assert.equal(ok.model, "model-x");
  assert.equal(ok.thinking, "low");
  for (const code of ["agent_unknown_field", "agent_frontmatter_invalid", "agent_name_invalid", "agent_description_missing", "agent_prompt_empty", "agent_field_invalid"]) {
    assert.equal(codes(catalog.diagnostics).includes(code), true, `missing ${code}`);
  }
});
