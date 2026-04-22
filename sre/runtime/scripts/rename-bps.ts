// Batch LLM rename pass over the BusinessProcess knowledge base.
//
// Finds BPs whose current `name` is shaped like raw code (dots, CamelCase
// runs, mac-prefix, :port suffixes) and sends each to Claude for a clean
// English + Hebrew rename. Every rename is persisted with lockedByHuman-style
// attribution so the analyst cannot revert it on the next run.
//
// Usage:
//   ANTHROPIC_API_KEY=... npm run rename-bps -- [--dry-run] [--limit 20]
//                                               [--model claude-opus-4-7]
//                                               [--scope feature|application]
//
// Prompt caching: the system prompt is ~3K tokens and carries cache_control.
// Expect the first call to report cache_creation_input_tokens and subsequent
// calls to report cache_read_input_tokens (~0.1× of the base cost).

import Anthropic from "@anthropic-ai/sdk";
import neo4j from "neo4j-driver";
import { parseArgs } from "node:util";
import {
  defaultModel,
  needsRename,
  proposeBetterName,
  type BpRenameContext,
  type RenameProposal,
} from "../src/agent-runtime/llm-naming.js";

interface BpRow {
  id: string;
  name: string;
  nameHe: string | null;
  scope: "application" | "feature" | null;
  sourceName: string | null;
  hostedIn: string | null;
  sampleComponents: string[];
  locked: string[];
}

async function readBpsNeedingRename(
  driver: ReturnType<typeof neo4j.driver>,
  opts: { limit: number; scope?: "application" | "feature" },
): Promise<BpRow[]> {
  const s = driver.session();
  try {
    const r = await s.run(
      `MATCH (bp:BusinessProcess)
       WHERE $scope IS NULL OR bp.scope = $scope
       OPTIONAL MATCH (bp)-[:HOSTED_IN]->(app:BusinessProcess)
       OPTIONAL MATCH (bp)-[r:REALIZED_BY]->(c:CanonicalEntity)
       WITH bp, app,
            collect(DISTINCT c.primaryName)[..6] AS sampleComponents,
            coalesce(bp.lockedFields, []) AS locked
       RETURN bp.id         AS id,
              bp.name       AS name,
              bp.nameHe     AS nameHe,
              bp.scope      AS scope,
              bp.sourceName AS sourceName,
              app.name      AS hostedIn,
              sampleComponents,
              locked`,
      { scope: opts.scope ?? null },
    );
    const rows: BpRow[] = [];
    for (const rec of r.records) {
      rows.push({
        id: rec.get("id") as string,
        name: rec.get("name") as string,
        nameHe: (rec.get("nameHe") as string | null) ?? null,
        scope: (rec.get("scope") as "application" | "feature" | null) ?? null,
        sourceName: (rec.get("sourceName") as string | null) ?? null,
        hostedIn: (rec.get("hostedIn") as string | null) ?? null,
        sampleComponents: ((rec.get("sampleComponents") as (string | null)[]) ?? [])
          .filter((x): x is string => !!x),
        locked: (rec.get("locked") as string[]) ?? [],
      });
    }
    // Filter: needs rename AND name/nameHe aren't already human-locked
    return rows
      .filter((row) => needsRename(row.name))
      .filter((row) => !row.locked.includes("name") && !row.locked.includes("nameHe"))
      .slice(0, opts.limit);
  } finally {
    await s.close();
  }
}

