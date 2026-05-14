import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../core/fs.js";
import type { ArtifactMode, HandoffArtifactReference } from "./types.js";

const TEXT_PREVIEW_CAP = 64 * 1024;
const SECRET_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s`'\"]+/gi,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
];

export type RedactionResult = { text: string; count: number };
export type PreparedStaticArtifact = HandoffArtifactReference & { promptText?: string };

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function redactCommonSecrets(text: string): RedactionResult {
  let count = 0;
  let next = text;
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, () => { count += 1; return "[REDACTED]"; });
  }
  return { text: next, count };
}

export async function writePromptArtifact(input: { artifactDir: string; prompt: string }): Promise<{ path: string; sha256: string; size: number; redactions: number }> {
  const redacted = redactCommonSecrets(input.prompt);
  const file = path.join(input.artifactDir, "target-prompt.md");
  await writeFileAtomic(file, redacted.text, { createParentDirs: true });
  return { path: path.resolve(file), sha256: sha256(redacted.text), size: Buffer.byteLength(redacted.text), redactions: redacted.count };
}

export async function prepareStaticArtifacts(input: {
  cwd: string;
  projectRoot?: string;
  artifactDir: string;
  artifacts: string[];
  allowExternalArtifacts?: boolean;
  mode?: ArtifactMode;
  confirmExternalArtifact?: (message: string, artifactPath: string) => Promise<boolean>;
  continueWithoutInvalidArtifact?: (message: string, artifactPath: string) => Promise<boolean>;
}): Promise<PreparedStaticArtifact[]> {
  const out: PreparedStaticArtifact[] = [];
  for (const [index, requested] of input.artifacts.entries()) {
    const originalPath = path.resolve(input.cwd, requested);
    const external = !inside(input.projectRoot ?? input.cwd, originalPath);
    if (external && !input.allowExternalArtifacts) {
      if (!input.confirmExternalArtifact) throw new Error(`external artifact requires confirmation/allowExternalArtifacts: ${requested}`);
      const confirmed = await input.confirmExternalArtifact(`Include external handoff artifact? ${requested}`, originalPath);
      if (!confirmed) continue;
    }
    let stat;
    try {
      stat = await fs.stat(originalPath);
      if (stat.isDirectory()) throw new Error(`directories are not supported as handoff artifacts: ${requested}`);
    } catch (error) {
      const message = shortMessage(error);
      if (await input.continueWithoutInvalidArtifact?.(message, originalPath)) continue;
      throw error;
    }
    try {
      const requestedMode = input.mode ?? "auto";
      const contentType = await classify(originalPath, stat.size);
      let appliedMode: "reference" | "snapshot" = "reference";
      let reason: string | undefined;
      let snapshotPath: string | undefined;
      let hash: string | undefined;
      let promptText: string | undefined;
      if (requestedMode === "snapshot" || (requestedMode === "auto" && contentType === "text" && stat.size <= TEXT_PREVIEW_CAP)) {
        appliedMode = "snapshot";
        const data = await fs.readFile(originalPath);
        hash = sha256(data);
        const prefix = sha256(originalPath).slice(0, 12);
        snapshotPath = path.join(input.artifactDir, "snapshots", `${index}-${prefix}-${path.basename(originalPath)}`);
        await writeFileAtomic(snapshotPath, data, { createParentDirs: true });
        if (contentType === "text" && stat.size <= TEXT_PREVIEW_CAP) promptText = redactCommonSecrets(data.toString("utf8")).text;
        else reason = "snapshot stored; content omitted from prompt because it is large or non-text";
      } else if (requestedMode === "auto") {
        reason = contentType === "text" ? "text artifact over inline cap; referenced by path" : "binary/unknown artifact referenced by path";
      }
      out.push({ originalPath, requestedMode, appliedMode, reason, size: stat.size, sha256: hash, snapshotPath: snapshotPath ? path.resolve(snapshotPath) : undefined, contentType, external, promptText });
    } catch (error) {
      const message = shortMessage(error);
      if (await input.continueWithoutInvalidArtifact?.(message, originalPath)) continue;
      throw error;
    }
  }
  return out;
}

export function buildStaticPrompt(input: { note?: string; artifacts: PreparedStaticArtifact[] }): string {
  const lines = ["# Static handoff context", "", "This handoff packages selected artifacts without summarization.", ""];
  if (input.note) lines.push("## User note", input.note, "");
  lines.push("## Artifacts");
  input.artifacts.forEach((artifact, index) => {
    lines.push(`${index + 1}. ${artifact.originalPath}`, `   - mode: ${artifact.appliedMode}`, `   - size: ${artifact.size} bytes`);
    if (artifact.snapshotPath) lines.push(`   - snapshot: ${artifact.snapshotPath}`);
    if (artifact.reason) lines.push(`   - note: ${artifact.reason}`);
    if (artifact.promptText) lines.push("", "```", artifact.promptText, "```", "");
  });
  return `${lines.join("\n").trim()}\n`;
}

async function classify(file: string, size: number): Promise<"text" | "binary" | "unknown"> {
  const ext = path.extname(file).toLowerCase();
  if ([".md", ".txt", ".json", ".ts", ".js", ".yaml", ".yml"].includes(ext)) return "text";
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, 4096));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const prefix = buf.subarray(0, bytesRead);
    if (prefix.includes(0)) return "binary";
    return prefix.toString("utf8").includes("�") ? "unknown" : "text";
  } finally {
    await handle.close();
  }
}

function shortMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
