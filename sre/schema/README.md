# `sre/schema/` — knowledge graph schema

## Files

- [`kg_schema.cypher`](kg_schema.cypher) — Neo4j constraints, indexes, and node-type definitions.
- [`entity_schema.json`](entity_schema.json) — JSON Schema for canonical entities (used at ingestion boundaries and for conflict-queue validation).

## Applying the schema

```bash
cypher-shell -a bolt://neo4j.corp:7687 -u neo4j -p "$NEO4J_PW" < sre/schema/kg_schema.cypher
```

The schema is additive — constraints and indexes use `IF NOT EXISTS`. Re-running is idempotent.

## Canonical entity model

Every source-system entity (Dynatrace, SolarWinds, BMC Helix, BMC Discovery, doc) is stored as-is, with provenance (`source`, `sourceId`, `observedAt`). The entity-resolver agent creates `CanonicalEntity` nodes and `SAME_AS` edges from source nodes to their canonical representative. Downstream layers (SRE brain, incident swarm) always traverse via canonical entities, never raw source nodes.

## Tiered access

- `BusinessProcess` nodes carry a `criticalityTier` (1/2/3). This is the driver for HITL approvals and freeze-window scope.
- `Change` nodes (from BMC Helix) feed the change-correlator in Layer 3.
- `Incident` nodes feed the similar-incident-finder (RAG retrieval).
