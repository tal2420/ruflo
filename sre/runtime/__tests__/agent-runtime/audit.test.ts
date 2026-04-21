import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeAudit,
  readAuditTail,
} from "../../src/agent-runtime/audit.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sreflow-audit-"));
  path = join(dir, "audit.jsonl");
  return () => rmSync(dir, { recursive: true, force: true });
});

describe("audit", () => {
  it("appends one JSON line per entry", () => {
    writeAudit(path, {
      at: "2026-04-21T10:00:00Z",
      kind: "agent_start",
      role: "x",
      sessionId: "s1",
      detail: "hello",
    });
    writeAudit(path, {
      at: "2026-04-21T10:00:01Z",
      kind: "tool_decision",
      role: "x",
      sessionId: "s1",
      tool: "kg__query",
      allow: true,
    });
    const raw = readFileSync(path, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  it("readAuditTail returns the last n entries, parses each", () => {
    for (let i = 0; i < 5; i++) {
      writeAudit(path, {
        at: `2026-04-21T10:00:0${i}Z`,
        kind: "tool_decision",
        role: "x",
        sessionId: "s",
        tool: `t-${i}`,
        allow: true,
      });
    }
    const tail = readAuditTail(path, 3);
    expect(tail.map((e) => e.tool)).toEqual(["t-2", "t-3", "t-4"]);
  });

  it("returns empty array when the file doesn't exist", () => {
    expect(readAuditTail(join(dir, "nope.jsonl"), 10)).toEqual([]);
  });

  it("skips malformed lines when reading", () => {
    writeAudit(path, {
      at: "t",
      kind: "agent_start",
      role: "x",
      sessionId: "s",
    });
    // Append raw garbage
    const fs = require("node:fs") as typeof import("node:fs");
    fs.appendFileSync(path, "not valid json\n");
    writeAudit(path, {
      at: "t2",
      kind: "agent_end",
      role: "x",
      sessionId: "s",
    });
    const tail = readAuditTail(path, 10);
    expect(tail.map((e) => e.kind)).toEqual(["agent_start", "agent_end"]);
  });
});
