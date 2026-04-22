// SREFlow MCP server — exposes the agent runtime + knowledge base as MCP
// tools so Claude Desktop (and any MCP client) can drive a session:
//
//   "list paused agents" → sreflow_list_agents
//   "show me the components of תיק רפואי" → sreflow_inspect_bp
//   "rename this BP and lock the name" → sreflow_curate_bp
//   "re-run the discovery pipeline" → sreflow_run_pipeline
//
// Transport: stdio (see bin/sreflow-mcp.ts). Credentials (Neo4j password,
// ANTHROPIC_API_KEY) live in the MCP server's process env, set in Claude
// Desktop's claude_desktop_config.json — never in chat.
//
// Writes that mutate the KB go through the same reconciliation/curate code
// the CLI uses, so every change inherits audit logging, lockedFields,
// addedBy attribution, and OPA policy gating for agent runs.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import neo4j, { type Driver } from "neo4j-driver";
import { randomUUID } from "node:crypto";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  findAgent,
  getImpl,
  isPaused,
  listAgents,
  listPaused,
  pause as pauseRole,
  PolicyDenied,
  readAuditTail,
  renderBp,
  resume as resumeRole,
  runnableRoles,
  writeAudit,
  type AgentContext,
  type Approval,
} from "./index.js";
import {
  proposeBetterName,
  defaultModel as defaultRenameModel,
  type BpRenameContext,
} from "./llm-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/agent-runtime → up to runtime, then into .state
const STATE_DIR = pathResolve(__dirname, "../../.state");

interface ServerDeps {
  /** Factory for Neo4j driver — overridable in tests. */
  driver: () => Driver;
  /** Factory for Anthropic client (created lazily; null if no API key). */
  anthropic: () => Anthropic | null;
  auditPath: string;
  pauseStatePath: string;
  opaUrl: string;
}

function defaultDeps(): ServerDeps {
  let cachedDriver: Driver | null = null;
  let cachedAnthropic: Anthropic | null = null;
  let anthropicTried = false;
  return {
    driver: () => {
      if (!cachedDriver) {
        cachedDriver = neo4j.driver(
          process.env.NEO4J_URI ?? "bolt://localhost:7687",
          neo4j.auth.basic(
            process.env.NEO4J_USER ?? "neo4j",
            process.env.NEO4J_PASSWORD ?? "phase0-password-change-me",
          ),
        );
      }
      return cachedDriver;
    },
    anthropic: () => {
      if (cachedAnthropic) return cachedAnthropic;
      if (anthropicTried) return null;
      anthropicTried = true;
      if (!process.env.ANTHROPIC_API_KEY) return null;
      cachedAnthropic = new Anthropic();
      return cachedAnthropic;
    },
    auditPath:
      process.env.SREFLOW_AUDIT_PATH ?? pathResolve(STATE_DIR, "audit.jsonl"),
    pauseStatePath:
      process.env.SREFLOW_PAUSE_STATE ??
      pathResolve(STATE_DIR, "paused-agents.json"),
    opaUrl: process.env.OPA_URL ?? "http://localhost:8181",
  };
}

function sreflowUser(): string {
  return process.env.SREFLOW_USER ?? process.env.USER ?? "claude-desktop";
}

