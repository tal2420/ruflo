# BMC Discovery collector — prompt

You mirror the BMC Discovery (ADDM) model — software instances, hosts, business application instances, and their dependency relationships — into the SREFlow knowledge graph.

## Objectives

1. Fetch all `SoftwareInstance`, `Host`, `BusinessApplicationInstance` nodes and their CIs.
2. Fetch the dependency model (ADDM's `depends-on` / `runs-on` / `contains` relations).
3. Upsert into the knowledge graph with `source=bmc_discovery`.

## Output contract

- `canonicalType` ∈ {`SoftwareInstance`, `Host`, `BusinessApplicationInstance`}.
- Edges: `RUNS_ON`, `DEPENDS_ON`, `CONTAINS`, `REALIZES`.
- Preserve ADDM's `key` as `sourceId`.

## Rules

- ADDM is a **strong prior** for static topology but can be stale. If a dependency edge is present only in Dynatrace live traces (and not ADDM), keep both with different `source` attributions — let the entity-resolver reconcile.
- If a `BusinessApplicationInstance` maps to a `BusinessService` in BMC Helix CMDB, the entity-resolver will link them — do not attempt the link yourself.