async function writeRename(
  driver: ReturnType<typeof neo4j.driver>,
  bpId: string,
  proposal: RenameProposal,
  user: string,
  evidence: string,
): Promise<void> {
  const s = driver.session();
  try {
    await s.run(
      `MATCH (bp:BusinessProcess { id: $id })
       SET bp.name                  = $name,
           bp.nameHe                = $nameHe,
           bp.renameRationale       = $rationale,
           bp.lockedFields          = coalesce(bp.lockedFields, []) +
                                      [f IN ["name", "nameHe"] WHERE NOT f IN coalesce(bp.lockedFields, [])],
           bp.curatedBy             = $user,
           bp.curatedAt             = datetime(),
           bp.renamedByLLMAt        = datetime(),
           bp.renameEvidence        = $evidence,
           bp.updatedAt             = datetime()`,
      {
        id: bpId,
        name: proposal.name,
        nameHe: proposal.nameHe,
        rationale: proposal.rationale,
        user,
        evidence,
      },
    );
  } finally {
    await s.close();
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string", default: "1000" },
      model: { type: "string" },
      scope: { type: "string" }, // application | feature
      user: { type: "string", default: "llm-renamer" },
    },
    strict: true,
  });

  if (!process.env.ANTHROPIC_API_KEY && !values["dry-run"]) {
    console.error(
      "✗ ANTHROPIC_API_KEY not set. Export it before running, or use --dry-run to see what would change.",
    );
    process.exit(2);
  }

  const model = values.model ?? defaultModel();
  const dryRun = Boolean(values["dry-run"]);
  const limit = Number(values.limit);
  const scope = values.scope as "application" | "feature" | undefined;

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  const driver = neo4j.driver(
    process.env.NEO4J_URI ?? "bolt://localhost:7687",
    neo4j.auth.basic(
      process.env.NEO4J_USER ?? "neo4j",
      process.env.NEO4J_PASSWORD ?? "phase0-password-change-me",
    ),
  );

  try {
    console.log("▶ Querying Neo4j for BPs needing rename …");
    const rows = await readBpsNeedingRename(driver, { limit, scope });
    console.log(`  ${rows.length} candidates found (dry-run=${dryRun}, model=${model})`);
    console.log("");

    const header = `${"id".padEnd(44)}  ${"current".padEnd(38)}  →  ${"proposed (en)".padEnd(28)}  ${"nameHe"}`;
    console.log(header);
    console.log("-".repeat(header.length));

    let cacheHits = 0;
    let cacheWrites = 0;
    let applied = 0;
    let errors = 0;
    const evidenceTag = `llm:${model}@${new Date().toISOString()}`;

    for (const row of rows) {
      const ctx: BpRenameContext = {
        currentName: row.name,
        currentNameHe: row.nameHe ?? undefined,
        sourceName: row.sourceName ?? undefined,
        scope: row.scope ?? undefined,
        hostedIn: row.hostedIn ?? undefined,
        sampleComponents: row.sampleComponents,
      };

      if (dryRun) {
        console.log(
          `${row.id.padEnd(44)}  ${truncate(row.name, 38).padEnd(38)}  →  (dry-run — no LLM call)`,
        );
        continue;
      }

      try {
        const { proposal, usage } = await proposeBetterName(client, ctx, { model });
        cacheHits += usage.cache_read_input_tokens ?? 0;
        cacheWrites += usage.cache_creation_input_tokens ?? 0;

        await writeRename(driver, row.id, proposal, values.user as string, evidenceTag);
        applied += 1;
        console.log(
          `${row.id.padEnd(44)}  ${truncate(row.name, 38).padEnd(38)}  →  ${truncate(proposal.name, 28).padEnd(28)}  ${proposal.nameHe}`,
        );
      } catch (e) {
        errors += 1;
        console.error(`  ✗ ${row.id}: ${(e as Error).message}`);
      }
    }

    console.log("");
    console.log(
      `▶ Done. applied=${applied} errors=${errors} cache_reads=${cacheHits} cache_writes=${cacheWrites}`,
    );
    if (!dryRun) {
      console.log(`  evidence tag written on every rename: ${evidenceTag}`);
      console.log(`  (name + nameHe are now locked on each renamed BP)`);
    }
  } finally {
    await driver.close();
  }
}

main().catch((err) => {
  console.error("rename-bps failed:", err);
  process.exit(1);
});
