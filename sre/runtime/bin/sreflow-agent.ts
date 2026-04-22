#!/usr/bin/env tsx
// sreflow-agent — CLI for listing, inspecting, running, pausing, and auditing SRE agents.
//
//   sreflow agent list
//   sreflow agent inspect <role>
//   sreflow agent run <role> [--env prod] [--target-env prod] [--dry-run] [--approvals alice,bob]
//   sreflow agent pause <role> --reason "..."
//   sreflow agent resume <role>
//   sreflow agent status
//   sreflow agent audit [--tail 20]
//
// Every tool call the running agent makes is gated by OPA at OPA_URL and
// recorded to $SREFLOW_AUDIT_PATH (default: sre/runtime/.state/audit.jsonl).

import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve as pathResolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import neo4j from "neo4j-driver";
import {
  findAgent,
  getImpl,
  isPaused,
  listAgents,
  listPaused,
  pause,
  PolicyDenied,
  readAuditTail,
  renderBp,
  resume,
  runnableRoles,
  writeAudit,
  type AgentContext,
  type Approval,
  type RenderComponent,
} from "../src/agent-runtime/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// runtime/bin → up 3 to repo root (bin, runtime, sre).
const repoRoot = pathResolve(__dirname, "../../..");

function resolvePaths(): { auditPath: string; pauseStatePath: string } {
  const state = pathResolve(repoRoot, "sre/runtime/.state");
  return {
    auditPath: process.env.SREFLOW_AUDIT_PATH ?? pathResolve(state, "audit.jsonl"),
    pauseStatePath: process.env.SREFLOW_PAUSE_STATE ?? pathResolve(state, "paused-agents.json"),
  };
}

function parseApprovals(raw: string | undefined): Approval[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((human) => ({ human, at: new Date().toISOString() }));
}

function agentDefaultEnv(envList: string[] | undefined): string {
  if (envList && envList.length > 0) return envList[0]!;
  return "corp";
}

const program = new Command();
program
  .name("sreflow-agent")
  .description("Control plane CLI for SREFlow agents")
  .version("0.1.0");

program
  .command("list")
  .description("List every agent defined under sre/agents/")
  .action(() => {
    const agents = listAgents();
    if (agents.length === 0) {
      console.log("(no agents found)");
      return;
    }
    const runnable = new Set(runnableRoles());
    const paths = resolvePaths();
    const paused = new Set(listPaused(paths.pauseStatePath).map((p) => p.role));
    for (const a of agents) {
      const runFlag = runnable.has(a.type) ? "▶" : " ";
      const pauseFlag = paused.has(a.type) ? "⏸" : " ";
      const source = a.sourcePath ? relative(repoRoot, a.sourcePath) : "?";
      const br = a.blast_radius ?? "?";
      console.log(
        `${runFlag}${pauseFlag}  ${a.type.padEnd(30)} ${br.padEnd(12)} ${(a.layer ?? "?").padEnd(14)} ${source}`,
      );
    }
    console.log("");
    console.log("Legend:  ▶ = runnable by this CLI   ⏸ = paused");
  });

program
  .command("inspect <role>")
  .description("Show an agent's capabilities, allowlist, envs, and pause state")
  .action((role: string) => {
    const def = findAgent(role);
    const paths = resolvePaths();
    const pauseRec = isPaused(paths.pauseStatePath, role);
    const runnable = runnableRoles().includes(role);

    console.log(`role:            ${def.type}`);
    console.log(`source:          ${def.sourcePath ? relative(repoRoot, def.sourcePath) : "?"}`);
    console.log(`layer:           ${def.layer ?? "?"}`);
    console.log(`blast_radius:    ${def.blast_radius ?? "?"}`);
    console.log(`envs:            ${(def.environments ?? []).join(", ") || "—"}`);
    console.log(`capabilities:    ${(def.capabilities ?? []).join(", ") || "—"}`);
    console.log(`runnable by CLI: ${runnable ? "yes" : "no (definition only)"}`);
    if (pauseRec) {
      console.log(`paused:          YES — at ${pauseRec.at} by ${pauseRec.by}: ${pauseRec.reason}`);
    }
    console.log(`allowed tools (${def.tools.allowed.length}):`);
    for (const t of def.tools.allowed) console.log(`  + ${t}`);
    if (def.tools.denied && def.tools.denied.length > 0) {
      console.log(`denied patterns (${def.tools.denied.length}):`);
      for (const t of def.tools.denied) console.log(`  - ${t}`);
    }
  });

