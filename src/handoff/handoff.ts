import { promises as fs } from "node:fs";
import path from "node:path";
import { createHandoffId, createSpanId } from "../core/ids.js";
import type { AgentDefinition, ObservationSink, RunRecord } from "../core/types.js";
import type { TraceStore } from "../core/trace-store.js";
import { findAgent, type AgentCatalog } from "../subagents/agent-catalog.js";
import { buildStaticPrompt, prepareStaticArtifacts, sha256, writePromptArtifact } from "./artifacts.js";
import { HandoffStore } from "./store.js";
import type { HandoffActivation, HandoffMethod, HandoffRecord } from "./types.js";

export type HandoffRequest = {
  method: HandoffMethod;
  prompt?: string;
  artifacts?: string[];
  note?: string;
  targetAgentName?: string;
  autoStart?: boolean;
  headless?: boolean;
  allowPartialProfile?: boolean;
  allowExternalArtifacts?: boolean;
  confirmPartialProfile?: (message: string) => Promise<boolean>;
  confirmExternalArtifact?: (message: string, artifactPath: string) => Promise<boolean>;
  continueWithoutInvalidArtifact?: (message: string, artifactPath: string) => Promise<boolean>;
  editPrompt?: () => Promise<string | undefined>;
};

export type HandoffSessionAdapter = {
  createDraft(input: HandoffSessionInput): Promise<HandoffSessionResult>;
  autoStart(input: HandoffSessionInput & { prompt: string }): Promise<HandoffSessionResult>;
};

export type HandoffSessionInput = {
  parentSessionFile?: string;
  targetRun: RunRecord;
  runtimeLink: unknown;
  promptArtifactPath: string;
  targetAgent?: AgentDefinition;
  title: string;
  handoffId: string;
  sourceRun: RunRecord;
  promptArtifact: { path: string; sha256: string; size: number; redactions: number };
  method: HandoffMethod;
  activation: HandoffActivation;
};

export type HandoffSessionResult = { cancelled?: boolean; sessionId?: string; sessionFile?: string; targetTaskStatus?: "completed" | "failed"; targetTaskErrorMessage?: string };

