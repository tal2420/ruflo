import { describe, it, expect } from "vitest";
import { createSreflowServer } from "../../src/agent-runtime/mcp-server.js";

describe("createSreflowServer — construction smoke test", () => {
  it("builds an McpServer without throwing", () => {
    const server = createSreflowServer({
      driver: () => ({ session: () => ({}), close: () => undefined }) as never,
      anthropic: () => null,
      auditPath: "/tmp/sreflow-test-audit.jsonl",
      pauseStatePath: "/tmp/sreflow-test-paused.json",
      opaUrl: "http://localhost:8181",
    });
    expect(server).toBeTruthy();
    // Rough API-shape check — the McpServer exposes `connect` and `close`.
    expect(typeof (server as unknown as { connect?: unknown }).connect).toBe("function");
    expect(typeof (server as unknown as { close?: unknown }).close).toBe("function");
  });

  it("registers the expected set of tools (names reachable via internal registry)", () => {
    const server = createSreflowServer({
      driver: () => ({ session: () => ({}), close: () => undefined }) as never,
      anthropic: () => null,
      auditPath: "/tmp/sreflow-test-audit.jsonl",
      pauseStatePath: "/tmp/sreflow-test-paused.json",
      opaUrl: "http://localhost:8181",
    });
    // The McpServer keeps tools on an internal `_registeredTools` map. This
    // assertion is intentionally loose — if the SDK renames the internal
    // member we'll see it here before it surprises someone in prod.
    const registry = (server as unknown as { _registeredTools?: Record<string, unknown> })
      ._registeredTools;
    expect(registry).toBeTruthy();
    const names = Object.keys(registry ?? {}).sort();
    // Every tool we advertise in sre/docs/MCP_SERVER.md must appear here.
    for (const expected of [
      "sreflow_health",
      "sreflow_list_agents",
      "sreflow_inspect_agent",
      "sreflow_list_bps",
      "sreflow_inspect_bp",
      "sreflow_render_bp",
      "sreflow_audit_tail",
      "sreflow_report",
      "sreflow_run_agent",
      "sreflow_run_pipeline",
      "sreflow_pause_agent",
      "sreflow_resume_agent",
      "sreflow_curate_bp",
      "sreflow_propose_rename",
    ]) {
      expect(names).toContain(expected);
    }
  });
});
