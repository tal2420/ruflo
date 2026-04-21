import { describe, it, expect } from "vitest";
import {
  PolicyClient,
  queryFromContext,
  type FetchLike,
} from "../../src/agent-runtime/policy-client.js";
import type { AgentContext } from "../../src/agent-runtime/types.js";

const baseCtx: AgentContext = {
  role: "dynatrace-collector",
  agentEnv: "prod",
  targetEnv: "prod",
  sessionId: "sess-1",
  approvals: [],
  dryRun: false,
  opaUrl: "http://opa.example",
  auditPath: "/tmp/_unused",
  now: "2026-04-21T10:00:00Z",
};

function mockFetch(handler: (url: string, init: RequestInit) => Response): FetchLike {
  return async (url, init) => handler(url, init ?? {});
}

function jsonResp(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("queryFromContext", () => {
  it("shapes the OPA input around (agent, tool, target, approvals, now)", () => {
    const q = queryFromContext(baseCtx, "kg__query", { env: "prod", businessProcessTier: 1 });
    expect(q).toEqual({
      agent: { role: "dynatrace-collector", env: "prod" },
      tool: "kg__query",
      target: { env: "prod", businessProcessTier: 1 },
      approvals: [],
      now: "2026-04-21T10:00:00Z",
    });
  });
});

describe("PolicyClient.decide", () => {
  it("returns allow=true when blast_radius.allow is true", async () => {
    const client = new PolicyClient({
      opaUrl: "http://opa.example",
      fetchImpl: mockFetch(() => jsonResp({ result: true })),
    });
    const d = await client.decide(queryFromContext(baseCtx, "kg__query", { env: "prod" }));
    expect(d.allow).toBe(true);
  });

  it("returns allow=false with deny_reason on denial", async () => {
    let callCount = 0;
    const client = new PolicyClient({
      opaUrl: "http://opa.example",
      fetchImpl: mockFetch((url) => {
        callCount += 1;
        if (url.endsWith("/blast_radius/allow")) return jsonResp({ result: false });
        return jsonResp({ result: "cross_environment_denied" });
      }),
    });
    const d = await client.decide(
      queryFromContext(baseCtx, "mcp__k8s__restart_pod", {
        env: "stage",
        businessProcessTier: 3,
      }),
    );
    expect(d.allow).toBe(false);
    expect(d.deny_reason).toBe("cross_environment_denied");
    expect(callCount).toBe(2);
  });

  it("targets /v1/data/sreflow/blast_radius/allow and POSTs {input: ...}", async () => {
    let seenUrl = "";
    let seenBody = "";
    const client = new PolicyClient({
      opaUrl: "http://opa.example",
      fetchImpl: mockFetch((url, init) => {
        seenUrl = url;
        seenBody = typeof init.body === "string" ? init.body : "";
        return jsonResp({ result: true });
      }),
    });
    await client.decide(queryFromContext(baseCtx, "kg__query", { env: "prod" }));
    expect(seenUrl).toBe("http://opa.example/v1/data/sreflow/blast_radius/allow");
    expect(JSON.parse(seenBody)).toHaveProperty("input.tool", "kg__query");
  });

  it("fails closed on network error", async () => {
    const client = new PolicyClient({
      opaUrl: "http://opa.example",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const d = await client.decide(queryFromContext(baseCtx, "kg__query", { env: "prod" }));
    expect(d.allow).toBe(false);
    expect(d.deny_reason).toMatch(/policy_unreachable/);
  });

  it("fails closed on non-2xx from OPA", async () => {
    const client = new PolicyClient({
      opaUrl: "http://opa.example",
      fetchImpl: mockFetch(() => new Response("boom", { status: 500 })),
    });
    const d = await client.decide(queryFromContext(baseCtx, "kg__query", { env: "prod" }));
    expect(d.allow).toBe(false);
    expect(d.deny_reason).toMatch(/policy_unreachable/);
  });
});
