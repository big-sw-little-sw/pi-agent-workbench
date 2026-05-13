import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkbenchPaths } from "../core/trace-store.js";
import type { WorkbenchDiagnostic } from "../core/diagnostics.js";

export type WorkbenchConfig = {
  schemaVersion: 1;
  agents: { trustProjectAgents: boolean };
  subagents: { defaultTools: string[]; defaultTimeoutMs: number; loadExtensions: boolean };
  delegation: { enabledByDefault: boolean; allowFullContext: boolean; maxParallel: number };
};

export type LoadedWorkbenchConfigFile = { filePath: string; config: WorkbenchConfig; raw: Record<string, unknown> };
export type WorkbenchConfigLoadResult = {
  effectiveConfig: WorkbenchConfig;
  globalConfig?: LoadedWorkbenchConfigFile;
  projectConfig?: LoadedWorkbenchConfigFile;
  diagnostics: WorkbenchDiagnostic[];
  paths: { globalConfigFile: string; projectConfigFile?: string; projectRoot?: string };
};
export type LoadWorkbenchConfigInput = { cwd: string; baseDir?: string; homeDir?: string };

export const DEFAULT_WORKBENCH_CONFIG: WorkbenchConfig = {
  schemaVersion: 1,
  agents: { trustProjectAgents: false },
  subagents: { defaultTools: ["read", "grep", "find", "ls"], defaultTimeoutMs: 600_000, loadExtensions: false },
  delegation: { enabledByDefault: false, allowFullContext: false, maxParallel: 4 },
};

const toolPattern = /^[a-zA-Z0-9_.:-]+$/;

export async function loadWorkbenchConfig(input: LoadWorkbenchConfigInput): Promise<WorkbenchConfigLoadResult> {
  const homeDir = input.homeDir ?? os.homedir();
  const paths = resolveWorkbenchPaths({ cwd: input.cwd, baseDir: input.baseDir });
  const projectRoot = paths.projectRoot ?? paths.cwd;
  const globalConfigFile = path.join(homeDir, ".pi", "agent", "workbench", "config.json");
  const projectConfigFile = path.join(projectRoot, ".pi", "workbench", "config.json");
  const diagnostics: WorkbenchDiagnostic[] = [];
  const globalConfig = await readConfigFile(globalConfigFile, diagnostics);
  const projectConfig = await readConfigFile(projectConfigFile, diagnostics);
  let effectiveConfig = clone(DEFAULT_WORKBENCH_CONFIG);
  if (globalConfig) effectiveConfig = mergePresentConfig(effectiveConfig, globalConfig);
  if (projectConfig) effectiveConfig = mergePresentConfig(effectiveConfig, projectConfig);
  if (globalConfig?.config.agents.trustProjectAgents) {
    diagnostics.push({
      severity: "warning",
      code: "project_agents_globally_trusted",
      message: "global config trusts project agents for all projects",
      filePath: globalConfig.filePath,
      fieldPath: "agents.trustProjectAgents",
      hint: "prefer project-local trust for specific repositories when possible",
    });
  }
  return { effectiveConfig, globalConfig, projectConfig, diagnostics, paths: { globalConfigFile, projectConfigFile, projectRoot: paths.projectRoot } };
}

async function readConfigFile(filePath: string, diagnostics: WorkbenchDiagnostic[]): Promise<LoadedWorkbenchConfigFile | undefined> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    diagnostics.push({ severity: "warning", code: "config_unreadable", message: "config file is unreadable", filePath });
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    diagnostics.push({ severity: "warning", code: "config_invalid_json", message: "config file contains invalid JSON", filePath });
    return undefined;
  }
  if (!isObject(raw)) {
    diagnostics.push({ severity: "warning", code: "config_invalid_field", message: "config file must contain an object", filePath });
    return undefined;
  }
  const schemaVersion = raw.schemaVersion ?? 1;
  if (schemaVersion !== 1) {
    diagnostics.push({ severity: "warning", code: "config_unsupported_schema", message: "unsupported config schema version", filePath, fieldPath: "schemaVersion" });
    return undefined;
  }
  const config = validateConfig(raw, filePath, diagnostics);
  return { filePath, raw, config };
}

