import neo4j, { type Driver } from "neo4j-driver";
import type { AgentImpl } from "../registry.js";
import type { AgentContext } from "../types.js";
import { PolicyClient } from "../policy-client.js";
import { callTool } from "../call-tool.js";
import {
  proposeBusinessProcesses,
  type TaggedEntity,
  type BusinessProcessCandidate,
} from "./bp-discovery.js";

async function readTaggedEntities(driver: Driver): Promise<TaggedEntity[]> {
  const s = driver.session();
  try {
    const r = await s.run(
      `MATCH (n:SourceEntity)
       RETURN n.source + ":" + n.sourceId AS id, coalesce(n.tags_flat, []) AS tagsFlat`,
    );
    return r.records.map((rec) => ({
      id: rec.get("id") as string,
      tagsFlat: rec.get("tagsFlat") as string[],
    }));
  } finally {
    await s.close();
  }
}

async function readBmcBusinessServices(driver: Driver): Promise<BusinessProcessCandidate[]> {
  const s = driver.session();
  try {
    const r = await s.run(
      `MATCH (n:SourceEntity { source: "bmc_helix" })
       WHERE n.canonicalType IN ["BusinessService", "BusinessProcess"]
          OR any(a IN n.tags_flat WHERE a STARTS WITH "business_service=")
       RETURN n.sourceId AS sourceId,
              coalesce(n.names, []) AS names,
              coalesce(n.tags_flat, []) AS tagsFlat`,
    );
    const candidates: BusinessProcessCandidate[] = [];
    for (const rec of r.records) {
      const sourceId = rec.get("sourceId") as string;
      const names = rec.get("names") as string[];
      const tagsFlat = rec.get("tagsFlat") as string[];
      const bsTag = tagsFlat.find((a) => a.startsWith("business_service="));
      const name = names[0] ?? bsTag?.slice("business_service=".length) ?? sourceId;
      const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      candidates.push({
        id: `bp-bmc-${safeName}`,
        name,
        inferenceMethod: `bmc_helix:${sourceId} (authoritative business service)`,
        anchorTags: bsTag ? [bsTag] : [],
        memberIds: [],
        score: 10, // high — authoritative
      });
    }
    return candidates;
  } finally {
    await s.close();
  }
}

async function upsertBusinessProcess(
  driver: Driver,
  bp: BusinessProcessCandidate,
  tier: 1 | 2 | 3,
): Promise<void> {
  const s = driver.session();
  try {
    await s.run(
      `MERGE (b:BusinessProcess { id: $id })
       SET b.name             = $name,
           b.criticalityTier  = $tier,
           b.inferenceMethod  = $inferenceMethod,
           b.anchorTags       = $anchorTags,
           b.discoveredBy     = "business-process-analyst",
           b.updatedAt        = datetime()`,
      {
        id: bp.id,
        name: bp.name,
        tier,
        inferenceMethod: bp.inferenceMethod,
        anchorTags: bp.anchorTags,
      },
    );
  } finally {
    await s.close();
  }
}

async function ensureCanonicalsAndLinkBp(
  driver: Driver,
  bp: BusinessProcessCandidate,
  anchorTagMatch: string[],
): Promise<{ linked: number; createdCanonicals: number }> {
  // For every SourceEntity that carries any of the anchor tags, ensure a
  // singleton CanonicalEntity exists and is linked via SAME_AS and REALIZED_BY.
  if (anchorTagMatch.length === 0) return { linked: 0, createdCanonicals: 0 };
  const s = driver.session();
  try {
    const r = await s.run(
      `MATCH (src:SourceEntity)
       WHERE any(a IN $atoms WHERE a IN src.tags_flat)
       WITH src
       MERGE (c:CanonicalEntity { id: "canonical-" + src.source + "-" + src.sourceId })
         ON CREATE SET c.canonicalType = src.canonicalType,
                       c.primaryName   = coalesce(src.names[0], src.sourceId),
                       c.sources       = [src.source],
                       c.updatedAt     = datetime()
         ON MATCH  SET c.sources       = coalesce(c.sources, []) + [x IN [src.source] WHERE NOT x IN coalesce(c.sources, [])],
                       c.updatedAt     = datetime()
       MERGE (src)-[:SAME_AS { method: "singleton-" + src.source }]->(c)
       WITH c
       MATCH (bp:BusinessProcess { id: $bpId })
       MERGE (bp)-[:REALIZED_BY]->(c)
       RETURN count(DISTINCT c) AS linked`,
      { atoms: anchorTagMatch, bpId: bp.id },
    );
    const linked = r.records[0]?.get("linked")?.toNumber?.() ?? 0;
    return { linked, createdCanonicals: linked };
  } finally {
    await s.close();
  }
}

