# Phase 0 — Bring-up runbook

Goal: stand up SREFlow end-to-end **in read-only mode**, producing a knowledge graph and one auto-generated business-process diagram from a sandbox environment. No agent in Phase 0 has write authority over any external system.

**Exit criterion:** you can visit the published KB page for one tier-3 business process and see:
- A Mermaid diagram of its components, grouped by layer.
- Owners, SLOs (if available), and recent incidents from the sandbox.
- Entity provenance from at least two source systems (Dynatrace + one of SolarWinds / BMC).

If that works, Phase 1 (autonomous risk proposals → tickets) becomes a config change, not a code change.

---

## Prerequisites

| Component | Minimum version | Notes |
|---|---|---|
| Node.js | 20 | `node -v` |
| npm | 10 | |
| Docker + Docker Compose | 24 / v2 | For local Neo4j and OPA containers |
| OPA | 0.64+ | CLI — only needed if running policies outside the daemon |
| `gh` CLI | 2.45+ | For cloning the fork |
| Access to a **sandbox** Dynatrace tenant | — | Read-only API token, scopes: entities.read, problems.read, slo.read, metrics.read |
| Access to a **sandbox** SolarWinds or BMC Helix | — | At least one, ideally both — read-only service accounts |
| A secret store | Vault / AWS SM / Azure KV | Never use plain env files in production |

> **Critical:** the sandbox must not share credentials with production. If your org only has one tenant, request a read-only token scoped to a non-sensitive management zone.

## Step 0 — Clone and install

```bash
git clone https://github.com/tal2420/ruflo.git
cd ruflo
git checkout sreflow/scaffolding    # or: git pull origin main after merge

# Runtime modules (entity resolver)
cd sre/runtime && npm ci && npm test && cd ../..

# Base ruflo deps (optional for Phase 0 if you skip the umbrella CLI)
# npm install
```

## Step 1 — Stand up Neo4j locally

Use the simple dev compose file below. **Do not** point this at a shared database; Phase 0 assumes a clean graph.

`docker-compose.phase0.yml`:
```yaml
services:
  neo4j:
    image: neo4j:5.18
    ports: ["7474:7474", "7687:7687"]
    environment:
      - NEO4J_AUTH=neo4j/phase0-password-change-me
      - NEO4J_PLUGINS=["apoc"]
    volumes:
      - ./data/neo4j:/data
```

```bash
docker compose -f docker-compose.phase0.yml up -d
# Wait for: "Bolt enabled on 0.0.0.0:7687."
```

Apply the schema (idempotent):

```bash
docker compose -f docker-compose.phase0.yml exec -T neo4j \
  cypher-shell -u neo4j -p phase0-password-change-me \
  < sre/schema/kg_schema.cypher
```

Verify:
```cypher
SHOW CONSTRAINTS;
SHOW INDEXES;
```
You should see entries for `canonical_id`, `source_entity_key`, `business_process_id`, etc.

## Step 2 — Load policies into OPA

```bash
docker run --rm -p 8181:8181 -v "$PWD/sre/policies":/policies \
  openpolicyagent/opa:0.64.1 run --server /policies
```

Or run OPA as a sidecar to the daemon — either works in Phase 0.

Smoke-test a denial:
```bash
curl -sS -X POST http://localhost:8181/v1/data/sreflow/blast_radius/allow \
  -H 'content-type: application/json' \
  -d @tests/sreflow/fixtures/deny_prod_restart_no_approvals.json | jq
# Expect: {"result": false}
```

And a success:
```bash
curl -sS -X POST http://localhost:8181/v1/data/sreflow/blast_radius/allow \
  -H 'content-type: application/json' \
  -d @tests/sreflow/fixtures/allow_prod_read.json | jq
# Expect: {"result": true}
```

If `allow_prod_read` returns `false`, stop — your OPA bundle didn't load the tool allowlist. Check `opa eval 'data.sreflow.tool_allowlist.tools[0]'` — if empty, OPA isn't reading `tool_allowlist.yaml`. Re-run with `--watch` and confirm the YAML is under `/policies`.