program
  .command("run <role>")
  .description("Execute a runnable agent once, gated by OPA")
  .option("-e, --env <env>", "Agent env (overrides the YAML's first entry)")
  .option("--target-env <env>", "Target env for tool calls (defaults to agent env)")
  .option("--dry-run", "Check policy for each tool call but skip execution", false)
  .option(
    "--approvals <list>",
    "Comma-separated human approvals for this run (e.g. 'alice,bob')",
  )
  .option("--opa-url <url>", "OPA server URL", process.env.OPA_URL ?? "http://localhost:8181")
  .action(async (role: string, opts) => {
    const def = findAgent(role);
    const impl = getImpl(role);
    if (!impl) {
      console.error(`'${role}' has a definition but no runnable implementation in this CLI.`);
      console.error(`Runnable roles: ${runnableRoles().join(", ")}`);
      process.exit(2);
    }

    const paths = resolvePaths();
    const pauseRec = isPaused(paths.pauseStatePath, role);
    if (pauseRec) {
      console.error(`✗ '${role}' is paused (since ${pauseRec.at}): ${pauseRec.reason}`);
      process.exit(3);
    }

    const agentEnv: string = opts.env ?? agentDefaultEnv(def.environments);
    const targetEnv: string = opts.targetEnv ?? agentEnv;
    const sessionId = randomUUID();
    const ctx: AgentContext = {
      role,
      agentEnv,
      targetEnv,
      sessionId,
      approvals: parseApprovals(opts.approvals),
      dryRun: Boolean(opts.dryRun),
      opaUrl: opts.opaUrl,
      auditPath: paths.auditPath,
      now: new Date().toISOString(),
    };

    writeAudit(paths.auditPath, {
      at: ctx.now,
      kind: "agent_start",
      role,
      sessionId,
      detail: `env=${agentEnv} target=${targetEnv} dryRun=${ctx.dryRun}`,
    });

    console.log(`▶ Running '${role}' (session ${sessionId})`);
    console.log(`  env=${agentEnv} target=${targetEnv} dry-run=${ctx.dryRun} opa=${ctx.opaUrl}`);

    try {
      const out = await impl.run(ctx);
      writeAudit(paths.auditPath, {
        at: new Date().toISOString(),
        kind: "agent_end",
        role,
        sessionId,
        detail: out.summary,
      });
      console.log(`✓ ${out.summary}`);
      console.log(`  audit: ${paths.auditPath}`);
    } catch (e) {
      if (e instanceof PolicyDenied) {
        console.error(`✗ policy denied: ${e.tool} → ${e.reason}`);
      } else {
        console.error("✗ agent failed:", (e as Error).message);
      }
      writeAudit(paths.auditPath, {
        at: new Date().toISOString(),
        kind: "agent_end",
        role,
        sessionId,
        error: (e as Error).message,
      });
      process.exit(4);
    }
  });

