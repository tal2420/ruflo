import { describe, it, expect } from "vitest";
import {
  listAgents,
  findAgent,
  loadAgent,
} from "../../src/agent-runtime/agent-yaml.js";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __tests__/agent-runtime → up 2, down into sre/agents (shared with CLI default).
const agentsRoot = pathResolve(__dirname, "../../../agents");

describe("agent-yaml loader", () => {
  it("loads all SREFlow agents from the real tree", () => {
    const agents = listAgents({ agentsRoot });
    // We currently ship 13 agents across 4 layers; anything less is a regression.
    expect(agents.length).toBeGreaterThanOrEqual(13);
    const roles = agents.map((a) => a.type).sort();
    expect(roles).toContain("dynatrace-collector");
    expect(roles).toContain("entity-resolver");
    expect(roles).toContain("incident-commander");
    expect(roles).toContain("remediator");
  });

  it("each agent carries tools.allowed and a sourcePath", () => {
    for (const a of listAgents({ agentsRoot })) {
      expect(a.tools.allowed).toBeInstanceOf(Array);
      expect(a.sourcePath).toBeTruthy();
    }
  });

  it("findAgent returns the matching definition by role", () => {
    const dt = findAgent("dynatrace-collector", { agentsRoot });
    expect(dt.type).toBe("dynatrace-collector");
    expect(dt.tools.allowed).toContain("mcp__dynatrace__list_entities");
  });

  it("throws a useful message when the role is unknown", () => {
    expect(() => findAgent("no-such-agent", { agentsRoot })).toThrow(/not found/);
  });

  it("loadAgent on an arbitrary file validates the shape", () => {
    const path = pathResolve(agentsRoot, "collectors/dynatrace-collector.yaml");
    const def = loadAgent(path);
    expect(def.type).toBe("dynatrace-collector");
    expect(def.tools.allowed.length).toBeGreaterThan(0);
  });
});
