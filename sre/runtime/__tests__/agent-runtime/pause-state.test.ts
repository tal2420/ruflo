import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPaused,
  pause,
  resume,
  listPaused,
} from "../../src/agent-runtime/pause-state.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sreflow-pause-"));
  path = join(dir, "paused.json");
  return () => rmSync(dir, { recursive: true, force: true });
});

describe("pause-state", () => {
  it("reports not-paused for a fresh state file", () => {
    expect(isPaused(path, "any")).toBeNull();
    expect(listPaused(path)).toEqual([]);
  });

  it("pauses and later resumes a role; reflects in listPaused", () => {
    pause(path, "remediator", "on-call handoff", "alice");
    const rec = isPaused(path, "remediator");
    expect(rec).not.toBeNull();
    expect(rec!.reason).toBe("on-call handoff");
    expect(rec!.by).toBe("alice");

    expect(listPaused(path)).toHaveLength(1);

    const cleared = resume(path, "remediator");
    expect(cleared).toBe(true);
    expect(isPaused(path, "remediator")).toBeNull();
  });

  it("resume returns false when the role wasn't paused", () => {
    expect(resume(path, "nonexistent")).toBe(false);
  });

  it("persists across calls via the file", () => {
    pause(path, "a", "r1", "u");
    pause(path, "b", "r2", "u");
    expect(listPaused(path).map((p) => p.role).sort()).toEqual(["a", "b"]);
  });
});
