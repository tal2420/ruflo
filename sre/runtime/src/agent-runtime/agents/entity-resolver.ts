import neo4j from "neo4j-driver";
import { randomUUID } from "node:crypto";
import type { AgentImpl } from "../registry.js";
import type { AgentContext } from "../types.js";
import type { SourceEntity } from "../../entity-resolver/types.js";
import { resolve } from "../../entity-resolver/index.js";
import { PolicyClient } from "../policy-client.js";
import { callTool } from "../call-tool.js";

async function readAllSourceEntities(
  driver: ReturnType<typeof neo4j.driver>,
): Promise<SourceEntity[]> {
  const s = driver.session();
  try {
    const r = await s.run(
      `MATCH (n:SourceEntity) RETURN n.source AS source, n.sourceId AS sourceId,
                                     n.canonicalType AS canonicalType, n.names AS names,
                                     n.tags_flat AS tagsFlat, n.fqdn AS fqdn,
                                     toString(n.observedAt) AS observedAt`,
    );
    return r.records.map((rec) => {
      const tags: Record<string, string> = {};
      for (const atom of (rec.get("tagsFlat") as string[]) ?? []) {
        const [k, ...vals] = atom.split("=");
        if (k) tags[k] = vals.join("=");
      }
      return {
        source: rec.get("source"),
        sourceId: rec.get("sourceId"),
        canonicalType: rec.get("canonicalType"),
        names: rec.get("names"),
        tags,
        fqdn: rec.get("fqdn") ?? undefined,
        observedAt: rec.get("observedAt"),
      } as SourceEntity;
    });
  } finally {
    await s.close();
  }
}

async function upsertCanonical(
  driver: ReturnType<typeof neo4j.driver>,
  canonicalId: string,
  canonicalType: string,
  primaryName: string,
  sources: string[],
): Promise<void> {
  const s = driver.session();
  try {
    await s.run(
      `MERGE (c:CanonicalEntity { id: $id })
       SET c.canonicalType = $canonicalType,
           c.primaryName   = $primaryName,
           c.sources       = $sources,
           c.updatedAt     = datetime()`,
      { id: canonicalId, canonicalType, primaryName, sources },
    );
  } finally {
    await s.close();
  }
}

async function linkSameAs(
  driver: ReturnType<typeof neo4j.driver>,
  m: SourceEntity,
  canonicalId: string,
  method: string,
): Promise<void> {
  const s = driver.session();
  try {
    await s.run(
      `MATCH (s:SourceEntity { source: $source, sourceId: $sourceId }),
             (c:CanonicalEntity { id: $canonicalId })
       MERGE (s)-[:SAME_AS { method: $method }]->(c)`,
      { source: m.source, sourceId: m.sourceId, canonicalId, method },
    );
  } finally {
    await s.close();
  }
}

export const entityResolverAgent: AgentImpl = {
  role: "entity-resolver",
  description: "Walks SourceEntity pairs in the KG, runs the resolver, writes CanonicalEntity and SAME_AS edges.",

  async run(ctx: AgentContext): Promise<{ summary: string }> {
    const client = new PolicyClient({ opaUrl: ctx.opaUrl });
    const driver = neo4j.driver(
      process.env.NEO4J_URI ?? "bolt://localhost:7687",
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? "neo4j",
        process.env.NEO4J_PASSWORD ?? "phase0-password-change-me",
      ),
    );
    try {
      // Reading the graph is a kg__query.
      const entities = await callTool(ctx, client, {
        name: "kg__query",
        input: {},
        target: { env: ctx.targetEnv, businessProcessTier: 3 },
        impl: async () => readAllSourceEntities(driver),
      });
      if (ctx.dryRun || !entities) {
        return { summary: "dry-run — kg__query policy-OK, nothing executed" };
      }

      // Union-find pairing within canonical type.
      const byType = new Map<string, SourceEntity[]>();
      for (const e of entities) {
        const a = byType.get(e.canonicalType) ?? [];
        a.push(e);
        byType.set(e.canonicalType, a);
      }
      const key = (e: SourceEntity) => `${e.source}:${e.sourceId}`;
      const parent = new Map<string, string>();
      for (const e of entities) parent.set(key(e), key(e));
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

      let pairs = 0;
      let linked = 0;
      for (const [, group] of byType) {
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            pairs += 1;
            const r = resolve(group[i]!, group[j]!);
            if (r.decision === "link") {
              union(key(group[i]!), key(group[j]!));
              linked += 1;
            }
          }
        }
      }

      const clusters = new Map<string, SourceEntity[]>();
      for (const e of entities) {
        const root = find(key(e));
        const arr = clusters.get(root) ?? [];
        arr.push(e);
        clusters.set(root, arr);
      }

      let canonicalCreated = 0;
      for (const [, members] of clusters) {
        const canonicalId = `canonical-${randomUUID()}`;
        const canonicalType = members[0]!.canonicalType;
        const primaryName = members[0]!.names[0] ?? canonicalType;
        const sources = Array.from(new Set(members.map((m) => m.source)));

        await callTool(ctx, client, {
          name: "kg__upsert_canonical_entity",
          input: { canonicalId, canonicalType, primaryName, sources },
          target: { env: "corp", businessProcessTier: 3 },
          impl: async (x) =>
            upsertCanonical(driver, x.canonicalId, x.canonicalType, x.primaryName, x.sources),
        });
        canonicalCreated += 1;

        for (const m of members) {
          await callTool(ctx, client, {
            name: "kg__upsert_same_as_edge",
            input: { member: m, canonicalId, method: members.length > 1 ? "resolver" : "singleton" },
            target: { env: "corp", businessProcessTier: 3 },
            impl: async (x) => linkSameAs(driver, x.member, x.canonicalId, x.method),
          });
        }
      }
      return {
        summary: `entities=${entities.length} pairs=${pairs} linked=${linked} canonical=${canonicalCreated}`,
      };
    } finally {
      await driver.close();
    }
  },
};