program
  .command("run-pipeline")
  .description(
    "Run the Phase-1 discovery pipeline: dynatrace-collector → entity-resolver → business-process-analyst. Chains under one session id; stops at the first failure.",
  )
  .option("-e, --env <env>", "Agent env for the collector (defaults to the YAML's first entry)")
  .option("--target-env <env>", "Target env for tool calls")
  .option("--dry-run", "Check policy for each tool call but skip execution", false)
  .option("--approvals <list>", "Comma-separated humans approving this run")
  .option("--opa-url <url>", "OPA server URL", process.env.OPA_URL ?? "http://localhost:8181")
  .action(async (opts) => {
    const chain: Array<{ role: string; env?: string }> = [
      { role: "dynatrace-collector" },
      { role: "entity-resolver", env: "corp" },
      { role: "business-process-analyst", env: "corp" },
    ];
    const paths = resolvePaths();
    const sessionId = randomUUID();
    const approvals = parseApprovals(opts.approvals);

    writeAudit(paths.auditPath, {
      at: new Date().toISOString(),
      kind: "agent_start",
      role: "pipeline",
      sessionId,
      detail: `pipeline roles=${chain.map((c) => c.role).join(" → ")} dryRun=${Boolean(opts.dryRun)}`,
    });
    console.log(`▶ Pipeline session ${sessionId}`);
    console.log(`  chain: ${chain.map((c) => c.role).join(" → ")}`);
    console.log(`  opa=${opts.opaUrl} dry-run=${Boolean(opts.dryRun)}`);

    for (const step of chain) {
      const def = findAgent(step.role);
      const impl = getImpl(step.role);
      if (!impl) {
        console.error(`✗ step ${step.role} has no runnable implementation`);
        process.exit(2);
      }
      const pauseRec = isPaused(paths.pauseStatePath, step.role);
      if (pauseRec) {
        console.error(`✗ step ${step.role} is paused: ${pauseRec.reason}`);
        process.exit(3);
      }
      const agentEnv: string = step.env ?? opts.env ?? agentDefaultEnv(def.environments);
      const targetEnv: string = opts.targetEnv ?? agentEnv;
      const ctx: AgentContext = {
        role: step.role,
        agentEnv,
        targetEnv,
        sessionId,
        approvals,
        dryRun: Boolean(opts.dryRun),
        opaUrl: opts.opaUrl,
        auditPath: paths.auditPath,
        now: new Date().toISOString(),
      };
      console.log(`\n▶ ${step.role}  (env=${agentEnv} target=${targetEnv})`);
      try {
        const out = await impl.run(ctx);
        console.log(`  ✓ ${out.summary}`);
        writeAudit(paths.auditPath, {
          at: new Date().toISOString(),
          kind: "agent_end",
          role: step.role,
          sessionId,
          detail: out.summary,
        });
      } catch (e) {
        if (e instanceof PolicyDenied) {
          console.error(`✗ ${step.role}: policy denied tool '${e.tool}' → ${e.reason}`);
        } else {
          console.error(`✗ ${step.role}:`, (e as Error).message);
        }
        writeAudit(paths.auditPath, {
          at: new Date().toISOString(),
          kind: "agent_end",
          role: step.role,
          sessionId,
          error: (e as Error).message,
        });
        process.exit(4);
      }
    }
    console.log(`\n✓ pipeline complete (session ${sessionId})`);
  });

program
  .command("render <bp>")
  .description(
    "Render a Mermaid diagram for a BusinessProcess by id or name. Hebrew output via --he (RTL layout).",
  )
  .option("--he", "Output Hebrew labels with right-to-left layout", false)
  .option("--out <path>", "Write to a file instead of stdout")
  .action(async (bpQuery: string, opts) => {
    const driver = neo4j.driver(
      process.env.NEO4J_URI ?? "bolt://localhost:7687",
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? "neo4j",
        process.env.NEO4J_PASSWORD ?? "phase0-password-change-me",
      ),
    );
    const session = driver.session();
    try {
      const bpR = await session.run(
        `MATCH (bp:BusinessProcess)
         WHERE bp.id = $q OR bp.name = $q OR bp.nameHe = $q
         RETURN bp LIMIT 1`,
        { q: bpQuery },
      );
      if (bpR.records.length === 0) {
        console.error(`No BusinessProcess found for '${bpQuery}'`);
        process.exit(2);
      }
      const bpNode = bpR.records[0]!.get("bp").properties as {
        id: string;
        name: string;
        nameHe?: string;
        scope?: "application" | "feature";
        criticalityTier?: { toNumber: () => number } | number;
        sourceName?: string;
      };
      const tier =
        typeof bpNode.criticalityTier === "number"
          ? bpNode.criticalityTier
          : typeof bpNode.criticalityTier?.toNumber === "function"
            ? bpNode.criticalityTier.toNumber()
            : undefined;

      const hostR = await session.run(
        `MATCH (:BusinessProcess { id: $id })-[:HOSTED_IN]->(app:BusinessProcess)
         RETURN app LIMIT 1`,
        { id: bpNode.id },
      );
      const hostedIn =
        hostR.records.length > 0
          ? {
              id: hostR.records[0]!.get("app").properties.id as string,
              name: (opts.he
                ? (hostR.records[0]!.get("app").properties.nameHe as string | undefined) ??
                  (hostR.records[0]!.get("app").properties.name as string)
                : (hostR.records[0]!.get("app").properties.name as string)),
            }
          : undefined;

      const cmpR = await session.run(
        `MATCH (:BusinessProcess { id: $id })-[r:REALIZED_BY]->(c:CanonicalEntity)
         RETURN c.id AS id, coalesce(c.primaryName, c.id) AS primaryName, r.role AS role`,
        { id: bpNode.id },
      );
      const components: RenderComponent[] = cmpR.records.map((rec) => {
        const raw = rec.get("role");
        const role = raw === "core" || raw === "upstream" || raw === "downstream" ? raw : undefined;
        return {
          id: rec.get("id") as string,
          primaryName: rec.get("primaryName") as string,
          role,
        };
      });

      const diagram = renderBp(
        {
          bp: {
            id: bpNode.id,
            name: opts.he && bpNode.nameHe ? bpNode.nameHe : bpNode.name,
            scope: bpNode.scope,
            criticalityTier: tier,
            sourceName: bpNode.sourceName,
          },
          hostedIn,
          components,
        },
        { lang: opts.he ? "he" : "en" },
      );

      if (opts.out) {
        const out = pathResolve(process.cwd(), opts.out);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, diagram + "\n", "utf8");
        console.error(`✓ diagram written to ${out}`);
      } else {
        process.stdout.write(diagram + "\n");
      }
    } finally {
      await session.close();
      await driver.close();
    }
  });

