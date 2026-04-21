---
name: triage-incident
description: Read-only incident context assembly. Pulls the affected component subgraph, recent changes, relevant runbooks, and similar past incidents, then drafts a concise brief. Never executes remediation.
---

# triage-incident

Invoked on page by the incident-commander, or manually by an on-call engineer via `/sre-incident`.

## Inputs
- `pageId` (string) or `{ service, timeWindow }` pair.

## Steps
1. Resolve the affected canonical entity from the page payload or from the user-supplied service name.
2. Pull the containing `BusinessProcess` and its component subgraph.
3. Fetch all `Change` nodes closed in the incident window ± 4h that `IMPACTED_BY` the subgraph.
4. RAG-retrieve the 5 most similar past incidents (by embedding on symptoms + topology).
5. RAG-retrieve relevant runbooks (pinned tier-1 runbooks first).
6. Compose a ≤500 word brief:
   - What's affected (business process + user impact)
   - Signals (from Dynatrace/Prometheus/logs — summarized)
   - Recent changes
   - Candidate hypotheses (with evidence references)
   - Suggested next diagnostic steps — all read-only
   - Pointers to similar past incidents

## Output
- The brief as markdown
- A structured `IncidentContext` object for downstream specialist agents
- No tool calls beyond reads

## Refuse if
- The caller attempts to pass a remediation plan in the input — that is not this skill's job; direct them to the commander's proposal flow.
