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
import {
  extractFeatures,
  type CallEdge,
  type FeatureCandidate,
  type ServiceRecord,
} from "./feature-extractor.js";

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
           b.scope            = "application",
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

async function readClusterTopology(
  driver: Driver,
  applicationBpId: string,
): Promise<{ services: ServiceRecord[]; calls: CallEdge[] }> {
  const s = driver.session();
  try {
    const svcR = await s.run(
      `MATCH (bp:BusinessProcess { id: $bpId })-[:REALIZED_BY]->(c:CanonicalEntity)
       RETURN c.id AS id, coalesce(c.primaryName, c.id) AS name`,
      { bpId: applicationBpId },
    );
    const services: ServiceRecord[] = svcR.records.map((rec) => ({
      id: rec.get("id") as string,
      name: rec.get("name") as string,
    }));
    const edgeR = await s.run(
      `MATCH (bp:BusinessProcess { id: $bpId })-[:REALIZED_BY]->(a:CanonicalEntity),
             (bp)-[:REALIZED_BY]->(b:CanonicalEntity),
             (a)-[:CALLS]->(b)
       RETURN a.id AS fromId, b.id AS toId`,
      { bpId: applicationBpId },
    );
    const calls: CallEdge[] = edgeR.records.map((rec) => ({
      fromId: rec.get("fromId") as string,
      toId: rec.get("toId") as string,
    }));
    return { services, calls };
  } finally {
    await s.close();
  }
}

async function upsertFeatureBp(
  driver: Driver,
  feature: FeatureCandidate,
  applicationBpId: string,
  tier: 1 | 2 | 3,
): Promise<number> {
  const componentIds = Array.from(
    new Set([
      feature.components.core,
      ...feature.components.upstream,
      ...feature.components.downstream,
    ]),
  );
  const s = driver.session();
  try {
    const r = await s.run(
      `MERGE (fbp:BusinessProcess { id: $id })
       SET fbp.name             = $name,
           fbp.scope            = "feature",
           fbp.sourceName       = $sourceName,
           fbp.criticalityTier  = $tier,
           fbp.inferenceMethod  = $inferenceMethod,
           fbp.discoveredBy     = "business-process-analyst",
           fbp.updatedAt        = datetime()
       WITH fbp
       MATCH (app:BusinessProcess { id: $appId })
       MERGE (fbp)-[:HOSTED_IN]->(app)
       WITH fbp
       UNWIND $componentIds AS cid
       MATCH (c:CanonicalEntity { id: cid })
       MERGE (fbp)-[:REALIZED_BY]->(c)
       RETURN count(DISTINCT c) AS linked`,
      {
        id: feature.id,
        name: feature.name,
        sourceName: feature.sourceName,
        tier,
        inferenceMethod: feature.inferenceMethod,
        appId: applicationBpId,
        componentIds,
      },
    );
    return r.records[0]?.get("linked")?.toNumber?.() ?? 0;
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

      // 6. Feature-level pass: for each accepted application, walk its cluster
      //    topology and extract feature-named entry-point services. Each becomes
      //    a BusinessProcess at scope="feature", hosted_in the application BP.
      let totalFeatures = 0;
      const featureReport: Array<{ appName: string; features: Array<{ id: string; name: string; source: string; linked: number; tier: number }> }> = [];
      for (const cand of all) {
        const tier = tierFor(cand);
        const { services, calls } = await readClusterTopology(driver, cand.id);
        if (services.length === 0) continue;
        const features = extractFeatures(services, calls);
        const appFeatures: typeof featureReport[number]["features"] = [];
        for (const feature of features) {
          const linked = await callTool(ctx, client, {
            name: "kg__upsert_edge",
            input: { feature, appId: cand.id, tier },
            target: { env: "corp", businessProcessTier: tier },
            impl: async (x) => upsertFeatureBp(driver, x.feature, x.appId, x.tier),
          });
          appFeatures.push({
            id: feature.id,
            name: feature.name,
            source: feature.sourceName,
            linked: typeof linked === "number" ? linked : 0,
            tier,
          });
        }
        if (appFeatures.length > 0) {
          featureReport.push({ appName: cand.name, features: appFeatures });
          totalFeatures += appFeatures.length;
        }
      }

      const summary =
        `analyzed entities=${tagged.length} applications=${report.length} features=${totalFeatures} ` +
        `top_apps=${report
          .slice(0, 3)
          .map((r) => `${r.name}(tier${r.tier},n=${r.linked})`)
          .join(",")}`;

      // Print the full two-layer report for operator visibility.
      console.log("");
      console.log("▶ Applications (scope=application):");
      for (const r of report) {
        console.log(
          `  tier-${r.tier}  components=${String(r.linked).padStart(4)}  ${r.id.padEnd(42)}  ${r.inferenceMethod}`,
        );
      }
      if (totalFeatures > 0) {
        console.log("");
        console.log("▶ Business processes (scope=feature):");
        for (const app of featureReport) {
          console.log(`  ── in ${app.appName} (${app.features.length} features):`);
          for (const f of app.features) {
            console.log(
              `      tier-${f.tier}  components=${String(f.linked).padStart(2)}  ${f.name.padEnd(38)}  ← ${f.source}`,
            );
          }
        }
      }
      console.log("");

      return { summary };
    } finally {
      await driver.close();
    }
  },
};
