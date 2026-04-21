import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Driver } from "neo4j-driver";
import type { SourceEntity } from "../../src/entity-resolver/types.js";
import { withSession, waitForNeo4j } from "./neo4j-client.js";
import { ingest } from "./ingest.js";
import { resolveAndLink } from "./resolve-and-link.js";
import { seedBusinessProcess } from "./seed-business-process.js";
import { renderBusinessProcessDiagram } from "./render-diagram.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = pathResolve(__dirname, "../../../..");

export interface PipelineOptions {
  /** BusinessProcess to seed + render a diagram for. */
  businessProcess: {
    id: string;
    name: string;
    criticalityTier: 1 | 2 | 3;
    componentTagMatches: Array<{ key: string; value: string }>;
  };
  /** Where to write the rendered Mermaid diagram. */
  outPath?: string;
}

async function applySchema(driver: Driver): Promise<void> {
  const schemaPath = pathResolve(repoRoot, "sre/schema/kg_schema.cypher");
  const raw = readFileSync(schemaPath, "utf8");
  const statements = raw
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("//"));
  await withSession(driver, async (s) => {
    for (const stmt of statements) {
      const body = stmt
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n")
        .trim();
      if (!body) continue;
      await s.run(body);
    }
  });
}

async function graphCounts(driver: Driver) {
  return withSession(driver, async (s) => {
    const r = await s.run(`
      CALL { MATCH (n:SourceEntity)      RETURN count(n) AS sourceEntities }
      CALL { MATCH (n:CanonicalEntity)   RETURN count(n) AS canonicalEntities }
      CALL { MATCH ()-[r:SAME_AS]->()    RETURN count(r) AS sameAsEdges }
      CALL { MATCH (n:BusinessProcess)   RETURN count(n) AS businessProcesses }
      CALL { MATCH ()-[r:REALIZED_BY]->() RETURN count(r) AS realizedByEdges }
      RETURN sourceEntities, canonicalEntities, sameAsEdges, businessProcesses, realizedByEdges
    `);
    const row = r.records[0]!;
    return {
      sourceEntities: row.get("sourceEntities").toNumber(),
      canonicalEntities: row.get("canonicalEntities").toNumber(),
      sameAsEdges: row.get("sameAsEdges").toNumber(),
      businessProcesses: row.get("businessProcesses").toNumber(),
      realizedByEdges: row.get("realizedByEdges").toNumber(),
    };
  });
}

export async function runPhase0(
  driver: Driver,
  sources: SourceEntity[],
  opts: PipelineOptions,
): Promise<void> {
  console.log("▶ SREFlow Phase-0 pipeline starting");
  console.log("  waiting for Neo4j …");
  await waitForNeo4j(driver);
  console.log("  ✓ Neo4j reachable");

  console.log("  applying KG schema …");
  await applySchema(driver);
  console.log("  ✓ schema applied");

  console.log("  wiping derived state (CanonicalEntity + BusinessProcess) …");
  await withSession(driver, async (s) => {
    await s.run(`MATCH (c:CanonicalEntity) DETACH DELETE c`);
    await s.run(`MATCH (bp:BusinessProcess) DETACH DELETE bp`);
  });
  console.log("  ✓ derived state reset");

  console.log(`  ingesting ${sources.length} source entities …`);
  const ingested = await ingest(driver, sources);
  console.log(`  ✓ ingested ${ingested}`);

  console.log("  running entity resolver …");
  const stats = await resolveAndLink(driver, sources);
  console.log(
    `  ✓ pairs=${stats.pairsConsidered} auto-linked=${stats.autoLinked} queued=${stats.queued} no-match=${stats.noMatch} canonical=${stats.canonicalCreated}`,
  );

  console.log(`  seeding BusinessProcess "${opts.businessProcess.name}" …`);
  const linked = await seedBusinessProcess(driver, opts.businessProcess);
  console.log(`  ✓ linked ${linked} components to the business process`);

  console.log("  rendering Mermaid diagram …");
  const diagram = await renderBusinessProcessDiagram(driver, {
    businessProcessId: opts.businessProcess.id,
  });
  const outPath = opts.outPath ?? pathResolve(repoRoot, "sre/docs/generated/sandbox-checkout.mmd");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, diagram + "\n", "utf8");
  console.log(`  ✓ diagram written to ${outPath}`);

  const counts = await graphCounts(driver);
  console.log("▶ Graph state:");
  console.log(`  ${JSON.stringify(counts)}`);
  console.log("▶ Done. Open Neo4j Browser at http://localhost:7474");
  console.log("  Try:  MATCH (bp:BusinessProcess)-[:REALIZED_BY]->(c) RETURN bp, c");
}

export const DEFAULT_BUSINESS_PROCESS: PipelineOptions["businessProcess"] = {
  id: "bp-sandbox-checkout",
  name: "Sandbox Checkout",
  criticalityTier: 3,
  componentTagMatches: [
    { key: "business_service", value: "checkout" },
    { key: "team", value: "payments" },
    { key: "team", value: "orders" },
    { key: "team", value: "checkout" },
  ],
};