function tierFor(candidate: BusinessProcessCandidate): 1 | 2 | 3 {
  // Heuristic: anything sourced from the BMC authoritative feed is tier-1;
  // everything else defaults to tier-2 until a human promotes / demotes it.
  if (candidate.inferenceMethod.startsWith("bmc_helix:")) return 1;
  if (candidate.inferenceMethod.startsWith("dual-signal")) return 2;
  return 3;
}

export const businessProcessAnalyst: AgentImpl = {
  role: "business-process-analyst",
  description:
    "Autonomously discovers business processes from the graph (Dynatrace tag clusters + BMC business-service CIs), creates BusinessProcess nodes, links components via REALIZED_BY, and reports findings.",

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
      // 1. Read all tagged entities — gated kg__query.
      const tagged = await callTool(ctx, client, {
        name: "kg__query",
        input: {},
        target: { env: ctx.targetEnv, businessProcessTier: 3 },
        impl: async () => readTaggedEntities(driver),
      });
      if (ctx.dryRun || !tagged) {
        return { summary: "dry-run — kg__query policy-OK, nothing executed" };
      }

      // 2. Read BMC business services — another kg__query.
      const bmcCandidates = await callTool(ctx, client, {
        name: "kg__query",
        input: {},
        target: { env: ctx.targetEnv, businessProcessTier: 3 },
        impl: async () => readBmcBusinessServices(driver),
      });

      // 3. Tag-cluster discovery (pure function).
      const tagCandidates = proposeBusinessProcesses(tagged);

      // 4. Merge BMC-authoritative candidates first (tier-1), then tag-derived.
      //    De-dupe by id.
      const seenIds = new Set<string>();
      const all: BusinessProcessCandidate[] = [];
      for (const cand of (bmcCandidates ?? []).concat(tagCandidates)) {
        if (seenIds.has(cand.id)) continue;
        seenIds.add(cand.id);
        all.push(cand);
      }

      // 5. For each candidate, upsert BP + link canonicals.
      const report: Array<{ id: string; name: string; tier: number; linked: number; inferenceMethod: string }> = [];
      for (const cand of all) {
        const tier = tierFor(cand);
        await callTool(ctx, client, {
          name: "kg__upsert_entity",
          input: { cand, tier },
          target: { env: "corp", businessProcessTier: tier },
          impl: async ({ cand, tier }) => upsertBusinessProcess(driver, cand, tier),
        });

        const { linked } = await callTool(ctx, client, {
          name: "kg__upsert_edge",
          input: { cand, tier },
          target: { env: "corp", businessProcessTier: tier },
          impl: async () => ensureCanonicalsAndLinkBp(driver, cand, cand.anchorTags),
        });
        report.push({
          id: cand.id,
          name: cand.name,
          tier,
          linked,
          inferenceMethod: cand.inferenceMethod,
        });
      }

      const summary =
        `analyzed entities=${tagged.length} bmc_candidates=${(bmcCandidates ?? []).length} ` +
        `tag_candidates=${tagCandidates.length} accepted=${report.length} ` +
        `top=${report
          .slice(0, 3)
          .map((r) => `${r.name}(tier${r.tier},n=${r.linked})`)
          .join(",")}`;

      // Print the full report for operator visibility.
      console.log("");
      console.log("▶ Business-process candidates:");
      for (const r of report) {
        console.log(
          `  tier-${r.tier}  linked=${String(r.linked).padStart(4)}  ${r.id.padEnd(40)}  ${r.inferenceMethod}`,
        );
      }
      console.log("");

      return { summary };
    } finally {
      await driver.close();
    }
  },
};
