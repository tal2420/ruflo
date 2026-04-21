import type { Driver } from "neo4j-driver";
import { withSession } from "./neo4j-client.js";

interface SeedOpts {
  id: string;
  name: string;
  criticalityTier: 1 | 2 | 3;
  /** Tag key/value pairs that identify components of this business process. */
  componentTagMatches: Array<{ key: string; value: string }>;
}

/**
 * Create one BusinessProcess node and attach REALIZED_BY edges to every
 * CanonicalEntity whose underlying source entities match ANY of the
 * componentTagMatches. This is the Phase-0 stand-in for the full
 * business-process-analyst agent's component-binding algorithm.
 */
export async function seedBusinessProcess(
  driver: Driver,
  opts: SeedOpts,
): Promise<number> {
  return withSession(driver, async (s) => {
    await s.run(
      `
      MERGE (b:BusinessProcess { id: $id })
      SET b.name = $name,
          b.criticalityTier = $tier,
          b.updatedAt = datetime()
      `,
      { id: opts.id, name: opts.name, tier: opts.criticalityTier },
    );

    let linked = 0;
    for (const match of opts.componentTagMatches) {
      const tagAtom = `${match.key}=${match.value}`;
      const result = await s.run(
        `
        MATCH (b:BusinessProcess { id: $id })
        MATCH (src:SourceEntity)-[:SAME_AS]->(c:CanonicalEntity)
        WHERE $tagAtom IN src.tags_flat
        MERGE (b)-[:REALIZED_BY]->(c)
        RETURN count(DISTINCT c) AS linked
        `,
        { id: opts.id, tagAtom },
      );
      linked += result.records[0]?.get("linked")?.toNumber?.() ?? 0;
    }
    return linked;
  });
}
