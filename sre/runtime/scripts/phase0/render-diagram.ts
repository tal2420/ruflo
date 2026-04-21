import type { Driver } from "neo4j-driver";
import { withSession } from "./neo4j-client.js";

interface RenderOpts {
  businessProcessId: string;
}

/**
 * Query the graph for a business process and its components, group by
 * canonicalType, and emit a Mermaid flowchart. This mirrors what the
 * business-process-analyst agent's generate-process-diagram skill does.
 */
export async function renderBusinessProcessDiagram(
  driver: Driver,
  opts: RenderOpts,
): Promise<string> {
  return withSession(driver, async (s) => {
    const bp = await s.run(
      `MATCH (b:BusinessProcess { id: $id }) RETURN b`,
      { id: opts.businessProcessId },
    );
    if (bp.records.length === 0) {
      throw new Error(`BusinessProcess "${opts.businessProcessId}" not found`);
    }
    const name = bp.records[0]!.get("b").properties.name as string;
    const tierRaw = bp.records[0]!.get("b").properties.criticalityTier;
    const tier =
      tierRaw == null
        ? "?"
        : typeof tierRaw === "number"
          ? tierRaw
          : typeof tierRaw.toNumber === "function"
            ? tierRaw.toNumber()
            : Number(tierRaw);

    const comps = await s.run(
      `
      MATCH (b:BusinessProcess { id: $id })-[:REALIZED_BY]->(c:CanonicalEntity)
      OPTIONAL MATCH (src:SourceEntity)-[:SAME_AS]->(c)
      RETURN c.id AS id,
             c.primaryName AS primaryName,
             c.canonicalType AS canonicalType,
             collect(DISTINCT src.source) AS sources
      ORDER BY c.canonicalType, c.primaryName
      `,
      { id: opts.businessProcessId },
    );

    const components = comps.records.map((r) => ({
      id: r.get("id") as string,
      primaryName: r.get("primaryName") as string,
      canonicalType: r.get("canonicalType") as string,
      sources: (r.get("sources") as string[]).filter(Boolean).sort(),
    }));

    const byLayer = new Map<string, typeof components>();
    const layerOf = (t: string): string => {
      if (["BusinessService", "BusinessApplicationInstance", "BusinessProcess"].includes(t)) return "business";
      if (["Service", "ProcessGroup", "SoftwareInstance", "AppMonitor"].includes(t)) return "application";
      if (["Database", "Datastore"].includes(t)) return "data";
      if (["Host", "Cluster", "Datacenter"].includes(t)) return "infra";
      if (["NetworkDevice", "Interface", "Subnet", "VLAN", "IpAssignment"].includes(t)) return "network";
      return "other";
    };
    for (const c of components) {
      const layer = layerOf(c.canonicalType);
      const arr = byLayer.get(layer) ?? [];
      arr.push(c);
      byLayer.set(layer, arr);
    }

    const lines: string[] = [];
    const safeId = (id: string) => id.replace(/[^A-Za-z0-9_]/g, "_");
    lines.push("flowchart TB");
    lines.push(`  BP["${name}<br/><small>tier-${tier}</small>"]`);

    const layerOrder = ["business", "application", "data", "infra", "network", "other"];
    for (const layer of layerOrder) {
      const items = byLayer.get(layer);
      if (!items || items.length === 0) continue;
      lines.push(`  subgraph ${layer.toUpperCase()}["${layer}"]`);
      for (const c of items) {
        const badge = c.sources.length > 0 ? `<br/><small>${c.sources.join(", ")}</small>` : "";
        lines.push(`    ${safeId(c.id)}["${c.primaryName}${badge}"]`);
      }
      lines.push(`  end`);
      for (const c of items) {
        lines.push(`  BP --> ${safeId(c.id)}`);
      }
    }

    return lines.join("\n");
  });
}
