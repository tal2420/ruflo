import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, waitForNeo4j, withSession } from "./neo4j-client.js";
import { allSourceEntities } from "./fixtures.js";
import { ingest } from "./ingest.js";
import { resolveAndLink } from "./resolve-and-link.js";
import { seedBusinessProcess } from "./seed-business-process.js";
import { renderBusinessProcessDiagram } from "./render-diagram.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// runtime/scripts/phase0 → walk up to repo root (4 levels: phase0, scripts, runtime, sre).
const repoRoot = pathResolve(__dirname, "../../../..");

async function applySchema(driver: Parameters<typeof withSession>[0]): Promise<void> {
  const schemaPath = pathResolve(repoRoot, "sre/schema/kg_schema.cypher");
  const raw = readFileSync(schemaPath, "utf8");
  const statements = raw
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("//"));
  await withSession(driver, async (s) => {
    for (const stmt of statements) {
      // Strip any leading block/line comments; leave the SQL-style body.
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

async function graphCounts(driver: Parameters<typeof withSession>[0]) {
  return withSession(driver, async (s) => {
    const r = await s.run(`
      CALL {
        MATCH (n:SourceEntity)     RETURN count(n) AS sourceEntities
      }
      CALL {
        MATCH (n:CanonicalEntity)  RETURN count(n) AS canonicalEntities
      }
      CALL {
        MATCH ()-[r:SAME_AS]->()   RETURN count(r) AS sameAsEdges
      }
      CALL {
        MATCH (n:BusinessProcess)  RETURN count(n) AS businessProcesses
      }
      CALL {
        MATCH ()-[r:REALIZED_BY]->() RETURN count(r) AS realizedByEdges
      }
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

async function main(): Promise<void> {
  console.log("▶ SREFlow Phase-0 pipeline starting");

  const driver = connect();
  try {
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
    console.log("  ✓ derived state reset (SourceEntity preserved, re-upserted next)");

    console.log(`  ingesting ${allSourceEntities.length} source entities …`);
    const ingested = await ingest(driver, allSourceEntities);
    console.log(`  ✓ ingested ${ingested}`);

    console.log("  running entity resolver …");
    const stats = await resolveAndLink(driver, allSourceEntities);
    console.log(
      `  ✓ pairs=${stats.pairsConsidered} auto-linked=${stats.autoLinked} queued=${stats.queued} no-match=${stats.noMatch} canonical=${stats.canonicalCreated}`,
    );

    console.log('  seeding BusinessProcess "Sandbox Checkout" …');
    const linked = await seedBusinessProcess(driver, {
      id: "bp-sandbox-checkout",
      name: "Sandbox Checkout",
      criticalityTier: 3,
      componentTagMatches: [
        { key: "business_service", value: "checkout" },
        { key: "team", value: "payments" },
        { key: "team", value: "orders" },
        { key: "team", value: "checkout" },
      ],
    });
    console.log(`  ✓ linked ${linked} components to the business process`);

    console.log("  rendering Mermaid diagram …");
    const diagram = await renderBusinessProcessDiagram(driver, {
      businessProcessId: "bp-sandbox-checkout",
    });

    const outDir = pathResolve(repoRoot, "sre/docs/generated");
    mkdirSync(outDir, { recursive: true });
    const outFile = pathResolve(outDir, "sandbox-checkout.mmd");
    writeFileSync(outFile, diagram + "\n", "utf8");
    console.log(`  ✓ diagram written to ${outFile}`);

    const counts = await graphCounts(driver);
    console.log("▶ Graph state:");
    console.log(`  ${JSON.stringify(counts)}`);

    console.log("▶ Done. Open Neo4j Browser at http://localhost:7474");
    console.log("  Try:  MATCH (bp:BusinessProcess)-[:REALIZED_BY]->(c) RETURN bp, c");
  } finally {
    await driver.close();
  }
}

main().catch((err) => {
  console.error("phase-0 failed:", err);
  process.exit(1);
});
