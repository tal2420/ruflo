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
import { toHebrew } from "../hebrew-labels.js";
import {
  reconcile,
  type CurrentBpState,
  type ExistingEdge,
  type EdgeStatus,
  type ProposedBp,
} from "./reconciliation.js";

export interface ReconcileStats {
  linked: number;
  added: number;
  refreshed: number;
  markedStale: number;
  respectedRejection: number;
  skippedLockedEdge: number;
  blockedByLock: string[];
}

function emptyStats(): ReconcileStats {
  return {
    linked: 0,
    added: 0,
    refreshed: 0,
    markedStale: 0,
    respectedRejection: 0,
    skippedLockedEdge: 0,
    blockedByLock: [],
  };
}

async function readCurrentBpState(driver: Driver, bpId: string): Promise<CurrentBpState> {
  const s = driver.session();
  try {
    const r = await s.run(
      `OPTIONAL MATCH (bp:BusinessProcess { id: $bpId })
       OPTIONAL MATCH (bp)-[rel:REALIZED_BY]->(c:CanonicalEntity)
       WITH bp, collect(CASE WHEN c IS NULL THEN null ELSE {
         id: c.id,
         role: rel.role,
         status: coalesce(rel.status, "active"),
         addedBy: coalesce(rel.addedBy, "business-process-analyst"),
         firstSeen: coalesce(toString(rel.firstSeen), toString(bp.firstSeen), toString(bp.updatedAt), toString(datetime())),
         lastSeen: coalesce(toString(rel.lastSeen), toString(bp.updatedAt), toString(datetime())),
         evidence: rel.evidence,
         lockedByHuman: coalesce(rel.lockedByHuman, false)
       } END) AS edges
       RETURN bp, [e IN edges WHERE e IS NOT NULL] AS edges`,
      { bpId },
    );
    if (r.records.length === 0 || r.records[0]!.get("bp") == null) {
      return { exists: false, lockedFields: [], components: new Map() };
    }
    const bpProps = r.records[0]!.get("bp").properties as Record<string, unknown>;
    const lockedFields = Array.isArray(bpProps.lockedFields)
      ? (bpProps.lockedFields as string[])
      : [];
    const rawEdges = r.records[0]!.get("edges") as Array<Record<string, unknown>>;
    const components = new Map<string, ExistingEdge>();
    for (const e of rawEdges) {
      const status = String(e.status ?? "active") as EdgeStatus;
      components.set(String(e.id), {
        role: e.role ? String(e.role) : undefined,
        status,
        addedBy: String(e.addedBy ?? "business-process-analyst"),
        firstSeen: String(e.firstSeen ?? ""),
        lastSeen: String(e.lastSeen ?? ""),
        evidence: e.evidence ? String(e.evidence) : undefined,
        lockedByHuman: Boolean(e.lockedByHuman),
      });
    }
    return { exists: true, lockedFields, components };
  } finally {
    await s.close();
  }
}

async function writeBpFields(
  driver: Driver,
  bpId: string,
  fields: Record<string, unknown>,
  hostApplicationBpId: string | null,
  isCreate: boolean,
): Promise<void> {
  const s = driver.session();
  try {
    await s.run(
      `MERGE (bp:BusinessProcess { id: $bpId })
       ON CREATE SET bp.firstSeen = datetime()
       SET bp += $fields,
           bp.lastSeen = datetime(),
           bp.updatedAt = datetime(),
           bp.discoveredBy = coalesce(bp.discoveredBy, $discoveredBy)
       ${hostApplicationBpId ? `WITH bp
       MATCH (app:BusinessProcess { id: $appId })
       MERGE (bp)-[:HOSTED_IN]->(app)` : ""}`,
      {
        bpId,
        fields,
        appId: hostApplicationBpId,
        discoveredBy: "business-process-analyst",
      },
    );
    // touched `isCreate` only for symmetry of the caller's API; no behavioural diff.
    void isCreate;
  } finally {
    await s.close();
  }
}

