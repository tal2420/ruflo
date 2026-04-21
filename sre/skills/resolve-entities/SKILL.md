---
name: resolve-entities
description: Run the entity-resolver matcher chain against a batch of unresolved source entities and propose canonical links. Writes to the conflict queue only when confidence is in the middle band.
---

# resolve-entities

## Inputs
- `sourceEntities` — array of source-system entities needing a canonical link.
- `thresholds` — optional override of { high: 0.90, medium: 0.75 }.

## Steps
1. Deterministic matchers first (FQDN, ARN, k8s triple, MAC, repo URL, explicit `same_as`).
2. Structured probabilistic matchers (name, tags, graph-context).
3. Embedding similarity (cosine on descriptions) as tiebreaker.
4. For ≥ high threshold: write `SAME_AS` edge with full evidence and method.
5. For [medium, high): append to the `Reconciliation` queue for human arbitration.
6. For < medium: leave unresolved; schedule retry after N new signals.

## Output
- Count of new canonical entities
- Count of new `SAME_AS` edges
- Count of items queued for human review

## Refuse if
- Any input entity lacks a `source` or `sourceId` field — malformed input is a bug upstream, not a matching problem.