program
  .command("pause <role>")
  .description("Mark an agent as paused; CLI will refuse to run it")
  .requiredOption("--reason <reason>", "Why the agent is paused")
  .action((role: string, opts) => {
    findAgent(role); // validate role exists
    const paths = resolvePaths();
    const rec = pause(paths.pauseStatePath, role, opts.reason);
    writeAudit(paths.auditPath, {
      at: rec.at,
      kind: "pause",
      role,
      sessionId: "cli",
      detail: `by=${rec.by} reason=${opts.reason}`,
    });
    console.log(`⏸ paused '${role}' — ${opts.reason}`);
  });

program
  .command("resume <role>")
  .description("Clear an agent's pause flag")
  .action((role: string) => {
    findAgent(role);
    const paths = resolvePaths();
    const cleared = resume(paths.pauseStatePath, role);
    writeAudit(paths.auditPath, {
      at: new Date().toISOString(),
      kind: "resume",
      role,
      sessionId: "cli",
      detail: cleared ? "cleared" : "was_not_paused",
    });
    console.log(cleared ? `▶ resumed '${role}'` : `'${role}' was not paused`);
  });

program
  .command("status")
  .description("Show paused agents + recent audit summary")
  .option("--tail <n>", "How many audit lines to summarise", "10")
  .action((opts) => {
    const paths = resolvePaths();
    const paused = listPaused(paths.pauseStatePath);
    if (paused.length === 0) {
      console.log("No agents paused.");
    } else {
      console.log(`Paused agents (${paused.length}):`);
      for (const p of paused) console.log(`  ⏸ ${p.role} — ${p.reason} (since ${p.at})`);
    }
    const tail = readAuditTail(paths.auditPath, Number(opts.tail));
    console.log(`\nRecent audit (last ${tail.length}):`);
    for (const e of tail) {
      const verdict = e.kind === "tool_decision" ? (e.allow ? "ALLOW" : `DENY ${e.deny_reason ?? ""}`) : e.kind.toUpperCase();
      console.log(`  ${e.at}  ${e.role.padEnd(24)} ${verdict.padEnd(28)} ${e.tool ?? e.detail ?? ""}`);
    }
  });

program
  .command("audit")
  .description("Dump recent audit entries as JSON lines")
  .option("--tail <n>", "How many entries", "50")
  .action((opts) => {
    const paths = resolvePaths();
    for (const e of readAuditTail(paths.auditPath, Number(opts.tail))) {
      console.log(JSON.stringify(e));
    }
  });

await program.parseAsync(process.argv);
