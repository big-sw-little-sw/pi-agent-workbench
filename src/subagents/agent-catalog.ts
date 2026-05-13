import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentDefinition, ThinkingLevel } from "../core/types.js";
import type { WorkbenchDiagnostic } from "../core/diagnostics.js";
import type { WorkbenchConfigLoadResult } from "../config/workbench-config.js";

export type AgentCatalog = { agents: AgentDefinition[]; diagnostics: WorkbenchDiagnostic[]; paths: { globalAgentsDir: string; projectAgentsDir?: string } };
export type LoadAgentCatalogInput = { cwd: string; homeDir?: string; config: WorkbenchConfigLoadResult };

type Source = "user" | "project";
type Candidate = { agent: AgentDefinition; diagnostics: WorkbenchDiagnostic[] };

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const toolPattern = /^[a-zA-Z0-9_.:-]+$/;
const thinkingValues = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const promptModes = new Set(["append", "replace"]);
const allowedFields = ["description", "name", "iq", "model", "thinking", "tools", "systemPromptMode", "loadContextFiles"];

export async function loadAgentCatalog(input: LoadAgentCatalogInput): Promise<AgentCatalog> {
  const homeDir = input.homeDir ?? os.homedir();
  const projectRoot = input.config.paths.projectRoot ?? path.resolve(input.cwd);
  const globalAgentsDir = path.join(homeDir, ".pi", "agent", "workbench", "agents");
  const projectAgentsDir = path.join(projectRoot, ".pi", "workbench", "agents");
  const diagnostics: WorkbenchDiagnostic[] = [];

  const globalFiles = await listMarkdownFiles(globalAgentsDir, diagnostics);
  const user = await loadTier(globalFiles, "user", input.config.effectiveConfig.subagents.defaultTools, diagnostics);
  let project: AgentDefinition[] = [];
  const projectFiles = await listMarkdownFiles(projectAgentsDir, diagnostics);
  if (projectFiles.length) {
    if (!input.config.effectiveConfig.agents.trustProjectAgents) {
      diagnostics.push({
        severity: "warning",
        code: "project_agents_untrusted",
        message: `project agents are present but not trusted; skipped ${projectFiles.length} agent file(s)`,
        filePath: projectAgentsDir,
        count: projectFiles.length,
        hint: `set agents.trustProjectAgents=true in ${input.config.paths.projectConfigFile ?? path.join(projectRoot, ".pi", "workbench", "config.json")} and reload`,
      });
    } else {
      project = await loadTier(projectFiles, "project", input.config.effectiveConfig.subagents.defaultTools, diagnostics);
    }
  }

  const agents: AgentDefinition[] = [];
  const projectNames = new Set(project.map((agent) => agent.name));
  agents.push(...project);
  for (const agent of user) {
    if (projectNames.has(agent.name)) {
      diagnostics.push({ severity: "info", code: "agent_shadowed", message: "global agent shadowed by project agent", filePath: agent.filePath, agentName: agent.name });
    } else agents.push(agent);
  }
  const resolvedAgents = removeCaseConflicts(agents, diagnostics);
  resolvedAgents.sort((a, b) => a.name.localeCompare(b.name));
  return { agents: resolvedAgents, diagnostics, paths: { globalAgentsDir, projectAgentsDir } };
}

export function findAgent(catalog: AgentCatalog, name: string): AgentDefinition | undefined {
  return catalog.agents.find((agent) => agent.name === name);
}

async function listMarkdownFiles(dir: string, diagnostics: WorkbenchDiagnostic[]): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    diagnostics.push({ severity: "warning", code: "agents_dir_unreadable", message: "agents directory is unreadable", filePath: dir });
    return [];
  }
  return entries.filter((entry) => entry.endsWith(".md")).sort().map((entry) => path.join(dir, entry));
}