export async function runHandoff(input: {
  request: HandoffRequest;
  sourceRun: RunRecord;
  store: TraceStore;
  sink: ObservationSink;
  catalog?: AgentCatalog;
  adapter?: HandoffSessionAdapter;
  now?: () => number;
}): Promise<HandoffRecord> {
  const now = input.now ?? Date.now;
  const handoffId = createHandoffId();
  const handoffStore = new HandoffStore(input.sourceRun.storageRoot);
  const artifactDir = path.join(input.sourceRun.storageRoot, "artifacts", input.sourceRun.runId, handoffId);
  const activation: HandoffActivation = input.request.autoStart ? "auto_start" : input.request.headless ? "artifact_only" : "draft";
  let record: HandoffRecord | undefined;
  let targetAgent: AgentDefinition | undefined;

  const emit = async (eventType: "handoff_start" | "handoff_end" | "artifact" | "error", data: Record<string, unknown>) => input.sink.emit({
    schemaVersion: 1,
    runId: input.sourceRun.runId,
    traceId: input.sourceRun.traceId,
    spanId: createSpanId(),
    source: "handoff",
    controlMode: input.sourceRun.controlMode,
    eventType,
    timestamp: now(),
    data: { handoffId, ...data },
  });

  try {
    targetAgent = resolveTargetAgent(input.request, input.catalog);
    await validatePartialProfile(input.request, targetAgent);
    const prompt = await buildPrompt({ ...input.request, cwd: input.store.cwd, projectRoot: input.store.projectRoot, artifactDir });
    const promptArtifact = await writePromptArtifact({ artifactDir, prompt: prompt.text });
    const createdAt = now();
    record = {
      schemaVersion: 1,
      handoffId,
      status: "completed",
      sourceRunId: input.sourceRun.runId,
      sourceTraceId: input.sourceRun.traceId,
      sourceSessionId: input.sourceRun.sessionId,
      sourceSessionFile: input.sourceRun.sessionFile,
      targetAgentName: targetAgent?.name,
      targetAgentApplication: targetAgent ? "persona_only" : "none",
      desiredTargetModel: targetAgent?.model,
      desiredTargetTools: targetAgent?.tools?.length ? targetAgent.tools : undefined,
      method: input.request.method,
      targetMode: "new_conversation",
      activation,
      selectedArtifacts: prompt.artifacts,
      targetPromptArtifact: promptArtifact,
      title: titleFor(prompt.text, targetAgent?.name),
      createdAt,
      updatedAt: createdAt,
    };
    await handoffStore.write(record);
    await emit("handoff_start", { method: record.method, targetMode: record.targetMode, activation, sourceRunId: record.sourceRunId, targetAgentName: record.targetAgentName });
    await emit("artifact", { phase: "handoff_prompt", path: promptArtifact.path, sha256: promptArtifact.sha256, size: promptArtifact.size });

    if (activation !== "artifact_only") {
      if (!input.adapter) throw new Error("handoff session adapter is required outside artifact-only mode");
      const targetRun = await input.store.createRun({ controlMode: input.sourceRun.controlMode, startedAt: now(), displayName: record.title, primaryModel: input.sourceRun.primaryModel });
      await input.store.appendEvent({
        schemaVersion: 1,
        runId: targetRun.runId,
        traceId: targetRun.traceId,
        spanId: targetRun.spanId ?? createSpanId(),
        source: "runtime",
        controlMode: targetRun.controlMode,
        eventType: "run_start",
        timestamp: targetRun.startedAt,
        data: { handoffId, sourceRunId: input.sourceRun.runId, sourceTraceId: input.sourceRun.traceId, sourceSessionId: input.sourceRun.sessionId, sourceSessionFile: input.sourceRun.sessionFile },
      });
      record = { ...record, targetRunId: targetRun.runId, targetTraceId: targetRun.traceId, updatedAt: now() };
      await handoffStore.write(record);
      const sessionInput: HandoffSessionInput = {
        parentSessionFile: input.sourceRun.sessionFile,
        targetRun,
        runtimeLink: { schemaVersion: 1, handoffId, sourceRunId: input.sourceRun.runId, sourceTraceId: input.sourceRun.traceId, sourceSessionId: input.sourceRun.sessionId, sourceSessionFile: input.sourceRun.sessionFile, targetRunId: targetRun.runId, targetTraceId: targetRun.traceId, storageRoot: targetRun.storageRoot, traceFile: targetRun.traceFile, createdAt: targetRun.startedAt, promptArtifact },
        promptArtifactPath: promptArtifact.path,
        promptArtifact,
        targetAgent,
        title: record.title ?? "Handoff",
        handoffId,
        sourceRun: input.sourceRun,
        method: record.method,
        activation,
      };
      const result = activation === "auto_start"
        ? await input.adapter.autoStart({ ...sessionInput, prompt: await fs.readFile(promptArtifact.path, "utf8") })
        : await input.adapter.createDraft(sessionInput);
      if (result.cancelled) throw new Error("target session creation was cancelled");
      const updatedTargetRun = { ...targetRun, sessionId: result.sessionId, sessionFile: result.sessionFile };
      await input.store.writeRun(updatedTargetRun);
      record = { ...record, targetRunId: targetRun.runId, targetTraceId: targetRun.traceId, targetSessionId: result.sessionId, targetSessionFile: result.sessionFile, submittedPromptHash: activation === "auto_start" ? promptArtifact.sha256 : undefined, targetTaskStatus: result.targetTaskStatus, targetTaskErrorMessage: result.targetTaskErrorMessage, updatedAt: now() };
      await handoffStore.write(record);
    }

    await emit("handoff_end", { status: record.status, method: record.method, activation, targetRunId: record.targetRunId, targetSessionFile: record.targetSessionFile, promptArtifact: record.targetPromptArtifact });
    return record;
  } catch (error) {
    const message = shortMessage(error);
    if (record) {
      record = { ...record, status: "partial", failureStage: "target_session", failureMessage: message, updatedAt: now() };
      await handoffStore.write(record);
    } else {
      const failedAt = now();
      record = {
        schemaVersion: 1,
        handoffId,
        status: "failed",
        failureStage: "validation",
        failureMessage: message,
        sourceRunId: input.sourceRun.runId,
        sourceTraceId: input.sourceRun.traceId,
        sourceSessionId: input.sourceRun.sessionId,
        sourceSessionFile: input.sourceRun.sessionFile,
        targetAgentName: targetAgent?.name ?? input.request.targetAgentName,
        targetAgentApplication: targetAgent ? "persona_only" : "none",
        desiredTargetModel: targetAgent?.model,
        desiredTargetTools: targetAgent?.tools?.length ? targetAgent.tools : undefined,
        method: input.request.method,
        targetMode: "new_conversation",
        activation,
        createdAt: failedAt,
        updatedAt: failedAt,
      };
      await handoffStore.write(record);
    }
    await emit("error", { phase: "handoff", message });
    await emit("handoff_end", { status: record.status, failureMessage: message, targetRunId: record.targetRunId });
    if (record.status === "partial") return record;
    throw error;
  }
}

