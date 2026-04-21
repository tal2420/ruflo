import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PauseRecord {
  role: string;
  reason: string;
  at: string;
  by: string;
}

interface PauseFile {
  paused: Record<string, PauseRecord>;
}

function load(path: string): PauseFile {
  if (!existsSync(path)) return { paused: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as PauseFile;
    return raw.paused ? raw : { paused: {} };
  } catch {
    return { paused: {} };
  }
}

function save(path: string, file: PauseFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), { encoding: "utf8" });
}

export function isPaused(path: string, role: string): PauseRecord | null {
  return load(path).paused[role] ?? null;
}

export function pause(
  path: string,
  role: string,
  reason: string,
  by = process.env.USER ?? "unknown",
): PauseRecord {
  const file = load(path);
  const rec: PauseRecord = { role, reason, at: new Date().toISOString(), by };
  file.paused[role] = rec;
  save(path, file);
  return rec;
}

export function resume(path: string, role: string): boolean {
  const file = load(path);
  if (!file.paused[role]) return false;
  delete file.paused[role];
  save(path, file);
  return true;
}

export function listPaused(path: string): PauseRecord[] {
  return Object.values(load(path).paused);
}