async function writeUpsertEdge(
  driver: Driver,
  bpId: string,
  componentId: string,
  role: string,
  evidence: string,
  addedBy: string,
): Promise<void> {
  const s = driver.session();
  try {
    await s.run(
      `MATCH (bp:BusinessProcess { id: $bpId }), (c:CanonicalEntity { id: $cid })
       MERGE (bp)-[r:REALIZED_BY]->(c)
       ON CREATE SET r.firstSeen = datetime()
       SET r.role     = $role,
           r.evidence = $evidence,
           r.addedBy  = $addedBy,
           r.status   = "active",
           r.lastSeen = datetime()`,
      { bpId, cid: componentId, role, evidence, addedBy },
    );
  } finally {
    await s.close();
  }
}

async function writeMarkStale(
  driver: Driver,
  bpId: string,
  componentId: string,
): Promise<void> {
  const s = driver.session();
  try {
    await s.run(
      `MATCH (:BusinessProcess { id: $bpId })-[r:REALIZED_BY]->(:CanonicalEntity { id: $cid })
       SET r.status = "stale"`,
      { bpId, cid: componentId },
    );
  } finally {
    await s.close();
  }
}

/**
 * Reconcile a BP (either application or feature scope) against its current
 * state in Neo4j, writing only the deltas. Respects lockedFields, refreshes
 * evidence timestamps, and marks missing edges stale.
 */
