# Continuous improvement of the BP knowledge base

SREFlow's business-process knowledge base is **not** rebuilt from scratch on each
analyst run. It evolves: every auto-run reconciles fresh signals against the
current state, preserves human curation, and records what changed.

This doc explains the model and the operator UX.

## Invariants

1. **Evidence-bearing edges.** Every `REALIZED_BY` relationship carries
   `firstSeen`, `lastSeen`, `addedBy`, `evidence`, `status`. `status` is
   one of `active`, `stale`, `rejected`. Values are set by the writer
   (the analyst or a human via `curate`) and read by readers to assess
   trust.

2. **Human decisions are sticky.** A `BusinessProcess` node carries a
   `lockedFields` list. Any field in that list is never overwritten by
   auto-discovery. A `REALIZED_BY` edge with `lockedByHuman = true` is
   never refreshed, rejected, or marked stale by the analyst.

3. **Soft delete, never hard.** A component that was observed before but
   isn't in this run's proposal is marked `status = "stale"` — the edge
   stays, its last-seen timestamp freezes. A human can `--add-component`
   it back (re-activating) or leave it to age out.

4. **Rejection memory.** A component a human removed via `curate … --remove-component` is marked `status = "rejected"` *and* `lockedByHuman = true`. Next analyst run sees the rejection and does not re-propose the link.

5. **Totality.** The reconciler's input is (current state, fresh proposal).
   Its output is a total action set: every component id that appears in
   either is handled exactly once.

## The reconciliation decision table

| Current edge | Proposal sees it? | Action |
|---|---|---|
| *(not present)* | yes | `upsert-edge` (isNew=true) — new link |
| `active`, auto | yes | `upsert-edge` (isNew=false) — refresh `lastSeen`, evidence |
| `active`, auto | no | `mark-stale` — keeps edge, freezes `lastSeen` |
| `active`, human-locked | yes | `skip-locked-edge` — analyst does not touch |
| `active`, human-locked | no | *(nothing)* — humans own this edge |
| `stale`, auto | yes | `upsert-edge` → reactivates (status=active) |
| `stale`, auto | no | *(nothing)* — already stale |
| `rejected` | yes | `respect-rejection` — never re-add |
| `rejected` | no | *(nothing)* |

For BP fields, it's simpler: locked fields yield `blocked-by-lock` log
entries; unlocked fields flow through `refresh-bp` unchanged.

## Operator UX

### Re-run the analyst (routinely — cron or on-demand)

```bash
npx tsx bin/sreflow-agent.ts run business-process-analyst --env corp
# ... report ends with:
# ▶ Evolution: +3 new components · 7 marked stale · 2 field(s) preserved by human lock
```

### Curate a BP manually

```bash
# Rename + lock + promote to tier-1 + reject an incorrect downstream + leave a note
npx tsx bin/sreflow-agent.ts curate bp-feature-medical-file \
  --name "View Medical File" \
  --name-he "צפייה בתיק רפואי אישי" \
  --tier 1 \
  --lock name,nameHe,criticalityTier \
  --note "Member-facing tier-1 per clinical PM review 2026-04-22" \
  --remove-component canonical-dynatrace-SERVICE_6895BA1AC4F7B136 \
  --evidence "alice-pm:SRE-2026-0422" \
  --user alice
```

Next analyst run will attempt to overwrite the English name, Hebrew name,
and tier with its auto-proposals — and log `locked=[name,nameHe,criticalityTier]`
in the evolution footer while leaving the human values intact.

### Ask what changed

```bash
npx tsx bin/sreflow-agent.ts report changes --since 24h
# Lists newly-added components + components marked stale in the window.

npx tsx bin/sreflow-agent.ts report stale
# All currently-stale components (candidates for human cleanup).

npx tsx bin/sreflow-agent.ts report locked
# Every BP with at least one locked field, and who locked them.

npx tsx bin/sreflow-agent.ts report curated --since 7d
# All curation events in the last week.
```

## Where future signals plug in

This reconciliation foundation makes these layers a small addition rather
than a rewrite:

- **Doc extraction hints** (Confluence / HLD markup). A `doc-hints` agent
  emits proposed BPs with `addedBy = "doc:<pageId>"`. Reconciliation treats
  them as a second automation source — same invariants, different evidence.
- **Incident post-mortems.** "During INC-1234, we learned service X is
  actually part of process Y" becomes a `curate` call with the ticket URL
  as evidence.
- **LLM naming.** Rename ugly auto-names like `Maccabi.Mdoc.Components.Drugs Approvals`
  to `Drug Approval Workflow (Clinician)` using a bulk LLM pass. The rename
  goes through `curate --name ... --lock name` so the analyst can't undo it.

## Signals the BP KB emits back

Beyond the stored state, the analyst prints a one-line evolution footer:

```
▶ Evolution: +3 new components · 7 marked stale · 2 field(s) preserved by human lock
```

Dashboards and alerts can key off this to notice when auto-discovery drifts
from human curation faster than expected — a useful signal that the upstream
data quality (Dynatrace tags, call graphs) has changed.