async function loadTier(files: string[], source: Source, defaultTools: string[], diagnostics: WorkbenchDiagnostic[]): Promise<AgentDefinition[]> {
  const candidates: Candidate[] = [];
  for (const file of files) {
    try {
      const text = await fs.readFile(file, "utf8");
      const candidate = parseAgent(file, text, source, defaultTools);
      diagnostics.push(...candidate.diagnostics);
      if (candidate.agent) candidates.push({ agent: candidate.agent, diagnostics: candidate.diagnostics });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code) diagnostics.push({ severity: "warning", code: "agent_file_unreadable", message: "agent file is unreadable", filePath: file });
      else diagnostics.push({ severity: "warning", code: "agent_frontmatter_invalid", message: shortMessage(error), filePath: file });
    }
  }
  return removeConflicts(candidates.map((c) => c.agent), diagnostics);
}

function parseAgent(filePath: string, text: string, source: Source, defaultTools: string[]): { agent?: AgentDefinition; diagnostics: WorkbenchDiagnostic[] } {
  const diagnostics: WorkbenchDiagnostic[] = [];
  const { frontmatter, body, ok } = splitFrontmatter(text, filePath, diagnostics);
  if (!ok) return { diagnostics };
  warnUnknown(frontmatter, filePath, diagnostics);
  const inferredName = path.basename(filePath, ".md");
  const name = readName(frontmatter.name, inferredName, filePath, diagnostics);
  const description = requiredString(frontmatter.description, "description", "agent_description", filePath, diagnostics, 500);
  const systemPrompt = body.trim();
  if (!systemPrompt) diagnostics.push({ severity: "warning", code: "agent_prompt_empty", message: "agent prompt body is empty", filePath, agentName: name });
  const iq = optionalString(frontmatter.iq, "iq", filePath, diagnostics);
  const model = optionalString(frontmatter.model, "model", filePath, diagnostics);
  const thinking = optionalEnum(frontmatter.thinking, thinkingValues, "thinking", filePath, diagnostics) as ThinkingLevel | undefined;
  const systemPromptMode = (optionalEnum(frontmatter.systemPromptMode, promptModes, "systemPromptMode", filePath, diagnostics) ?? "append") as "append" | "replace";
  const loadContextFiles = optionalBoolean(frontmatter.loadContextFiles, "loadContextFiles", filePath, diagnostics) ?? false;
  const tools = toolsField(frontmatter.tools, defaultTools, filePath, diagnostics);
  if (diagnostics.some((d) => d.severity === "warning" && d.code !== "agent_unknown_field")) return { diagnostics };
  return { diagnostics, agent: { name: name!, description: description!, systemPrompt, iq, model, thinking, tools, source, filePath, systemPromptMode, loadContextFiles } };
}

function splitFrontmatter(text: string, filePath: string, diagnostics: WorkbenchDiagnostic[]): { frontmatter: Record<string, unknown>; body: string; ok: boolean } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return { frontmatter: {}, body: text, ok: true };
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) {
    diagnostics.push({ severity: "warning", code: "agent_frontmatter_invalid", message: "invalid YAML frontmatter block", filePath });
    return { frontmatter: {}, body: "", ok: false };
  }
  try {
    const parsed = parseYaml(match[1] ?? "") as unknown;
    if (parsed === null || parsed === undefined) return { frontmatter: {}, body: match[2] ?? "", ok: true };
    if (!isObject(parsed)) throw new Error("frontmatter must be a mapping");
    return { frontmatter: parsed, body: match[2] ?? "", ok: true };
  } catch (error) {
    diagnostics.push({ severity: "warning", code: "agent_frontmatter_invalid", message: shortMessage(error), filePath });
    return { frontmatter: {}, body: "", ok: false };
  }
}