## Step 3 — Configure connectors

Pick **one** source to start with. Dynatrace is the fastest path because its topology feed is the richest.

```bash
cp sre/connectors/dynatrace.yaml.example sre/connectors/dynatrace.yaml
# Edit sre/connectors/dynatrace.yaml and replace ${secret:...} placeholders with
# references your secret store understands (or, for a local-only dry run, a path
# like `file:./secrets/dynatrace.env`).
```

**Scope ruthlessly.** Phase 0 should ingest no more than ~1,000 entities. Set:
```yaml
scope:
  managementZones:
    - "sandbox-checkout"  # One management zone only.
  excludeTagSelector: "owner=infra-sandbox"
```

Verify the token works outside SREFlow:
```bash
curl -sS -H "Authorization: Api-Token $(vault kv get -field=api_token kv/dynatrace/sandbox)" \
  "$DT_TENANT_URL/api/v2/entities?entitySelector=type(SERVICE)&pageSize=1" | jq '.totalCount'
```

## Step 4 — Run the collector in dry-run

Phase 0 collectors must run with write-ability disabled. The configuration `phase.current: 0` in `sre/.claude-plugin/plugin.json` sets `maxWriteAuthority: none`. Until Phase 1 is enabled, the `kg__upsert_entity` / `kg__upsert_edge` tools should be pointed at a **staging KG namespace** or a local Neo4j instance — never shared production.

Run the Dynatrace collector once in dry-run. (Exact command depends on how you invoke SREFlow agents in your environment — below is the pattern.)

```bash
npx claude-flow agent run dynatrace-collector \
  --connector sre/connectors/dynatrace.yaml \
  --kg bolt://localhost:7687 \
  --kg-user neo4j --kg-pass phase0-password-change-me \
  --dry-run
```

`--dry-run` emits the structured upserts it *would* make without actually writing. Inspect stdout to confirm:
- `canonicalType` values are correct (e.g., `Service`, `Host`, not raw Dynatrace strings).
- `source=dynatrace` and `sourceId` is stable across runs.
- Tag maps are sane; nothing sensitive is in them.

When that looks right, re-run without `--dry-run` to populate the KG.

Count ingested entities:
```cypher
MATCH (s:SourceEntity {source: "dynatrace"}) RETURN count(s);
```

## Step 5 — Add a second source, then resolve

Repeat Step 3/4 for **one** additional source — SolarWinds or BMC Helix. Choose based on which Dynatrace entities you want to cross-link:
- Pick **SolarWinds** if you want to validate network-device linking (useful if the sandbox includes infra).
- Pick **BMC Helix** if you want to validate ownership + business-service linking (useful if the sandbox has populated CMDB data).

After both collectors have run, invoke the entity-resolver over the ingested batch:

```bash
node -e '
  import("./sre/runtime/src/entity-resolver/index.js").then(async ({ resolve }) => {
    // Pull pairs of candidate same-type entities from Neo4j and run resolve()
    // on each. Real implementation: a scheduled job (cron or ruflo hook).
    // For Phase 0 smoke-testing, eyeball a handful of pairs.
  });
'
```

Or, more practically, run the resolver tests:
```bash
cd sre/runtime && npm test
```

Both sources loaded + `SAME_AS` edges present → **Phase 0 Layer 1 is live**.

```cypher
MATCH (s:SourceEntity)-[:SAME_AS]->(c:CanonicalEntity)
RETURN s.source, count(c) AS linked;
```

## Step 6 — Render the first diagram

Seed one `BusinessProcess` node. In the sandbox, you likely have a business service already in BMC Helix — pull its ID and run:

