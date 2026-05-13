import path from "node:path";
import { createSpanId } from "../core/ids.js";
import { TraceStore } from "../core/trace-store.js";
import type { ControlMode, ObservationEvent, ObservationSink, RunRecord, RunStatus } from "../core/types.js";

export type WorkbenchRuntimeOptions = {
  cwd: string;
  baseDir?: string;
  controlMode?: ControlMode;
  now?: () => number;
};

export type WorkbenchRuntimeLink = {
  schemaVersion?: number;
  runId: string;
  traceId: string;
  storageRoot?: string;
  traceFile?: string;
  createdAt?: number;
  metricsMayBeIncomplete?: boolean;
};

export type WorkbenchRuntimeSessionInfo = {
  reason?: string;
  sessionId?: string;
  sessionFile?: string;
  displayName?: string;
  primaryModel?: string;
  existingLinks?: WorkbenchRuntimeLink[];
  appendLink?: (link: WorkbenchRuntimeLink) => void | Promise<void>;
};

export type WorkbenchRuntimeStatus = {
  initialized: boolean;
  run?: RunRecord;
  resumed: boolean;
  metricsMayBeIncomplete: boolean;
  traceWriteFailed?: boolean;
  sessionFileChanged?: boolean;
  warnings: string[];
};

type Recovery = { runId?: string; traceFile?: string; reason: string };

type AttachWarning = { previousStatus?: RunStatus; possibleUncleanDetach?: boolean; warning?: string };

