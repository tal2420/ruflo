import type { Driver } from "neo4j-driver";
import type { SourceEntity } from "../../src/entity-resolver/types.js";
import { withSession } from "./neo4j-client.js";

/**
 * Upsert a batch of SourceEntity nodes. Each is stored as (:SourceEntity)
 * with compound key (source, sourceId) enforced by the schema.
 */
export async function ingest(driver: Driver, entities: SourceEntity[]): Promise<number> {
  return withSession(driver, async (s) => {
    let upserted = 0;
    for (const e of entities) {
      const tagsFlat = Object.entries(e.tags).map(([k, v]) => `${k}=${v}`);
      await s.run(
        `
        MERGE (n:SourceEntity { source: $source, sourceId: $sourceId })
        SET n.canonicalType = $canonicalType,
            n.names         = $names,
            n.tags_flat     = $tagsFlat,
            n.fqdn          = $fqdn,
            n.observedAt    = datetime($observedAt)
        `,
        {
          source: e.source,
          sourceId: e.sourceId,
          canonicalType: e.canonicalType,
          names: e.names,
          tagsFlat,
          fqdn: e.fqdn ?? null,
          observedAt: e.observedAt,
        },
      );
      upserted += 1;
    }
    return upserted;
  });
}
