import fsSync from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createRunId, createSpanId } from "./ids.js";
import {
  applyEventToMetrics,
  createEmptyMetrics,
  normalizeReadSchemaVersion,
  prepareWriteSchemaVersion,
  runEndStatusFromEvent,
} from "./metrics.js";
import type { ControlMode, ObservationEvent, ObservationSource, RunMetrics, RunRecord, RunStatus } from "./types.js";

const sources: readonly ObservationSource[] = ["runtime", "parent", "subagent", "workflow", "delegation", "evaluator"];
const controlModes: readonly ControlMode[] = ["manual", "workflow", "llm-delegated", "hybrid"];
const statuses: readonly RunStatus[] = ["running", "detached", "completed", "failed", "aborted", "unknown"];

export type WorkbenchPaths = {
  cwd: string;
  projectRoot?: string;
  storageRoot: string;
  runsDir: string;
  tracesDir: string;
};

export type CreateRunRecordInput = {
  cwd: string;
  projectRoot?: string;
  storageRoot: string;
  runId?: string;
  traceId?: string;
  spanId?: string;
  controlMode?: ControlMode;
  status?: RunStatus;
  startedAt?: number;
  endedAt?: number;
  metrics?: RunMetrics;
  sessionId?: string;
  sessionFile?: string;
  displayName?: string;
  fallbackTitle?: string;
  primaryModel?: string;
};

type CreateRunInput = Omit<CreateRunRecordInput, "cwd" | "projectRoot" | "storageRoot" | "status" | "metrics" | "endedAt">;

function trimString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string): string {
  const trimmed = trimString(value);
  if (!trimmed) throw new Error(`Invalid ${field}`);
  return trimmed;
}

