import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  at: string;
  kind: "tool_decision" | "agent_start" | "agent_end" | "pause" | "resume";
  role: string;
  sessionId: string;
  tool?: string;
  allow?: boolean;
  deny_reason?: string;
  target?: Record<string, unknown>;
  detail?: string;
  error?: string;
}

/** Append one structured JSON line to the audit log. Creates the dir if needed. */
export function writeAudit(path: string, entry: AuditEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", { encoding: "utf8" });
}

export function readAuditTail(path: string, n: number): AuditEntry[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split(/\n/).filter(Boolean);
  const tail = lines.slice(-n);
  const out: AuditEntry[] = [];
  for (const l of tail) {
    try {
      out.push(JSON.parse(l) as AuditEntry);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}
