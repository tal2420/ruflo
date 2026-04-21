import type {
  AgentContext,
  PolicyDecision,
  ToolTarget,
  Approval,
} from "./types.js";

export interface PolicyQuery {
  agent: { role: string; env: string };
  tool: string;
  target: ToolTarget;
  approvals: Approval[];
  now: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PolicyClientOpts {
  opaUrl: string;
  fetchImpl?: FetchLike;
}

/**
 * Thin HTTP client for OPA decision endpoints.
 *
 * POSTs {input: <query>} to /v1/data/sreflow/<package>/<rule>.
 * Fails closed: network or parse errors become `allow: false` with an
 * explanatory deny_reason. Never throws to the caller.
 */
export class PolicyClient {
  constructor(private opts: PolicyClientOpts) {}

  private async post(rule: string, query: PolicyQuery): Promise<unknown> {
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
    const url = `${this.opts.opaUrl.replace(/\/+$/, "")}/v1/data/sreflow/${rule}`;
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: query }),
    });
    if (!resp.ok) {
      throw new Error(`OPA ${url} → HTTP ${resp.status}`);
    }
    const body = (await resp.json()) as { result?: unknown };
    return body.result;
  }

  async decide(query: PolicyQuery): Promise<PolicyDecision> {
    try {
      const allow = await this.post("blast_radius/allow", query);
      if (allow === true) return { allow: true };
      let reason = "policy_denied";
      try {
        const r = await this.post("blast_radius/deny_reason", query);
        if (typeof r === "string" && r.length > 0) reason = r;
      } catch {
        // keep default reason
      }
      return { allow: false, deny_reason: reason };
    } catch (e) {
      // Fail closed — any error → deny.
      return {
        allow: false,
        deny_reason: `policy_unreachable: ${(e as Error).message}`,
      };
    }
  }
}

export function queryFromContext(
  ctx: AgentContext,
  tool: string,
  target: ToolTarget,
): PolicyQuery {
  return {
    agent: { role: ctx.role, env: ctx.agentEnv },
    tool,
    target,
    approvals: ctx.approvals,
    now: ctx.now,
  };
}