function safeFileId(value: unknown, field: string): string {
  const id = requiredString(value, field);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid ${field}`);
  return id;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = trimString(value);
  if (!trimmed) throw new Error(`Invalid ${field}`);
  return trimmed;
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${field}`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlMode(value: string): value is ControlMode {
  return (controlModes as readonly string[]).includes(value);
}

function isSource(value: string): value is ObservationSource {
  return (sources as readonly string[]).includes(value);
}

function isStatus(value: string): value is RunStatus {
  return (statuses as readonly string[]).includes(value);
}

function findGitRoot(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  if (!fsSync.existsSync(current)) return undefined;
  while (true) {
    if (fsSync.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function resolveWorkbenchPaths(input: { cwd: string; baseDir?: string }): WorkbenchPaths {
  const cwd = path.resolve(input.cwd);
  const projectRoot = findGitRoot(cwd);
  const storageRoot = input.baseDir
    ? path.resolve(cwd, input.baseDir)
    : path.join(projectRoot ?? cwd, ".pi", "workbench");
  return {
    cwd,
    projectRoot,
    storageRoot,
    runsDir: path.join(storageRoot, "runs"),
    tracesDir: path.join(storageRoot, "traces"),
  };
}

function normalizeMetrics(value: unknown): RunMetrics {
  if (!isObject(value)) throw new Error("Invalid metrics");
  return { ...createEmptyMetrics(), ...value } as RunMetrics;
}

function validateRecord(record: RunRecord): RunRecord {
  const schemaRecord = normalizeReadSchemaVersion(record);
  const runId = safeFileId(schemaRecord.runId, "runId");
  const traceId = safeFileId(schemaRecord.traceId, "traceId");
  const cwd = requiredString(schemaRecord.cwd, "cwd");
  const storageRoot = requiredString(schemaRecord.storageRoot, "storageRoot");
  const traceFile = requiredString(schemaRecord.traceFile, "traceFile");
  const controlMode = requiredString(schemaRecord.controlMode, "controlMode");
  const status = requiredString(schemaRecord.status, "status");
  if (!isControlMode(controlMode)) throw new Error("Invalid controlMode");
  if (!isStatus(status)) throw new Error("Invalid status");

  const next: RunRecord = {
    ...schemaRecord,
    schemaVersion: 1,
    runId,
    traceId,
    spanId: optionalString(schemaRecord.spanId, "spanId"),
    cwd,
    projectRoot: optionalString(schemaRecord.projectRoot, "projectRoot"),
    storageRoot,
    controlMode,
    status,
    startedAt: finiteNonNegative(schemaRecord.startedAt, "startedAt"),
    endedAt: schemaRecord.endedAt === undefined ? undefined : finiteNonNegative(schemaRecord.endedAt, "endedAt"),
    traceFile,
    metrics: normalizeMetrics(schemaRecord.metrics),
    sessionId: optionalString(schemaRecord.sessionId, "sessionId"),
    sessionFile: optionalString(schemaRecord.sessionFile, "sessionFile"),
  };
  return next;
}

export function createRunRecord(input: CreateRunRecordInput): RunRecord {
  const runId = input.runId === undefined ? createRunId() : safeFileId(input.runId, "runId");
  const traceId = input.traceId === undefined ? runId : safeFileId(input.traceId, "traceId");
  const record: RunRecord = {
    schemaVersion: 1,
    runId,
    traceId,
    spanId: input.spanId === undefined ? createSpanId() : requiredString(input.spanId, "spanId"),
    cwd: path.resolve(input.cwd),
    projectRoot: input.projectRoot ? path.resolve(input.projectRoot) : undefined,
    storageRoot: path.resolve(input.storageRoot),
    controlMode: input.controlMode ?? "manual",
    status: input.status ?? "running",
    startedAt: input.startedAt ?? Date.now(),
    endedAt: input.endedAt,
    traceFile: path.join(path.resolve(input.storageRoot), "traces", `${runId}.jsonl`),
    metrics: input.metrics ?? createEmptyMetrics(),
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    displayName: input.displayName,
    fallbackTitle: input.fallbackTitle,
    primaryModel: input.primaryModel,
  };
  return validateRecord(prepareWriteSchemaVersion(record));
}

function normalizeEvent(value: unknown, options: { strict: boolean }): ObservationEvent {
  if (!isObject(value)) throw new Error("Invalid event");
  const candidate = normalizeReadSchemaVersion(value as ObservationEvent);
  const runId = safeFileId(candidate.runId, "runId");
  const traceId = safeFileId(candidate.traceId, "traceId");
  const spanId = requiredString(candidate.spanId, "spanId");
  const source = requiredString(candidate.source, "source");
  const controlMode = requiredString(candidate.controlMode, "controlMode");
  const eventType = requiredString(candidate.eventType, "eventType");
  if (options.strict && !isSource(source)) throw new Error("Invalid source");
  if (options.strict && !isControlMode(controlMode)) throw new Error("Invalid controlMode");
  return {
    ...(candidate as ObservationEvent),
    schemaVersion: 1,
    runId,
    traceId,
    spanId,
    parentSpanId: optionalString(candidate.parentSpanId, "parentSpanId"),
    source: source as ObservationSource,
    controlMode: controlMode as ControlMode,
    eventType,
    timestamp: finiteNonNegative(candidate.timestamp, "timestamp"),
  };
}

function runPath(runsDir: string, runId: string): string {
  const id = safeFileId(runId, "runId");
  const file = path.join(runsDir, `${id}.json`);
  if (!isPathInsideOrEqual(runsDir, file)) throw new Error("Run path is outside runsDir");
  return file;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fsSync.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isPathInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class TraceStore {
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly storageRoot: string;
  readonly runsDir: string;
  readonly tracesDir: string;
  private queues = new Map<string, Promise<void>>();

  constructor(options: { cwd: string; baseDir?: string }) {
    const paths = resolveWorkbenchPaths(options);
    this.cwd = paths.cwd;
    this.projectRoot = paths.projectRoot;
    this.storageRoot = paths.storageRoot;
    this.runsDir = paths.runsDir;
    this.tracesDir = paths.tracesDir;
  }

  async createRun(input: CreateRunInput = {}): Promise<RunRecord> {
    const {
      runId,
      traceId,
      spanId,
      controlMode,
      startedAt,
      sessionId,
      sessionFile,
      displayName,
      fallbackTitle,
      primaryModel,
    } = input;
    const record = createRunRecord({
      cwd: this.cwd,
      projectRoot: this.projectRoot,
      storageRoot: this.storageRoot,
      runId,
      traceId,
      spanId,
      controlMode,
      startedAt,
      sessionId,
      sessionFile,
      displayName,
      fallbackTitle,
      primaryModel,
    });
    await fs.mkdir(this.runsDir, { recursive: true });
    await fs.mkdir(this.tracesDir, { recursive: true });
    const recordPath = runPath(this.runsDir, record.runId);
    if (await exists(recordPath)) throw new Error(`Run already exists: ${record.runId}`);
    if (await exists(record.traceFile)) throw new Error(`Trace already exists: ${record.traceFile}`);
    await fs.writeFile(record.traceFile, "", { flag: "wx" });
    await fs.writeFile(recordPath, JSON.stringify(prepareWriteSchemaVersion(record), null, 2), { flag: "wx" });
    return record;
  }

  async appendEvent(event: ObservationEvent): Promise<void> {
    const runId = safeFileId(event.runId, "runId");
    const prior = this.queues.get(runId) ?? Promise.resolve();
    const next = prior.then(() => this.appendEventUnlocked(event));
    this.queues.set(runId, next.catch(() => undefined));
    return next;
  }

  private async appendEventUnlocked(event: ObservationEvent): Promise<void> {
    const normalized = prepareWriteSchemaVersion(normalizeEvent(event, { strict: true }));
    const record = await this.readRun(normalized.runId);
    if (!record) throw new Error(`Missing run record: ${normalized.runId}`);
    if (normalized.traceId !== record.traceId) throw new Error("Event traceId does not match run");
    await fs.appendFile(record.traceFile, `${JSON.stringify(normalized)}\n`);
    let metrics = applyEventToMetrics(record.metrics, normalized);
    let updated: RunRecord = { ...record, metrics };
    if (normalized.eventType === "runtime_attach") {
      updated = { ...updated, status: "running" };
    } else if (normalized.eventType === "runtime_detach") {
      updated = { ...updated, status: "detached" };
    } else if (normalized.eventType === "run_end") {
      updated = { ...updated, status: runEndStatusFromEvent(normalized), endedAt: normalized.timestamp };
    }
    await this.writeRun(updated);
  }

  async readRun(runId: string): Promise<RunRecord | undefined> {
    const id = safeFileId(runId, "runId");
    const file = runPath(this.runsDir, id);
    if (!(await exists(file))) return undefined;
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as RunRecord;
    return validateRecord(parsed);
  }

  async writeRun(record: RunRecord): Promise<void> {
    const normalized = validateRecord(prepareWriteSchemaVersion(record));
    if ((normalized.projectRoot ?? undefined) !== (this.projectRoot ?? undefined)) throw new Error("Run projectRoot conflicts with store");
    if (normalized.storageRoot !== this.storageRoot) throw new Error("Run storageRoot conflicts with store");
    if (!isPathInsideOrEqual(this.tracesDir, normalized.traceFile)) throw new Error("Run traceFile is outside tracesDir");
    const expectedTrace = path.join(this.tracesDir, `${normalized.runId}.jsonl`);
    if (normalized.traceFile !== expectedTrace) throw new Error("Run traceFile must match runId");
    await fs.mkdir(this.runsDir, { recursive: true });
    const file = runPath(this.runsDir, normalized.runId);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(normalized, null, 2));
    await fs.rename(tmp, file);
  }

  async listRuns(): Promise<RunRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.runsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const runs: RunRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const run = await this.readRun(entry.slice(0, -5));
      if (run) runs.push(run);
    }
    return runs.sort((a, b) => {
      const at = Number.isFinite(a.startedAt) ? a.startedAt : -1;
      const bt = Number.isFinite(b.startedAt) ? b.startedAt : -1;
      return bt - at;
    });
  }

  async traceFileIsReadable(record: RunRecord): Promise<boolean> {
    const normalized = validateRecord(record);
    if ((normalized.projectRoot ?? undefined) !== (this.projectRoot ?? undefined)) throw new Error("Run projectRoot conflicts with store");
    if (normalized.storageRoot !== this.storageRoot) throw new Error("Run storageRoot conflicts with store");
    if (!isPathInsideOrEqual(this.tracesDir, normalized.traceFile)) throw new Error("Run traceFile is outside tracesDir");
    const expectedTrace = path.join(this.tracesDir, `${normalized.runId}.jsonl`);
    if (normalized.traceFile !== expectedTrace) throw new Error("Run traceFile must match runId");
    return readable(normalized.traceFile);
  }

  async readTrace(runId: string): Promise<ObservationEvent[]> {
    const id = safeFileId(runId, "runId");
    const record = await this.readRun(id);
    if (!record || !(await exists(record.traceFile))) return [];
    const lines = (await fs.readFile(record.traceFile, "utf8")).split(/\r?\n/);
    const events: ObservationEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = normalizeEvent(JSON.parse(line), { strict: false });
        if (event.runId !== id) continue;
        if (event.traceId !== record.traceId) continue;
        events.push(event);
      } catch {
        continue;
      }
    }
    return events;
  }
}
