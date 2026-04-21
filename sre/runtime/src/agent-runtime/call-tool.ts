import type { AgentContext, ToolTarget } from "./types.js";
import { PolicyClient, queryFromContext } from "./policy-client.js";
import { writeAudit } from "./audit.js";

export class PolicyDenied extends Error {
  constructor(
    public readonly tool: string,
    public readonly reason: string,
  ) {
    super(`policy denied tool '${tool}': ${reason}`);
    this.name = "PolicyDenied";
  }
}

export interface CallToolOpts<I, O> {
  name: string;
  input: I;
  target: ToolTarget;
  impl: (input: I) => Promise<O>;
}

/**
 * Wraps every tool invocation with:
 *   1. OPA blast_radius.allow decision against the configured server.
 *   2. Audit log entry for either allow or deny.
 *   3. If dryRun, short-circuit after the policy decision — do not run impl.
 *   4. If allowed and not dryRun, execute impl and log completion/error.
 *
 * Any PolicyDenied thrown by this function is terminal for that tool call;
 * agents MUST NOT catch-and-retry. A denial is a signal, not a transient error.
 */
export async function callTool<I, O>(
  ctx: AgentContext,
  client: PolicyClient,
  opts: CallToolOpts<I, O>,
): Promise<O> {
  const query = queryFromContext(ctx, opts.name, opts.target);
  const decision = await client.decide(query);

  const baseAudit = {
    at: new Date().toISOString(),
    kind: "tool_decision" as const,
    role: ctx.role,
    sessionId: ctx.sessionId,
    tool: opts.name,
    target: opts.target as unknown as Record<string, unknown>,
  };

  if (!decision.allow) {
    writeAudit(ctx.auditPath, {
      ...baseAudit,
      allow: false,
      deny_reason: decision.deny_reason ?? "unknown",
    });
    throw new PolicyDenied(opts.name, decision.deny_reason ?? "unknown");
  }

  writeAudit(ctx.auditPath, { ...baseAudit, allow: true });

  if (ctx.dryRun) {
    writeAudit(ctx.auditPath, {
      ...baseAudit,
      kind: "tool_decision",
      allow: true,
      detail: "dry-run — impl skipped",
    });
    // Return a sentinel — callers should check ctx.dryRun before asserting on the result.
    return undefined as unknown as O;
  }

  try {
    return await opts.impl(opts.input);
  } catch (e) {
    writeAudit(ctx.auditPath, {
      ...baseAudit,
      kind: "tool_decision",
      allow: true,
      error: (e as Error).message,
    });
    throw e;
  }
}
