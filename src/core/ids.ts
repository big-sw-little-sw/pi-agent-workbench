import { randomBytes } from "node:crypto";

const timestamp = (): string => Date.now().toString(36);
const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

export function createRunId(): string {
  return `run_${timestamp()}_${hex(6)}`;
}

export function createTraceId(): string {
  return `trace_${timestamp()}_${hex(6)}`;
}

export function createSpanId(): string {
  return `span_${hex(8)}`;
}

export function createAgentId(): string {
  return `agent_${hex(8)}`;
}