function warnUnknown(frontmatter: Record<string, unknown>, filePath: string, diagnostics: WorkbenchDiagnostic[]): void {
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(frontmatter)) if (!allowed.has(key)) diagnostics.push({ severity: "warning", code: "agent_unknown_field", message: "unknown agent frontmatter field ignored", filePath, fieldPath: key });
}
function readName(value: unknown, inferred: string, filePath: string, diagnostics: WorkbenchDiagnostic[]): string | undefined {
  if (value !== undefined && typeof value !== "string") {
    diagnostics.push({ severity: "warning", code: "agent_name_invalid", message: "agent name must be a string", filePath, fieldPath: "name" });
    return undefined;
  }
  const name = (value ?? inferred).trim();
  if (!namePattern.test(name)) diagnostics.push({ severity: "warning", code: "agent_name_invalid", message: "agent name is invalid", filePath, agentName: name, fieldPath: value === undefined ? undefined : "name" });
  return name;
}
function requiredString(value: unknown, field: string, codePrefix: string, filePath: string, diagnostics: WorkbenchDiagnostic[], max: number): string | undefined {
  if (value === undefined) { diagnostics.push({ severity: "warning", code: `${codePrefix}_missing`, message: `${field} is required`, filePath, fieldPath: field }); return undefined; }
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) { diagnostics.push({ severity: "warning", code: `${codePrefix}_invalid`, message: `${field} is invalid`, filePath, fieldPath: field }); return undefined; }
  return value.trim();
}
function optionalString(value: unknown, field: string, filePath: string, diagnostics: WorkbenchDiagnostic[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim()) return value.trim();
  diagnostics.push({ severity: "warning", code: "agent_field_invalid", message: `${field} is invalid`, filePath, fieldPath: field });
  return undefined;
}
function optionalEnum(value: unknown, values: Set<string>, field: string, filePath: string, diagnostics: WorkbenchDiagnostic[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && values.has(value)) return value;
  diagnostics.push({ severity: "warning", code: "agent_field_invalid", message: `${field} is invalid`, filePath, fieldPath: field });
  return undefined;
}
function optionalBoolean(value: unknown, field: string, filePath: string, diagnostics: WorkbenchDiagnostic[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  diagnostics.push({ severity: "warning", code: "agent_field_invalid", message: `${field} is invalid`, filePath, fieldPath: field });
  return undefined;
}
function toolsField(value: unknown, fallback: string[], filePath: string, diagnostics: WorkbenchDiagnostic[]): string[] {
  if (value === undefined) return [...fallback];
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0 && toolPattern.test(item))) return [...value];
  diagnostics.push({ severity: "warning", code: "agent_field_invalid", message: "tools is invalid", filePath, fieldPath: "tools" });
  return [];
}

function removeConflicts(agents: AgentDefinition[], diagnostics: WorkbenchDiagnostic[]): AgentDefinition[] {
  const byName = groupBy(agents, (agent) => agent.name);
  let surviving = new Set(agents);
  for (const [name, group] of byName) if (group.length > 1) {
    for (const agent of group) {
      surviving.delete(agent);
      diagnostics.push({ severity: "warning", code: "agent_duplicate_name", message: "duplicate agent name in same tier", filePath: agent.filePath, agentName: name });
    }
  }
  return removeCaseConflicts([...surviving], diagnostics);
}
function removeCaseConflicts(agents: AgentDefinition[], diagnostics: WorkbenchDiagnostic[]): AgentDefinition[] {
  const surviving = new Set(agents);
  const byLower = groupBy(agents, (agent) => agent.name.toLowerCase());
  for (const [lower, group] of byLower) if (group.length > 1) {
    for (const agent of group) {
      surviving.delete(agent);
      diagnostics.push({ severity: "warning", code: "agent_case_collision", message: "agent names differ only by case", filePath: agent.filePath, agentName: agent.name, fieldPath: lower });
    }
  }
  return [...surviving];
}
function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(keyFn(item), [...(map.get(keyFn(item)) ?? []), item]);
  return map;
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function shortMessage(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return message.length > 200 ? `${message.slice(0, 200)}…` : message; }