type PromptBuild = { text: string; artifacts?: HandoffRecord["selectedArtifacts"] };

async function buildPrompt(request: HandoffRequest & { cwd: string; projectRoot?: string; artifactDir: string }): Promise<PromptBuild> {
  if (request.method === "extractive") throw new Error("extractive handoff comes in 03-3; use --mode manual or --mode static");
  if (request.method === "manual") {
    const prompt = request.prompt ?? await request.editPrompt?.();
    if (prompt === undefined) throw new Error("manual handoff requires --prompt in headless mode");
    return { text: prompt };
  }
  if (request.method === "static") {
    const artifacts = request.artifacts ?? [];
    if (!artifacts.length) throw new Error("static handoff requires at least one --artifact/--artifacts path");
    const prepared = await prepareStaticArtifacts({ cwd: request.cwd, projectRoot: request.projectRoot, artifactDir: request.artifactDir, artifacts, allowExternalArtifacts: request.allowExternalArtifacts, confirmExternalArtifact: request.headless ? undefined : request.confirmExternalArtifact, continueWithoutInvalidArtifact: request.headless ? undefined : request.continueWithoutInvalidArtifact });
    if (!prepared.length) throw new Error("static handoff has no accepted artifacts");
    return { text: buildStaticPrompt({ note: request.note, artifacts: prepared }), artifacts: prepared.map(({ promptText: _promptText, ...artifact }) => artifact) };
  }
  throw new Error(`unsupported handoff mode: ${request.method}`);
}

function resolveTargetAgent(request: HandoffRequest, catalog?: AgentCatalog): AgentDefinition | undefined {
  if (!request.targetAgentName) return undefined;
  const agent = catalog ? findAgent(catalog, request.targetAgentName) : undefined;
  if (!agent) throw new Error(`unknown target agent: ${request.targetAgentName}`);
  return agent;
}

async function validatePartialProfile(request: HandoffRequest, agent?: AgentDefinition): Promise<void> {
  if (!agent || (!agent.model && !agent.tools?.length)) return;
  const warning = `handoff target agent ${agent.name} has model/tools that are not applied in MVP; persona/thinking only will be used`;
  if (request.headless && !request.allowPartialProfile) throw new Error(`${warning}; pass allowPartialProfile for headless/API handoff`);
  if (!request.headless && !request.allowPartialProfile && !(await request.confirmPartialProfile?.(warning))) throw new Error("handoff cancelled because target profile is only partially applied");
}

function titleFor(prompt: string, target?: string): string {
  const prefix = prompt.replace(/\s+/g, " ").trim().slice(0, 48) || "new conversation";
  return target ? `Handoff to ${target}: ${prefix}` : `Handoff: ${prefix}`;
}

function shortMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

export { sha256 };
