import { promises as fs } from "node:fs";
import path from "node:path";
import { writeJsonFileAtomic } from "../core/fs.js";
import type { HandoffRecord } from "./types.js";

export class HandoffStore {
  readonly handoffsDir: string;
  constructor(readonly storageRoot: string) {
    this.handoffsDir = path.join(storageRoot, "handoffs");
  }

  pathFor(handoffId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(handoffId)) throw new Error("Invalid handoffId");
    return path.join(this.handoffsDir, `${handoffId}.json`);
  }

  async write(record: HandoffRecord): Promise<void> {
    await writeJsonFileAtomic(this.pathFor(record.handoffId), { ...record, schemaVersion: 1 }, { createParentDirs: true });
  }

  async read(handoffId: string): Promise<HandoffRecord | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.pathFor(handoffId), "utf8")) as HandoffRecord;
      return { ...parsed, schemaVersion: 1 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<HandoffRecord[]> {
    let entries: string[];
    try { entries = await fs.readdir(this.handoffsDir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: HandoffRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const record = await this.read(entry.slice(0, -5));
        if (record) records.push(record);
      } catch { /* tolerate partial/corrupt lineage records */ }
    }
    return records.sort((a, b) => b.createdAt - a.createdAt);
  }
}