async function reconcileAndApplyBp(
  driver: Driver,
  proposed: ProposedBp,
  hostApplicationBpId: string | null,
): Promise<ReconcileStats> {
  const stats = emptyStats();
  const current = await readCurrentBpState(driver, proposed.id);
  const actions = reconcile({ current, proposed });

  for (const a of actions) {
    switch (a.kind) {
      case "create-bp":
      case "refresh-bp":
        await writeBpFields(driver, a.bpId, a.fields, hostApplicationBpId, a.kind === "create-bp");
        break;
      case "blocked-by-lock":
        stats.blockedByLock.push(a.field);
        break;
      case "upsert-edge":
        await writeUpsertEdge(driver, a.bpId, a.componentId, a.role, a.evidence, a.addedBy);
        stats.linked += 1;
        if (a.isNew) stats.added += 1;
        else stats.refreshed += 1;
        break;
      case "mark-stale":
        await writeMarkStale(driver, a.bpId, a.componentId);
        stats.markedStale += 1;
        break;
      case "respect-rejection":
        stats.respectedRejection += 1;
        break;
      case "skip-locked-edge":
        stats.skippedLockedEdge += 1;
        stats.linked += 1;
        break;
    }
  }
  return stats;
}

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
  now: string,
): Promise<ReconcileStats> {
  const hebrew = toHebrew(bp.name);
  const proposed: ProposedBp = {
    id: bp.id,
    fields: {
      name: bp.name,
      nameHe: hebrew.he,
      scope: "application",
      criticalityTier: tier,
      inferenceMethod: bp.inferenceMethod,
      anchorTags: bp.anchorTags,
    },
    components: [], // application-scope BPs get their components via ensureCanonicalsAndLinkBp
    evidence: `application-discovery @ ${now}`,
    addedBy: "business-process-analyst",
  };
  return reconcileAndApplyBp(driver, proposed, null);
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
  now: string,
): Promise<ReconcileStats> {
  const components: Array<{ id: string; role: string }> = [
    { id: feature.components.core, role: "core" },
    ...feature.components.upstream.map((id) => ({ id, role: "upstream" })),
    ...feature.components.downstream.map((id) => ({ id, role: "downstream" })),
  ];
  // De-dup by id (a service listed as both core and upstream would confuse the reconciler).
  const seen = new Set<string>();
  const dedup = components.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  const hebrew = toHebrew(feature.name);
  const proposed: ProposedBp = {
    id: feature.id,
    fields: {
      name: feature.name,
      nameHe: hebrew.he,
      scope: "feature",
      sourceName: feature.sourceName,
      criticalityTier: tier,
      inferenceMethod: feature.inferenceMethod,
    },
    components: dedup,
    evidence: `${feature.inferenceMethod} @ ${now}`,
    addedBy: "business-process-analyst",
  };
  return reconcileAndApplyBp(driver, proposed, applicationBpId);
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

      const now = ctx.now;
      // 5. For each candidate, reconcile application-level BP fields, then
      //    (separately) link members via the anchor-tag matcher.
      const report: Array<{ id: string; name: string; tier: number; linked: number; inferenceMethod: string; blockedByLock: string[]; staled: number; added: number }> = [];
      for (const cand of all) {
        const tier = tierFor(cand);
        const appStats = await callTool(ctx, client, {
          name: "kg__upsert_entity",
          input: { cand, tier },
          target: { env: "corp", businessProcessTier: tier },
          impl: async () => upsertBusinessProcess(driver, cand, tier, now),
        });

        const edgeOut = await callTool(ctx, client, {
          name: "kg__upsert_edge",
          input: { cand, tier },
          target: { env: "corp", businessProcessTier: tier },
          impl: async () => ensureCanonicalsAndLinkBp(driver, cand, cand.anchorTags),
        });
        const linked = edgeOut?.linked ?? 0;
        report.push({
          id: cand.id,
          name: cand.name,
          tier,
          linked,
          inferenceMethod: cand.inferenceMethod,
          blockedByLock: appStats?.blockedByLock ?? [],
          staled: appStats?.markedStale ?? 0,
          added: appStats?.added ?? 0,
        });
      }

      // 6. Feature-level pass: for each accepted application, walk its cluster
      //    topology and extract feature-named entry-point services. Each becomes
      //    a BusinessProcess at scope="feature", hosted_in the application BP.
      let totalFeatures = 0;
      const featureReport: Array<{ appName: string; features: Array<{ id: string; name: string; source: string; linked: number; tier: number; added: number; refreshed: number; markedStale: number; blockedByLock: string[] }> }> = [];
      for (const cand of all) {
        const tier = tierFor(cand);
        const { services, calls } = await readClusterTopology(driver, cand.id);
        if (services.length === 0) continue;
        const features = extractFeatures(services, calls);
        const appFeatures: typeof featureReport[number]["features"] = [];
        for (const feature of features) {
          const fstats = await callTool(ctx, client, {
            name: "kg__upsert_edge",
            input: { feature, appId: cand.id, tier },
            target: { env: "corp", businessProcessTier: tier },
            impl: async (x) => upsertFeatureBp(driver, x.feature, x.appId, x.tier, now),
          });
          appFeatures.push({
            id: feature.id,
            name: feature.name,
            source: feature.sourceName,
            linked: fstats?.linked ?? 0,
            tier,
            added: fstats?.added ?? 0,
            refreshed: fstats?.refreshed ?? 0,
            markedStale: fstats?.markedStale ?? 0,
            blockedByLock: fstats?.blockedByLock ?? [],
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
            const extras: string[] = [];
            if (f.added > 0) extras.push(`+${f.added} new`);
            if (f.markedStale > 0) extras.push(`−${f.markedStale} stale`);
            if (f.blockedByLock.length > 0) extras.push(`locked:${f.blockedByLock.join(",")}`);
            const tag = extras.length > 0 ? ` [${extras.join(" · ")}]` : "";
            console.log(
              `      tier-${f.tier}  components=${String(f.linked).padStart(2)}  ${f.name.padEnd(38)}  ← ${f.source}${tag}`,
            );
          }
        }
      }
      const totalAdded = featureReport.reduce((n, app) => n + app.features.reduce((m, f) => m + f.added, 0), 0);
      const totalStaled = featureReport.reduce((n, app) => n + app.features.reduce((m, f) => m + f.markedStale, 0), 0);
      const totalLocked = featureReport.reduce((n, app) => n + app.features.reduce((m, f) => m + f.blockedByLock.length, 0), 0);
      console.log("");
      console.log(
        `▶ Evolution: +${totalAdded} new components · ${totalStaled} marked stale · ${totalLocked} field(s) preserved by human lock`,
      );
      console.log("");

      const enrichedSummary =
        `${summary} evolution{added=${totalAdded},stale=${totalStaled},locked=${totalLocked}}`;
      return { summary: enrichedSummary };
    } finally {
      await driver.close();
    }
  },
};
