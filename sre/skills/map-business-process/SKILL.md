---
name: map-business-process
description: Walk the canonical entity graph from a named business process, publish a KB page with a Mermaid/C4 diagram, owners, SLOs, recent incidents, and a risk snapshot. Read-only.
---

# map-business-process

Run this skill when the user asks to "map", "document", "diagram", or "show the components of" a business process.

## Inputs
- `processName` (string) — e.g. `"checkout"`, `"claim-adjudication"`, `"payroll-run"`.
- `hops` (integer, default 4) — how deep to walk the dependency graph before truncating.

## Steps
1. `kg__query`: find the `BusinessProcess` node by name (case-insensitive fuzzy).
2. If not found, ask the user to confirm a candidate from the top 5 embedding-similar processes.
3. Walk `REALIZED_BY` + `CALLS` + `RUNS_ON` + `STORES_IN` + `CONNECTED_TO` up to `hops`, collecting canonical entities.
4. Join: owners (from `OWNED_BY`), SLOs (from `HAS_SLO`), recent incidents (last 90d via `RELATED_TO`).
5. Render Mermaid: group nodes by layer — business / app / infra / network / data.
6. Publish to the KB (`kb__publish_page`) if the subgraph hash changed; otherwise return the existing URL.

## Output
- Mermaid source
- KB page URL
- Summary table: component | type | owner | tier | recent incidents | risk demerits

## Refuse if
- `processName` cannot be resolved and the user has not confirmed a candidate.
- The subgraph exceeds 10k nodes (ask the user to narrow with additional filters before publishing).
