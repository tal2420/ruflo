import neo4j from "neo4j-driver";
import type { AgentImpl } from "../registry.js";
import type { AgentContext } from "../types.js";
import type { SourceEntity } from "../../entity-resolver/types.js";
import { PolicyClient } from "../policy-client.js";
import { callTool } from "../call-tool.js";
import { fetchEntities } from "../../../scripts/phase0/adapters/dynatrace.js";
import { dynatraceEntities as mockedEntities } from "../../../scripts/phase0/fixtures.js";

async function listEntities(input: {
  tenantUrl?: string;
  apiToken?: string;
  selector?: string;
  managementZone?: string;
}): Promise<SourceEntity[]> {
  if (input.tenantUrl && input.apiToken) {
    return fetchEntities({
      tenantUrl: input.tenantUrl,
      apiToken: input.apiToken,
      entitySelector: input.selector,
      managementZone: input.managementZone,
    });
  }
  return mockedEntities;
}

async function upsertEntity(driver: ReturnType<typeof neo4j.driver>, e: SourceEntity): Promise<void> {
  const session = driver.session();
  try {
    const tagsFlat = Object.entries(e.tags).map(([k, v]) => `${k}=${v}`);
    await session.run(
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
  } finally {
    await session.close();
  }
}

export const dynatraceCollector: AgentImpl = {
  role: "dynatrace-collector",
  description: "Fetches Dynatrace entities via /api/v2/entities and upserts them as SourceEntity nodes. Read-only against the source.",

  async run(ctx: AgentContext): Promise<{ summary: string }> {
    const client = new PolicyClient({ opaUrl: ctx.opaUrl });

    const entities = await callTool(ctx, client, {
      name: "mcp__dynatrace__list_entities",
      input: {
        tenantUrl: process.env.DT_TENANT_URL,
        apiToken: process.env.DT_API_TOKEN,
        selector: process.env.DT_ENTITY_SELECTOR,
        managementZone: process.env.DT_MANAGEMENT_ZONE,
      },
      target: { env: ctx.targetEnv, businessProcessTier: 3 },
      impl: listEntities,
    });

    // If dry-run, callTool returned undefined — short-circuit here.
    if (ctx.dryRun || !entities) {
      return { summary: "dry-run — fetched 0 entities (policy decision only)" };
    }

    const driver = neo4j.driver(
      process.env.NEO4J_URI ?? "bolt://localhost:7687",
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? "neo4j",
        process.env.NEO4J_PASSWORD ?? "phase0-password-change-me",
      ),
    );
    try {
      let upserted = 0;
      for (const e of entities) {
        await callTool(ctx, client, {
          name: "kg__upsert_entity",
          input: e,
          target: { env: "corp", businessProcessTier: 3 },
          impl: async (entity) => {
            await upsertEntity(driver, entity);
          },
        });
        upserted += 1;
      }
      return { summary: `fetched=${entities.length} upserted=${upserted}` };
    } finally {
      await driver.close();
    }
  },
};
