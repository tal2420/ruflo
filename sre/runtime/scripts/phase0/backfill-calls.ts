// Backfills service→service CALLS edges for a selector-scoped cluster.
//
// Fetches Dynatrace entities + fromRelationships.calls for the configured
// selector, then MERGEs CanonicalEntity-[:CALLS]->CanonicalEntity edges for
// every (caller, callee) pair where BOTH endpoints already have a canonical
// node in the local KG. External callees are skipped (not lazily created).
//
// Usage:
//   export DT_TENANT_URL=...
//   export DT_API_TOKEN=...
//   export DT_CLUSTER_SELECTOR='type(SERVICE),tag("APPLICATION:Maccabi_Online")'
//   npx tsx scripts/phase0/backfill-calls.ts

import neo4j from "neo4j-driver";
import { fetchServiceCalls } from "./adapters/dynatrace.js";

async function main(): Promise<void> {
  const tenantUrl = process.env.DT_TENANT_URL;
  const apiToken = process.env.DT_API_TOKEN;
  if (!tenantUrl || !apiToken) {
    console.error("DT_TENANT_URL and DT_API_TOKEN must be set");
    process.exit(2);
  }
  const selector = process.env.DT_CLUSTER_SELECTOR ?? 'type(SERVICE),tag("APPLICATION:Maccabi_Online")';

  console.log(`▶ Fetching call relationships for selector: ${selector}`);
  const edges = await fetchServiceCalls({
    tenantUrl,
    apiToken,
    entitySelector: selector,
  });
  console.log(`  ✓ received ${edges.length} raw call edges from Dynatrace`);

  if (edges.length === 0) {
    console.log("  (no edges — nothing to backfill)");
    return;
  }

  const driver = neo4j.driver(
    process.env.NEO4J_URI ?? "bolt://localhost:7687",
    neo4j.auth.basic(
      process.env.NEO4J_USER ?? "neo4j",
      process.env.NEO4J_PASSWORD ?? "phase0-password-change-me",
    ),
  );

  let internalCreated = 0;
  let skippedExternal = 0;
  const session = driver.session();
  try {
    for (const { fromId, toId } of edges) {
      const r = await session.run(
        `
        OPTIONAL MATCH
          (fromS:SourceEntity { source: "dynatrace", sourceId: $from })-[:SAME_AS]->(fromC:CanonicalEntity),
          (toS:SourceEntity   { source: "dynatrace", sourceId: $to   })-[:SAME_AS]->(toC:CanonicalEntity)
        WITH fromC, toC
        WHERE fromC IS NOT NULL AND toC IS NOT NULL
        MERGE (fromC)-[:CALLS]->(toC)
        RETURN count(*) AS created
        `,
        { from: fromId, to: toId },
      );
      const created = r.records[0]?.get("created")?.toNumber?.() ?? 0;
      if (created > 0) internalCreated += 1;
      else skippedExternal += 1;
    }
  } finally {
    await session.close();
    await driver.close();
  }

  console.log(`  ✓ materialized ${internalCreated} cluster-internal CALLS edges`);
  console.log(`  ✓ skipped ${skippedExternal} edges whose target is outside the cluster`);
}

main().catch((err) => {
  console.error("backfill-calls failed:", (err as Error).message);
  process.exit(1);
});