```cypher
CREATE (b:BusinessProcess {
  id: "bp-sandbox-checkout",
  name: "Sandbox Checkout",
  criticalityTier: 3
});
// Optionally attach it to its realizing canonical entities:
MATCH (b:BusinessProcess {id: "bp-sandbox-checkout"}),
      (c:CanonicalEntity {canonicalType: "Service"})
WHERE "team:checkout" IN c.tags_flat
CREATE (b)-[:REALIZED_BY]->(c);
```

Then invoke the `business-process-analyst` agent to render + publish:

```bash
npx claude-flow skill run map-business-process \
  --processName "Sandbox Checkout" \
  --hops 3 \
  --kb-target confluence:SANDBOX_SRE
```

Open the Confluence page it returns. You should see:
- The Mermaid diagram with grouped layers.
- A components table with source provenance columns.
- A "risk snapshot" section showing 0 findings (no Layer 2 running yet).

That's the exit criterion.

---

## Smoke checks

Run these at the end of Phase 0 bring-up and on every subsequent deployment:

```bash
# 1. Policies deny what they should.
opa test sre/policies/ tests/sreflow/policies/

# 2. Every agent's allowed tool is registered.
bash scripts/sreflow/audit_agent_tools.sh

# 3. Entity resolver logic works.
cd sre/runtime && npm test && cd ../..

# 4. Neo4j constraints are present.
docker compose -f docker-compose.phase0.yml exec -T neo4j \
  cypher-shell -u neo4j -p phase0-password-change-me \
  "SHOW CONSTRAINTS YIELD name WHERE name STARTS WITH 'canonical' OR name STARTS WITH 'business'"

# 5. A denied tool call is actually denied.
curl -sS -X POST http://localhost:8181/v1/data/sreflow/blast_radius/allow \
  -H 'content-type: application/json' \
  -d @tests/sreflow/fixtures/deny_destructive.json | jq -e '.result == false'
```

If any of these fail, **do not proceed to Phase 1**.

## Rollback

Everything in Phase 0 is read-only and local:
- Stop the daemons / containers.
- `docker compose -f docker-compose.phase0.yml down -v` to discard the Neo4j volume.
- Revoke the sandbox Dynatrace token.
- Remove `sre/connectors/*.yaml` (they're gitignored; never get committed).

Source systems have not been modified. No rollback of external state is required.

## What to do if something surprises you

| Symptom | Likely cause | Action |
|---|---|---|
| Collector ingests 10× expected entity count | Scope too broad | Narrow `scope.managementZones` or `scope.business_services.categories` and re-run |
| Entity-resolver queues ~everything | Thresholds too strict or neighbor data missing | Check `neighborCanonicalIds` is being populated; consider `{ thresholds: { high: 0.85, medium: 0.7 } }` only after reviewing 20 queued cases manually |
| Confluence page publish fails | Service account lacks write on the target space | Fix IAM; do not widen the token scope to all of Confluence |
| OPA `allow` always returns true | Policy bundle misconfigured | Verify `opa eval 'data.sreflow.tool_allowlist.tools | count'` returns the expected number |
| A denial reaches an agent but the agent retries | Hook didn't fail closed OR agent ignored the signal | Stop the daemon. Investigate. Denials must be terminal. |

## Promotion criteria to Phase 1

You may enable Layer 2 (autonomous risk proposals → tickets) only when:

1. ✅ Phase 0 exit criterion met for at least **3 business processes** across **2 criticality tiers**.
2. ✅ 30 consecutive days of Layer 1 operation with no credential leak, no audit-log gap, no unauthorized tool call (grepped from `sre_audit.jsonl`).
3. ✅ The reconciliation queue has been reviewed at least once by a human operator and is < 50 items.
4. ✅ Destructive tools are still unbound in `sre/policies/tool_allowlist.yaml` (they should be, but re-verify — any change here is a policy incident).
5. ✅ A sign-off doc from an SRE lead explicitly approving the transition.

Phase 1 itself is then a config change: increment `phase.current` in `sre/.claude-plugin/plugin.json` from 0 to 1, redeploy.
