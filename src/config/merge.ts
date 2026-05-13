function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function overlayPresentFields<T extends Record<string, unknown>>(base: T, overlay: T, raw: Record<string, unknown>, paths: string[][]): T {
  const next = structuredClone(base) as T;
  for (const path of paths) {
    if (hasPresentPath(raw, path)) setPath(next, path, getPath(overlay, path));
  }
  return next;
}

export function hasPresentPath(raw: Record<string, unknown>, path: string[]): boolean {
  let current: unknown = raw;
  for (let index = 0; index < path.length; index += 1) {
    if (!isObject(current) || !(path[index]! in current)) return false;
    current = current[path[index]!];
  }
  return true;
}

function getPath(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) current = (current as Record<string, unknown>)[key];
  return current;
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current = obj;
  for (let index = 0; index < path.length - 1; index += 1) current = current[path[index]!] as Record<string, unknown>;
  current[path[path.length - 1]!] = value;
}