const terminalStatuses = new Set<RunStatus>(["completed", "failed", "aborted"]);
const finalStatuses = new Set<RunStatus>(["completed", "failed", "aborted", "unknown"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isWorkbenchRuntimeLink(value: unknown): value is WorkbenchRuntimeLink {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const link = value as Record<string, unknown>;
  if (link.schemaVersion !== undefined && link.schemaVersion !== 1) return false;
  return isNonEmptyString(link.runId) && isNonEmptyString(link.traceId);
}

function eventData(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export class WorkbenchRuntime implements ObservationSink {
  readonly store: TraceStore;
  private readonly now: () => number;
  private readonly controlMode: ControlMode;
  private run: RunRecord | undefined;
  private started = false;
  private detached = false;
  private ended = false;
  private resumed = false;
  private metricsMayBeIncomplete = false;
  private traceWriteFailed = false;
  private traceWriteReason: string | undefined;
  private sessionFileChanged = false;
  private warnings: string[] = [];

  constructor(options: WorkbenchRuntimeOptions) {
    this.store = new TraceStore({ cwd: options.cwd, baseDir: options.baseDir });
    this.now = options.now ?? Date.now;
    this.controlMode = options.controlMode ?? "manual";
  }

  async start(session: WorkbenchRuntimeSessionInfo): Promise<RunRecord> {
    if (this.started && this.run) return this.run;

    const selected = this.selectLink(session.existingLinks ?? []);
    let recovery: Recovery | undefined;
    let attachWarning: AttachWarning = {};
    let created = false;
    let run: RunRecord | undefined;

    if (selected) {
      try {
        const linked = await this.store.readRun(selected.runId);
        if (!linked) {
          recovery = { runId: selected.runId, traceFile: selected.traceFile, reason: "linked run was missing" };
        } else if (linked.traceId !== selected.traceId) {
          recovery = { runId: selected.runId, traceFile: linked.traceFile, reason: "linked run traceId mismatch" };
        } else if (!(await this.store.traceFileIsReadable(linked))) {
          recovery = { runId: selected.runId, traceFile: linked.traceFile, reason: "linked trace file was missing or unreadable" };
        } else if (terminalStatuses.has(linked.status)) {
          recovery = { runId: selected.runId, traceFile: linked.traceFile, reason: `linked run is ${linked.status}` };
        } else {
          run = linked;
          this.resumed = true;
          this.metricsMayBeIncomplete = Boolean(selected.metricsMayBeIncomplete);
          attachWarning = this.warningForPreviousStatus(linked.status);
        }
      } catch (error) {
        recovery = { runId: selected.runId, traceFile: selected.traceFile, reason: shortMessage(error) };
      }
    }

    if (!run) {
      created = true;
      this.resumed = false;
      this.metricsMayBeIncomplete = Boolean(recovery);
      run = await this.store.createRun({
        controlMode: this.controlMode,
        startedAt: this.now(),
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        displayName: session.displayName,
        primaryModel: session.primaryModel,
      });
      await session.appendLink?.({
        schemaVersion: 1,
        runId: run.runId,
        traceId: run.traceId,
        storageRoot: run.storageRoot,
        traceFile: run.traceFile,
        createdAt: run.startedAt,
        metricsMayBeIncomplete: this.metricsMayBeIncomplete || undefined,
      });
    }

    this.run = run;
    this.started = true;
    this.detached = false;
    this.ended = false;

    this.sessionFileChanged = Boolean(session.sessionFile && run.sessionFile && session.sessionFile !== run.sessionFile);
    if (this.sessionFileChanged) this.addWarning("session file changed; grouping may be ambiguous");
    if (this.metricsMayBeIncomplete) this.addWarning("metrics may be incomplete; previous workbench run link was invalid");

    if (created) {
      await this.emitLifecycle("run_start", {
        reason: session.reason,
        cwd: this.store.cwd,
        projectRoot: this.store.projectRoot,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        displayName: session.displayName,
        primaryModel: session.primaryModel,
        metricsMayBeIncomplete: this.metricsMayBeIncomplete || undefined,
        recoveredFromInvalidLink: recovery ? true : undefined,
      });
    }

    await this.emitLifecycle("runtime_attach", {
      reason: session.reason,
      cwd: this.store.cwd,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      sessionFileChanged: this.sessionFileChanged || undefined,
      resumed: this.resumed,
      previousStatus: attachWarning.previousStatus,
      possibleUncleanDetach: attachWarning.possibleUncleanDetach,
      warning: attachWarning.warning,
      metricsMayBeIncomplete: this.metricsMayBeIncomplete || undefined,
      recoveredFromInvalidLink: recovery ? true : undefined,
    });

    if (recovery) {
      await this.emitLifecycle("error", {
        phase: "runtime_start",
        oldRunId: recovery.runId,
        oldTraceFile: recovery.traceFile,
        reason: recovery.reason,
        recoveredFromInvalidLink: true,
        message: "created replacement workbench run; metrics may be incomplete",
      });
    }

    this.run = (await this.store.readRun(run.runId)) ?? run;
    return this.run;
  }

  async detach(input: { reason?: string } = {}): Promise<void> {
    if (!this.run || !this.started || this.detached || this.ended) return;
    await this.emitLifecycle("runtime_detach", { reason: input.reason, cwd: this.store.cwd });
    this.detached = true;
    this.run = (await this.store.readRun(this.run.runId)) ?? this.run;
  }

  async end(input: { status: "completed" | "failed" | "aborted" | "unknown"; reason?: string }): Promise<void> {
    if (!this.run || !this.started || this.ended) return;
    if (!finalStatuses.has(input.status)) throw new Error(`Invalid run end status: ${input.status}`);
    await this.emitLifecycle("run_end", { status: input.status, reason: input.reason });
    this.ended = true;
    this.run = (await this.store.readRun(this.run.runId)) ?? this.run;
  }

  async emit(event: ObservationEvent): Promise<void> {
    await this.store.appendEvent({ ...event, schemaVersion: 1 });
    this.run = (await this.store.readRun(event.runId)) ?? this.run;
  }

  getStatus(): WorkbenchRuntimeStatus {
    return {
      initialized: Boolean(this.run),
      run: this.run,
      resumed: this.resumed,
      metricsMayBeIncomplete: this.metricsMayBeIncomplete,
      traceWriteFailed: this.traceWriteFailed || undefined,
      sessionFileChanged: this.sessionFileChanged || undefined,
      warnings: [...this.warnings],
    };
  }

  getSink(): ObservationSink {
    return this;
  }

  markTraceWriteFailed(reason: unknown): void {
    this.traceWriteFailed = true;
    this.traceWriteReason = shortMessage(reason);
    this.addWarning(`trace writes degraded${this.traceWriteReason ? `: ${this.traceWriteReason}` : ""}`);
  }

  private selectLink(links: WorkbenchRuntimeLink[]): WorkbenchRuntimeLink | undefined {
    for (let i = links.length - 1; i >= 0; i -= 1) {
      const link = links[i];
      if (isWorkbenchRuntimeLink(link)) return { ...link, schemaVersion: link.schemaVersion ?? 1 };
    }
    return undefined;
  }

  private warningForPreviousStatus(status: RunStatus): AttachWarning {
    if (status === "running") return { previousStatus: status, possibleUncleanDetach: true };
    if (status === "unknown") return { previousStatus: status, warning: "resumed run with unknown status" };
    return { previousStatus: status };
  }

  private async emitLifecycle(eventType: ObservationEvent["eventType"], data: Record<string, unknown>): Promise<void> {
    if (!this.run) throw new Error("Workbench runtime is not initialized");
    await this.emit({
      schemaVersion: 1,
      runId: this.run.runId,
      traceId: this.run.traceId,
      spanId: this.run.spanId ?? createSpanId(),
      source: "runtime",
      controlMode: this.run.controlMode,
      eventType,
      timestamp: this.now(),
      data: eventData(data),
    });
  }

  private addWarning(warning: string): void {
    if (!this.warnings.includes(warning)) this.warnings.push(warning);
  }
}

function shortMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

export function relativeToCwd(cwd: string, file: string): string {
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}
