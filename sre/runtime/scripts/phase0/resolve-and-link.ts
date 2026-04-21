import type { Driver } from "neo4j-driver";
import { randomUUID } from "node:crypto";
import type { SourceEntity } from "../../src/entity-resolver/types.js";
import { resolve } from "../../src/entity-resolver/index.js";
import { withSession } from "./neo4j-client.js";

interface LinkStats {
  pairsConsidered: number;
  autoLinked: number;
  queued: number;
  noMatch: number;
  canonicalCreated: number;
}

/**
 * Run the entity resolver pairwise over the ingested source entities and
 * materialize CanonicalEntity + SAME_AS edges in Neo4j.
 *
 * Simple approach: group by canonicalType, then O(n²) over each group.
 * Fine for Phase-0 sample sizes; for real scale, the collector emits a
 * "candidates" set scoped by deterministic pre-filters first.
 */
export async function resolveAndLink(
  driver: Driver,
  entities: SourceEntity[],
): Promise<LinkStats> {
  const stats: LinkStats = {
    pairsConsidered: 0,
    autoLinked: 0,
    queued: 0,
    noMatch: 0,
    canonicalCreated: 0,
  };

  const byType = new Map<string, SourceEntity[]>();
  for (const e of entities) {
    const arr = byType.get(e.canonicalType) ?? [];
    arr.push(e);
    byType.set(e.canonicalType, arr);
  }

  // Union-Find over same-type entities.
  const key = (e: SourceEntity) => `${e.source}:${e.sourceId}`;
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k);
    if (!p || p === k) return k;
    const root = find(p);
    parent.set(k, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of entities) parent.set(key(e), key(e));

  // Pairwise resolve within each canonical type.
  for (const [, group] of byType) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        stats.pairsConsidered += 1;
        const r = resolve(a, b);
        if (r.decision === "link") {
          union(key(a), key(b));
          stats.autoLinked += 1;
        } else if (r.decision === "queue") {
          stats.queued += 1;
        } else {
          stats.noMatch += 1;
        }
      }
    }
  }

  // Group by root → one CanonicalEntity per cluster.
  const clusters = new Map<string, SourceEntity[]>();
  for (const e of entities) {
    const root = find(key(e));
    const arr = clusters.get(root) ?? [];
    arr.push(e);
    clusters.set(root, arr);
  }

  await withSession(driver, async (s) => {
    for (const [, members] of clusters) {
      const canonicalId = `canonical-${randomUUID()}`;
      const canonicalType = members[0]!.canonicalType;
      const canonicalName = members[0]!.names[0] ?? canonicalType;
      const sources = Array.from(new Set(members.map((m) => m.source)));

      await s.run(
        `
        MERGE (c:CanonicalEntity { id: $id })
        SET c.canonicalType = $canonicalType,
            c.primaryName   = $name,
            c.sources       = $sources,
            c.updatedAt     = datetime()
        `,
        { id: canonicalId, canonicalType, name: canonicalName, sources },
      );
      stats.canonicalCreated += 1;

      for (const m of members) {
        await s.run(
          `
          MATCH (s:SourceEntity { source: $source, sourceId: $sourceId }),
                (c:CanonicalEntity { id: $canonicalId })
          MERGE (s)-[:SAME_AS { method: $method }]->(c)
          `,
          {
            source: m.source,
            sourceId: m.sourceId,
            canonicalId,
            method: members.length > 1 ? "resolver" : "singleton",
          },
        );
      }
    }
  });

  return stats;
}