function validateConfig(raw: Record<string, unknown>, filePath: string, diagnostics: WorkbenchDiagnostic[]): WorkbenchConfig {
  warnUnknown(raw, ["schemaVersion", "agents", "subagents", "delegation"], "", filePath, diagnostics);
  const config = clone(DEFAULT_WORKBENCH_CONFIG);
  config.schemaVersion = 1;
  if (raw.agents !== undefined) {
    if (isObject(raw.agents)) {
      warnUnknown(raw.agents, ["trustProjectAgents"], "agents", filePath, diagnostics);
      config.agents.trustProjectAgents = readBool(raw.agents.trustProjectAgents, config.agents.trustProjectAgents, "agents.trustProjectAgents", filePath, diagnostics);
    } else invalid("agents", filePath, diagnostics);
  }
  if (raw.subagents !== undefined) {
    if (isObject(raw.subagents)) {
      warnUnknown(raw.subagents, ["defaultTools", "defaultTimeoutMs", "loadExtensions"], "subagents", filePath, diagnostics);
      config.subagents.defaultTools = readTools(raw.subagents.defaultTools, config.subagents.defaultTools, "subagents.defaultTools", filePath, diagnostics);
      config.subagents.defaultTimeoutMs = readInt(raw.subagents.defaultTimeoutMs, config.subagents.defaultTimeoutMs, 1, 86_400_000, "subagents.defaultTimeoutMs", filePath, diagnostics);
      config.subagents.loadExtensions = readBool(raw.subagents.loadExtensions, config.subagents.loadExtensions, "subagents.loadExtensions", filePath, diagnostics);
    } else invalid("subagents", filePath, diagnostics);
  }
  if (raw.delegation !== undefined) {
    if (isObject(raw.delegation)) {
      warnUnknown(raw.delegation, ["enabledByDefault", "allowFullContext", "maxParallel"], "delegation", filePath, diagnostics);
      config.delegation.enabledByDefault = readBool(raw.delegation.enabledByDefault, config.delegation.enabledByDefault, "delegation.enabledByDefault", filePath, diagnostics);
      config.delegation.allowFullContext = readBool(raw.delegation.allowFullContext, config.delegation.allowFullContext, "delegation.allowFullContext", filePath, diagnostics);
      config.delegation.maxParallel = readInt(raw.delegation.maxParallel, config.delegation.maxParallel, 1, 16, "delegation.maxParallel", filePath, diagnostics);
    } else invalid("delegation", filePath, diagnostics);
  }
  return config;
}

function mergePresentConfig(base: WorkbenchConfig, loaded: LoadedWorkbenchConfigFile): WorkbenchConfig {
  const next = clone(base);
  const raw = loaded.raw;
  if (isObject(raw.agents) && "trustProjectAgents" in raw.agents) next.agents.trustProjectAgents = loaded.config.agents.trustProjectAgents;
  if (isObject(raw.subagents)) {
    if ("defaultTools" in raw.subagents) next.subagents.defaultTools = loaded.config.subagents.defaultTools;
    if ("defaultTimeoutMs" in raw.subagents) next.subagents.defaultTimeoutMs = loaded.config.subagents.defaultTimeoutMs;
    if ("loadExtensions" in raw.subagents) next.subagents.loadExtensions = loaded.config.subagents.loadExtensions;
  }
  if (isObject(raw.delegation)) {
    if ("enabledByDefault" in raw.delegation) next.delegation.enabledByDefault = loaded.config.delegation.enabledByDefault;
    if ("allowFullContext" in raw.delegation) next.delegation.allowFullContext = loaded.config.delegation.allowFullContext;
    if ("maxParallel" in raw.delegation) next.delegation.maxParallel = loaded.config.delegation.maxParallel;
  }
  return next;
}

function warnUnknown(obj: Record<string, unknown>, allowed: string[], prefix: string, filePath: string, diagnostics: WorkbenchDiagnostic[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) diagnostics.push({ severity: "warning", code: "config_unknown_field", message: "unknown config field ignored", filePath, fieldPath: prefix ? `${prefix}.${key}` : key });
  }
}
function readBool(value: unknown, fallback: boolean, fieldPath: string, filePath: string, diagnostics: WorkbenchDiagnostic[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  invalid(fieldPath, filePath, diagnostics);
  return fallback;
}
function readInt(value: unknown, fallback: number, min: number, max: number, fieldPath: string, filePath: string, diagnostics: WorkbenchDiagnostic[]): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
  invalid(fieldPath, filePath, diagnostics);
  return fallback;
}
function readTools(value: unknown, fallback: string[], fieldPath: string, filePath: string, diagnostics: WorkbenchDiagnostic[]): string[] {
  if (value === undefined) return fallback;
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0 && toolPattern.test(item))) return [...value];
  invalid(fieldPath, filePath, diagnostics);
  return fallback;
}
function invalid(fieldPath: string, filePath: string, diagnostics: WorkbenchDiagnostic[]): void {
  diagnostics.push({ severity: "warning", code: "config_invalid_field", message: "invalid config field; using default", filePath, fieldPath });
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
