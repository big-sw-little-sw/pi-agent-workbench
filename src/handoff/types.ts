import type { RunMetrics, RunRecord } from "../core/types.js";

export type HandoffMethod = "manual" | "static" | "extractive";
export type HandoffStatus = "completed" | "failed" | "partial";
export type HandoffActivation = "draft" | "auto_start" | "artifact_only";
export type HandoffTargetMode = "new_conversation";
export type ArtifactMode = "auto" | "reference" | "snapshot";
export type AppliedArtifactMode = "reference" | "snapshot";

export type HandoffArtifactReference = {
  originalPath: string;
  requestedMode: ArtifactMode;
  appliedMode: AppliedArtifactMode;
  reason?: string;
  size: number;
  sha256?: string;
  snapshotPath?: string;
  contentType: "text" | "binary" | "unknown";
  external: boolean;
};

export type HandoffRecord = {
  schemaVersion: 1;
  handoffId: string;
  status: HandoffStatus;
  failureStage?: string;
  failureMessage?: string;
  sourceRunId: string;
  sourceTraceId: string;
  sourceSessionId?: string;
  sourceSessionFile?: string;
  targetRunId?: string;
  targetTraceId?: string;
  targetSessionId?: string;
  targetSessionFile?: string;
  targetAgentName?: string;
  targetAgentApplication?: "none" | "persona_only";
  desiredTargetModel?: string;
  desiredTargetTools?: string[];
  method: HandoffMethod;
  targetMode: HandoffTargetMode;
  activation: HandoffActivation;
  selectedArtifacts?: HandoffArtifactReference[];
  targetPromptArtifact?: { path: string; sha256: string; size: number; redactions: number };
  submittedPromptHash?: string;
  targetTaskStatus?: "completed" | "failed";
  targetTaskErrorMessage?: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
};

export type HandoffLineageExport = {
  schemaVersion: 1;
  exportedAt: number;
  exportFile: string;
  runs: Array<{ run: RunRecord; metrics: RunMetrics }>;
  combinedMetrics: RunMetrics;
  handoffs: HandoffRecord[];
  sourceRunId?: string;
  targetRunId?: string;
  warnings?: string[];
};