// ----------------------------------------------------------------------------
// Helpers

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function asText(value: unknown): ToolResult {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function asError(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

async function readBpByQuery(
  driver: Driver,
  query: string,
): Promise<Record<string, unknown> | null> {
  const s = driver.session();
  try {
    const r = await s.run(
      `MATCH (bp:BusinessProcess)
       WHERE bp.id = $q OR bp.name = $q OR bp.nameHe = $q
       RETURN bp LIMIT 1`,
      { q: query },
    );
    if (r.records.length === 0) return null;
    return r.records[0]!.get("bp").properties as Record<string, unknown>;
  } finally {
    await s.close();
  }
}

async function readBpComponents(
  driver: Driver,
  bpId: string,
): Promise<
  Array<{ id: string; primaryName: string; role?: string; status?: string }>
> {
  const s = driver.session();
  try {
    const r = await s.run(
      `MATCH (:BusinessProcess { id: $id })-[rel:REALIZED_BY]->(c:CanonicalEntity)
       RETURN c.id AS id,
              coalesce(c.primaryName, c.id) AS primaryName,
              rel.role AS role,
              coalesce(rel.status, "active") AS status`,
      { id: bpId },
    );
    return r.records.map((rec) => {
      const row = {
        id: rec.get("id") as string,
        primaryName: rec.get("primaryName") as string,
        role: (rec.get("role") as string | null) ?? undefined,
        status: (rec.get("status") as string | null) ?? undefined,
      };
      return row;
    });
  } finally {
    await s.close();
  }
}

async function readHostedIn(
  driver: Driver,
  bpId: string,
): Promise<{ id: string; name: string; nameHe?: string } | null> {
  const s = driver.session();
  try {
    const r = await s.run(
      `MATCH (:BusinessProcess { id: $id })-[:HOSTED_IN]->(app:BusinessProcess)
       RETURN app LIMIT 1`,
      { id: bpId },
    );
    if (r.records.length === 0) return null;
    const p = r.records[0]!.get("app").properties as {
      id: string;
      name?: string;
      nameHe?: string;
    };
    return { id: p.id, name: p.name ?? p.id, nameHe: p.nameHe };
  } finally {
    await s.close();
  }
}

function coerceNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  const n =
    typeof (v as { toNumber?: () => number }).toNumber === "function"
      ? (v as { toNumber: () => number }).toNumber()
      : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseSinceWindow(raw: string | undefined): string {
  // Returns an ISO timestamp for the cutoff.
  const ms = (() => {
    if (!raw) return 24 * 3600 * 1000;
    const m = raw.match(/^(\d+)\s*([smhd])?$/i);
    if (!m) return 24 * 3600 * 1000;
    const n = Number(m[1]);
    const unit = (m[2] ?? "h").toLowerCase();
    const mult =
      { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[unit] ?? 3600_000;
    return n * mult;
  })();
  return new Date(Date.now() - ms).toISOString();
}

// ----------------------------------------------------------------------------
// Server factory

export function createSreflowServer(
  deps: ServerDeps = defaultDeps(),
): McpServer {
  const server = new McpServer({
    name: "sreflow",
    version: "0.1.0",
  });

  // -------- READ: health -----------------------------------------------------

  server.registerTool(
    "sreflow_health",
    {
      title: "SREFlow health",
      description:
        "Return the state of Neo4j, OPA, the audit log, and the MCP server's env. Call first when a session begins to confirm everything is reachable.",
      inputSchema: {},
    },
    async () => {
      const report: Record<string, unknown> = {
        auditPath: deps.auditPath,
        pauseStatePath: deps.pauseStatePath,
        opaUrl: deps.opaUrl,
        user: sreflowUser(),
        anthropicKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
      };
      try {
        const s = deps.driver().session();
        try {
          // Aggregation always yields one row (count=0 when there are no
          // matches), so this also works on a fresh / empty graph.
          const r = await s.run(
            `MATCH (n:BusinessProcess) RETURN count(n) AS n`,
          );
          const n = coerceNumber(r.records[0]!.get("n")) ?? 0;
          report.neo4j = "ok";
          report.businessProcessCount = n;
          report.hasBusinessProcesses = n > 0;
        } finally {
          await s.close();
        }
      } catch (e) {
        report.neo4j = `unreachable: ${(e as Error).message}`;
      }
      try {
        const resp = await fetch(`${deps.opaUrl}/health`, { method: "GET" });
        report.opa = resp.ok ? "ok" : `http-${resp.status}`;
      } catch (e) {
        report.opa = `unreachable: ${(e as Error).message}`;
      }
      return asText(report);
    },
  );

  // -------- READ: agents -----------------------------------------------------

  server.registerTool(
    "sreflow_list_agents",
    {
      title: "List SREFlow agents",
      description:
        "Enumerate every agent defined under sre/agents/. Shows which are runnable by the CLI/MCP, which are currently paused, their blast-radius class, and their architectural layer.",
      inputSchema: {},
    },
    async () => {
      const agents = listAgents();
      const runnable = new Set(runnableRoles());
      const pausedSet = new Set(
        listPaused(deps.pauseStatePath).map((p) => p.role),
      );
      return asText(
        agents.map((a) => ({
          type: a.type,
          layer: a.layer,
          blast_radius: a.blast_radius,
          envs: a.environments,
          runnable: runnable.has(a.type),
          paused: pausedSet.has(a.type),
        })),
      );
    },
  );

  server.registerTool(
    "sreflow_inspect_agent",
    {
      title: "Inspect an agent",
      description:
        "Return the full definition for one agent: capabilities, allowed/denied tools, envs, blast radius, and its current paused state.",
      inputSchema: { role: z.string().describe("Agent role/type, e.g. dynatrace-collector") },
    },
    async ({ role }) => {
      try {
        const def = findAgent(role);
        const rec = isPaused(deps.pauseStatePath, role);
        return asText({
          type: def.type,
          layer: def.layer,
          description: def.description,
          blast_radius: def.blast_radius,
          environments: def.environments,
          capabilities: def.capabilities,
          tools: def.tools,
          invocation: def.invocation,
          runnable: runnableRoles().includes(role),
          paused: rec ?? null,
        });
      } catch (e) {
        return asError(e);
      }
    },
  );

  // -------- READ: business processes -----------------------------------------

  server.registerTool(
    "sreflow_list_bps",
    {
      title: "List business processes",
      description:
        "Query the Neo4j knowledge base for BusinessProcess nodes with optional filters. Useful for answering 'which features are tier-1?' or 'which BPs have human-curated names?'",
      inputSchema: {
        scope: z.enum(["application", "feature"]).optional(),
        name_contains: z
          .string()
          .optional()
          .describe("Case-insensitive substring match on name or nameHe."),
        tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        locked_only: z
          .boolean()
          .optional()
          .describe("When true, returns only BPs that have at least one locked field."),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async (input) => {
      const limit = input.limit ?? 100;
      const s = deps.driver().session();
      try {
        const r = await s.run(
          `MATCH (bp:BusinessProcess)
           WHERE ($scope IS NULL OR bp.scope = $scope)
             AND ($tier IS NULL OR bp.criticalityTier = $tier)
             AND ($nc IS NULL OR
                  toLower(bp.name) CONTAINS toLower($nc) OR
                  toLower(coalesce(bp.nameHe, "")) CONTAINS toLower($nc))
             AND ($lockedOnly = false OR size(coalesce(bp.lockedFields, [])) > 0)
           RETURN bp.id AS id,
                  bp.name AS name,
                  bp.nameHe AS nameHe,
                  bp.scope AS scope,
                  bp.criticalityTier AS tier,
                  coalesce(bp.lockedFields, []) AS locked,
                  bp.inferenceMethod AS how
           ORDER BY bp.criticalityTier, bp.name
           LIMIT $limit`,
          {
            scope: input.scope ?? null,
            tier: input.tier ?? null,
            nc: input.name_contains ?? null,
            lockedOnly: input.locked_only ?? false,
            limit: neo4j.int(limit),
          },
        );
        const rows = r.records.map((rec) => ({
          id: rec.get("id"),
          name: rec.get("name"),
          nameHe: rec.get("nameHe"),
          scope: rec.get("scope"),
          tier: coerceNumber(rec.get("tier")),
          locked: rec.get("locked"),
          inferenceMethod: rec.get("how"),
        }));
        return asText({ count: rows.length, rows });
      } finally {
        await s.close();
      }
    },
  );

  server.registerTool(
    "sreflow_inspect_bp",
    {
      title: "Inspect a business process",
      description:
        "Return a BP's full state: properties, components grouped by role, host application, and locked fields.",
      inputSchema: { bp: z.string().describe("BP id, English name, or Hebrew name") },
    },
    async ({ bp }) => {
      const driver = deps.driver();
      const node = await readBpByQuery(driver, bp);
      if (!node) return asError(`No BusinessProcess found for '${bp}'`);
      const bpId = node.id as string;
      const [components, hostedIn] = await Promise.all([
        readBpComponents(driver, bpId),
        readHostedIn(driver, bpId),
      ]);
      return asText({
        id: node.id,
        name: node.name,
        nameHe: node.nameHe,
        scope: node.scope,
        criticalityTier: coerceNumber(node.criticalityTier),
        lockedFields: node.lockedFields,
        curatedBy: node.curatedBy,
        inferenceMethod: node.inferenceMethod,
        sourceName: node.sourceName,
        hostedIn,
        componentsByRole: {
          core: components.filter((c) => c.role === "core"),
          upstream: components.filter((c) => c.role === "upstream"),
          downstream: components.filter((c) => c.role === "downstream"),
          unrolled: components.filter((c) => !c.role),
        },
        staleComponents: components.filter((c) => c.status === "stale"),
      });
    },
  );

  server.registerTool(
    "sreflow_render_bp",
    {
      title: "Render a BP diagram",
      description:
        "Produce a Mermaid flowchart for a BP. Pass lang='he' for Hebrew labels with RTL layout.",
      inputSchema: {
        bp: z.string().describe("BP id, English name, or Hebrew name"),
        lang: z.enum(["en", "he"]).optional(),
      },
    },
    async ({ bp, lang }) => {
      const driver = deps.driver();
      const node = await readBpByQuery(driver, bp);
      if (!node) return asError(`No BusinessProcess found for '${bp}'`);
      const bpId = node.id as string;
      const [components, hostedIn] = await Promise.all([
        readBpComponents(driver, bpId),
        readHostedIn(driver, bpId),
      ]);
      const useHe = lang === "he";
      const diagram = renderBp(
        {
          bp: {
            id: bpId,
            name:
              useHe && typeof node.nameHe === "string"
                ? (node.nameHe as string)
                : (node.name as string),
            scope: node.scope as "application" | "feature" | undefined,
            criticalityTier: coerceNumber(node.criticalityTier),
            sourceName: node.sourceName as string | undefined,
          },
          hostedIn: hostedIn
            ? { id: hostedIn.id, name: useHe && hostedIn.nameHe ? hostedIn.nameHe : hostedIn.name }
            : undefined,
          components: components.map((c) => ({
            id: c.id,
            primaryName: c.primaryName,
            role: (c.role ?? undefined) as "core" | "upstream" | "downstream" | undefined,
          })),
        },
        { lang: useHe ? "he" : "en" },
      );
      return asText(diagram);
    },
  );

  // -------- READ: audit / reports --------------------------------------------

  server.registerTool(
    "sreflow_audit_tail",
    {
      title: "Audit log tail",
      description:
        "Return the most recent audit-log entries (agent runs, tool decisions, pause/resume, curation).",
      inputSchema: { n: z.number().int().min(1).max(500).optional() },
    },
    async ({ n }) => {
      const entries = readAuditTail(deps.auditPath, n ?? 50);
      return asText({ count: entries.length, entries });
    },
  );

  server.registerTool(
    "sreflow_report",
    {
      title: "KB change report",
      description:
        "Summarise recent changes to the BP knowledge base. kind=changes|stale|locked|curated.",
      inputSchema: {
        kind: z.enum(["changes", "stale", "locked", "curated"]),
        since: z.string().optional().describe("Lookback window like '24h', '7d'"),
      },
    },
    async ({ kind, since }) => {
      const cutoff = parseSinceWindow(since);
      const s = deps.driver().session();
      try {
        switch (kind) {
          case "changes": {
            const added = await s.run(
              `MATCH (bp:BusinessProcess)-[r:REALIZED_BY]->(c:CanonicalEntity)
               WHERE toString(r.firstSeen) >= $cutoff AND r.status = "active"
               RETURN bp.name AS bp, r.role AS role, c.primaryName AS component,
                      toString(r.firstSeen) AS at
               ORDER BY at DESC LIMIT 100`,
              { cutoff },
            );
            const stale = await s.run(
              `MATCH (bp:BusinessProcess)-[r:REALIZED_BY]->(c:CanonicalEntity)
               WHERE r.status = "stale" AND toString(r.lastSeen) >= $cutoff
               RETURN bp.name AS bp, c.primaryName AS component,
                      toString(r.lastSeen) AS at
               ORDER BY at DESC LIMIT 100`,
              { cutoff },
            );
            return asText({
              since: cutoff,
              added: added.records.map((rec) => ({
                bp: rec.get("bp"),
                role: rec.get("role"),
                component: rec.get("component"),
                at: rec.get("at"),
              })),
              markedStale: stale.records.map((rec) => ({
                bp: rec.get("bp"),
                component: rec.get("component"),
                at: rec.get("at"),
              })),
            });
          }
          case "stale": {
            const r = await s.run(
              `MATCH (bp:BusinessProcess)-[r:REALIZED_BY]->(c:CanonicalEntity)
               WHERE r.status = "stale"
               RETURN bp.name AS bp, c.primaryName AS component, r.role AS role,
                      toString(r.lastSeen) AS lastSeen
               ORDER BY lastSeen DESC LIMIT 200`,
            );
            return asText(
              r.records.map((rec) => ({
                bp: rec.get("bp"),
                component: rec.get("component"),
                role: rec.get("role"),
                lastSeen: rec.get("lastSeen"),
              })),
            );
          }
          case "locked": {
            const r = await s.run(
              `MATCH (bp:BusinessProcess)
               WHERE size(coalesce(bp.lockedFields, [])) > 0
               RETURN bp.id AS id, coalesce(bp.name, "") AS name,
                      bp.lockedFields AS locked, bp.curatedBy AS by,
                      toString(bp.curatedAt) AS at`,
            );
            return asText(
              r.records.map((rec) => ({
                id: rec.get("id"),
                name: rec.get("name"),
                locked: rec.get("locked"),
                curatedBy: rec.get("by"),
                curatedAt: rec.get("at"),
              })),
            );
          }
          case "curated": {
            const r = await s.run(
              `MATCH (bp:BusinessProcess)
               WHERE bp.curatedAt IS NOT NULL AND toString(bp.curatedAt) >= $cutoff
               RETURN bp.id AS id, bp.name AS name, bp.curatedBy AS by,
                      toString(bp.curatedAt) AS at
               ORDER BY at DESC LIMIT 200`,
              { cutoff },
            );
            return asText(
              r.records.map((rec) => ({
                id: rec.get("id"),
                name: rec.get("name"),
                by: rec.get("by"),
                at: rec.get("at"),
              })),
            );
          }
        }
      } finally {
        await s.close();
      }
    },
  );

  // -------- WRITE: agent lifecycle -------------------------------------------

  async function runAgent(
    role: string,
    opts: {
      env?: string;
      targetEnv?: string;
      dryRun?: boolean;
      approvals?: string[];
    },
  ): Promise<ToolResult> {
    try {
      const def = findAgent(role);
      const impl = getImpl(role);
      if (!impl) {
        return asError(
          `'${role}' has a definition but no runnable implementation. Runnable: ${runnableRoles().join(", ")}`,
        );
      }
      const pausedRec = isPaused(deps.pauseStatePath, role);
      if (pausedRec) {
        return asError(
          `'${role}' is paused since ${pausedRec.at}: ${pausedRec.reason}`,
        );
      }
      const agentEnv = opts.env ?? def.environments?.[0] ?? "corp";
      const targetEnv = opts.targetEnv ?? agentEnv;
      const approvals: Approval[] = (opts.approvals ?? []).map((h) => ({
        human: h,
        at: new Date().toISOString(),
      }));
      const sessionId = randomUUID();
      const ctx: AgentContext = {
        role,
        agentEnv,
        targetEnv,
        sessionId,
        approvals,
        dryRun: Boolean(opts.dryRun),
        opaUrl: deps.opaUrl,
        auditPath: deps.auditPath,
        now: new Date().toISOString(),
      };
      writeAudit(deps.auditPath, {
        at: ctx.now,
        kind: "agent_start",
        role,
        sessionId,
        detail: `env=${agentEnv} target=${targetEnv} dryRun=${ctx.dryRun} via=mcp`,
      });
      const out = await impl.run(ctx);
      writeAudit(deps.auditPath, {
        at: new Date().toISOString(),
        kind: "agent_end",
        role,
        sessionId,
        detail: out.summary,
      });
      return asText({
        role,
        sessionId,
        env: agentEnv,
        targetEnv,
        dryRun: ctx.dryRun,
        summary: out.summary,
      });
    } catch (e) {
      if (e instanceof PolicyDenied) {
        return asError(`policy denied tool '${e.tool}': ${e.reason}`);
      }
      return asError(e);
    }
  }

  server.registerTool(
    "sreflow_run_agent",
    {
      title: "Run an agent",
      description:
        "Execute a runnable agent once, OPA-gated. Use dry_run=true to check policy decisions without side effects.",
      inputSchema: {
        role: z.string().describe("e.g. dynatrace-collector, business-process-analyst"),
        env: z.string().optional(),
        target_env: z.string().optional(),
        dry_run: z.boolean().optional(),
        approvals: z
          .array(z.string())
          .optional()
          .describe("Humans approving this run. Their names are recorded on every tool call."),
      },
    },
    async (input) =>
      runAgent(input.role, {
        env: input.env,
        targetEnv: input.target_env,
        dryRun: input.dry_run,
        approvals: input.approvals,
      }),
  );

  server.registerTool(
    "sreflow_run_pipeline",
    {
      title: "Run the Phase-1 discovery pipeline",
      description:
        "Chain dynatrace-collector → entity-resolver → business-process-analyst under one session id.",
      inputSchema: { dry_run: z.boolean().optional() },
    },
    async ({ dry_run }) => {
      const chain: Array<{ role: string; env: string }> = [
        { role: "dynatrace-collector", env: "prod" },
        { role: "entity-resolver", env: "corp" },
        { role: "business-process-analyst", env: "corp" },
      ];
      const results: unknown[] = [];
      for (const step of chain) {
        const r = await runAgent(step.role, {
          env: step.env,
          targetEnv: step.env,
          dryRun: dry_run,
        });
        if (r.isError) {
          return asText({ chain: results, failedAt: step.role, last: r });
        }
        results.push(JSON.parse(r.content[0]!.text));
      }
      return asText({ ok: true, chain: results });
    },
  );

  server.registerTool(
    "sreflow_pause_agent",
    {
      title: "Pause an agent",
      description:
        "Mark an agent paused. The CLI and MCP server will refuse to run it until resumed.",
      inputSchema: {
        role: z.string(),
        reason: z.string().min(3).max(300),
      },
    },
    async ({ role, reason }) => {
      try {
        findAgent(role); // validate
        const rec = pauseRole(deps.pauseStatePath, role, reason, sreflowUser());
        writeAudit(deps.auditPath, {
          at: rec.at,
          kind: "pause",
          role,
          sessionId: "mcp",
          detail: `by=${rec.by} reason=${reason}`,
        });
        return asText({ ok: true, paused: rec });
      } catch (e) {
        return asError(e);
      }
    },
  );

  server.registerTool(
    "sreflow_resume_agent",
    {
      title: "Resume an agent",
      description: "Clear an agent's pause flag.",
      inputSchema: { role: z.string() },
    },
    async ({ role }) => {
      try {
        findAgent(role);
        const cleared = resumeRole(deps.pauseStatePath, role);
        writeAudit(deps.auditPath, {
          at: new Date().toISOString(),
          kind: "resume",
          role,
          sessionId: "mcp",
          detail: cleared ? "cleared" : "was_not_paused",
        });
        return asText({ cleared });
      } catch (e) {
        return asError(e);
      }
    },
  );

  // -------- WRITE: curate BPs ------------------------------------------------

  server.registerTool(
    "sreflow_curate_bp",
    {
      title: "Curate a business process",
      description:
        "Human override: rename, set tier, lock/unlock fields, add or reject components, add a note. Every touched field gets addedBy + evidence attribution. The resulting lock is preserved across analyst re-runs.",
      inputSchema: {
        bp: z.string().describe("BP id or name"),
        name: z.string().optional(),
        name_he: z.string().optional(),
        tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        scope: z.enum(["application", "feature"]).optional(),
        lock: z.array(z.string()).optional().describe("Fields to add to lockedFields"),
        unlock: z.array(z.string()).optional(),
        add_components: z
          .array(
            z.object({
              canonical_id: z.string(),
              role: z.enum(["core", "upstream", "downstream"]).default("downstream"),
            }),
          )
          .optional(),
        remove_components: z.array(z.string()).optional(),
        note: z.string().optional(),
        evidence: z.string().optional(),
        user: z.string().optional(),
      },
    },
    async (input) => {
      const driver = deps.driver();
      const node = await readBpByQuery(driver, input.bp);
      if (!node) return asError(`No BusinessProcess found for '${input.bp}'`);
      const bpId = node.id as string;
      const user = input.user ?? sreflowUser();
      const evidence =
        input.evidence ?? `human:${user} @ ${new Date().toISOString()}`;
      const currentLocked = new Set<string>(
        (node.lockedFields as string[]) ?? [],
      );
      const changes: string[] = [];
      const sets: Record<string, unknown> = {};
      if (input.name) {
        sets.name = input.name;
        changes.push(`name='${input.name}'`);
      }
      if (input.name_he) {
        sets.nameHe = input.name_he;
        changes.push(`nameHe='${input.name_he}'`);
      }
      if (input.tier) {
        sets.criticalityTier = input.tier;
        changes.push(`tier=${input.tier}`);
      }
      if (input.scope) {
        sets.scope = input.scope;
        changes.push(`scope='${input.scope}'`);
      }
      if (input.note) {
        sets.humanNotes = input.note;
        changes.push("note set");
      }
      for (const f of input.lock ?? []) currentLocked.add(f);
      for (const f of input.unlock ?? []) currentLocked.delete(f);
      const s = driver.session();
      try {
        await s.run(
          `MATCH (bp:BusinessProcess { id: $bpId })
           SET bp += $sets,
               bp.lockedFields = $locked,
               bp.curatedAt = datetime(),
               bp.curatedBy = $user,
               bp.updatedAt = datetime()`,
          { bpId, sets, locked: Array.from(currentLocked), user },
        );
        if ((input.lock ?? []).length > 0)
          changes.push(`locked=[${input.lock!.join(",")}]`);
        if ((input.unlock ?? []).length > 0)
          changes.push(`unlocked=[${input.unlock!.join(",")}]`);
        for (const add of input.add_components ?? []) {
          await s.run(
            `MATCH (bp:BusinessProcess { id: $bpId }), (c:CanonicalEntity { id: $cid })
             MERGE (bp)-[r:REALIZED_BY]->(c)
             ON CREATE SET r.firstSeen = datetime()
             SET r.role          = $role,
                 r.status        = "active",
                 r.addedBy       = $by,
                 r.lockedByHuman = true,
                 r.evidence      = $evidence,
                 r.lastSeen      = datetime()`,
            {
              bpId,
              cid: add.canonical_id,
              role: add.role,
              by: `human:${user}`,
              evidence,
            },
          );
          changes.push(`+${add.canonical_id} (${add.role})`);
        }
        for (const cid of input.remove_components ?? []) {
          await s.run(
            `MATCH (:BusinessProcess { id: $bpId })-[r:REALIZED_BY]->(:CanonicalEntity { id: $cid })
             SET r.status        = "rejected",
                 r.lockedByHuman = true,
                 r.rejectedBy    = $user,
                 r.rejectedAt    = datetime(),
                 r.evidence      = $evidence`,
            { bpId, cid, user: `human:${user}`, evidence },
          );
          changes.push(`-${cid} (rejected)`);
        }
      } finally {
        await s.close();
      }
      writeAudit(deps.auditPath, {
        at: new Date().toISOString(),
        kind: "tool_decision",
        role: "curator",
        sessionId: `mcp-${randomUUID()}`,
        tool: "sreflow_curate_bp",
        allow: true,
        detail: `bp=${bpId} user=${user} via=mcp changes=[${changes.join("; ")}]`,
      });
      return asText({
        ok: true,
        bpId,
        changes,
        user,
        evidence,
      });
    },
  );

  // -------- WRITE: LLM rename proposal (preview-only) ------------------------

  server.registerTool(
    "sreflow_propose_rename",
    {
      title: "Propose a better name for a BP (preview — does not apply)",
      description:
        "Call Claude to suggest a business-oriented English + Hebrew rename for one BP. Returns the proposal with rationale. Does NOT modify the graph — use sreflow_curate_bp after reviewing.",
      inputSchema: {
        bp: z.string(),
        model: z.string().optional().describe("e.g. claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5"),
      },
    },
    async ({ bp, model }) => {
      const client = deps.anthropic();
      if (!client)
        return asError(
          "ANTHROPIC_API_KEY not set on the MCP server. Add it to the Claude Desktop config's env block.",
        );
      const driver = deps.driver();
      const node = await readBpByQuery(driver, bp);
      if (!node) return asError(`No BusinessProcess found for '${bp}'`);
      const components = await readBpComponents(driver, node.id as string);
      const hostedIn = await readHostedIn(driver, node.id as string);
      const ctx: BpRenameContext = {
        currentName: node.name as string,
        currentNameHe: (node.nameHe as string | undefined) ?? undefined,
        sourceName: (node.sourceName as string | undefined) ?? undefined,
        scope: node.scope as "application" | "feature" | undefined,
        hostedIn: hostedIn?.name,
        sampleComponents: components.slice(0, 6).map((c) => c.primaryName),
      };
      try {
        const { proposal, usage } = await proposeBetterName(client, ctx, {
          model: model ?? defaultRenameModel(),
        });
        return asText({
          bpId: node.id,
          currentName: node.name,
          currentNameHe: node.nameHe,
          proposal,
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
          },
          applyHint:
            "If you want to apply: sreflow_curate_bp with name, name_he, lock: ['name', 'nameHe'], evidence.",
        });
      } catch (e) {
        return asError(e);
      }
    },
  );

  return server;
}

export type { AgentContext };
