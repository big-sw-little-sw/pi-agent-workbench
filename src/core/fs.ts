import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type AtomicWriteOptions = { createParentDirs?: boolean };

export async function writeFileAtomic(file: string, data: string | Buffer, options: AtomicWriteOptions = {}): Promise<void> {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  if (options.createParentDirs) await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  } catch (error) {
    try { await fs.unlink(tmp); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export async function writeJsonFileAtomic(file: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
}
