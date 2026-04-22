// Reconciliation — the core of SREFlow's continuous-improvement model.
//
// A blind MERGE on each analyst run erases human curation and confuses "still
// supported by evidence" with "just overwritten." This module turns the BP
// knowledge base into something that *evolves*:
//
//   - Every auto-proposed field is gated by `lockedFields` — if a human locked
//     it, the new proposal is a logged-but-ignored suggestion.
//   - Every REALIZED_BY edge carries `firstSeen`, `lastSeen`, `evidence`,
//     `addedBy`, and `status` (active | stale | rejected). Next run refreshes
//     the ones still observed and marks the rest stale.
//   - Human-added or human-rejected edges have `lockedByHuman=true`. The
//     analyst never refreshes, removes, or re-adds them.
//
// The module is a pure function: it reads the current state of a BP (as
// fetched from Neo4j) and returns a list of structured actions the agent
// wrapper then applies. That keeps the decision logic testable without a
// graph, and keeps the write path small and auditable.

export type EdgeStatus = "active" | "stale" | "rejected";

export interface ExistingEdge {
  role?: string;
  status: EdgeStatus;
  addedBy: string;
  firstSeen: string;
  lastSeen: string;
  evidence?: string;
  lockedByHuman: boolean;
}

/**
 * The subset of a BusinessProcess node we read before reconciling. The agent
 * wrapper is responsible for turning the Neo4j record into this shape.
 */
export interface CurrentBpState {
  exists: boolean;
  /** Field names whose values must not be overwritten by auto-discovery. */
  lockedFields: string[];
  /** Components currently linked to this BP, keyed by canonical id. */
  components: Map<string, ExistingEdge>;
}

/** What the reconciliation wants to persist for this BP. */
export interface ProposedBp {
  id: string;
  fields: Record<string, unknown>;
  components: Array<{ id: string; role: string }>;
  /** Short human-readable source attribution — written onto each new edge. */
  evidence: string;
  /** Which agent (or "human:alice") is making this change. */
  addedBy: string;
}

export type ReconciliationAction =
  | { kind: "create-bp"; bpId: string; fields: Record<string, unknown> }
  | { kind: "refresh-bp"; bpId: string; fields: Record<string, unknown> }
  | { kind: "blocked-by-lock"; bpId: string; field: string; attempted: unknown }
  | {
      kind: "upsert-edge";
      bpId: string;
      componentId: string;
      role: string;
      evidence: string;
      addedBy: string;
      isNew: boolean;
    }
  | { kind: "mark-stale"; bpId: string; componentId: string; lastSeen: string }
  | { kind: "skip-locked-edge"; bpId: string; componentId: string }
  | { kind: "respect-rejection"; bpId: string; componentId: string };

export interface ReconcileInput {
  current: CurrentBpState;
  proposed: ProposedBp;
}

/**
 * Given the current state of a BP and a fresh auto-discovered proposal,
 * emit the minimal set of actions that should be applied to the graph.
 * The function is total: every component in either set is accounted for
 * by exactly one action.
 */
export function reconcile(input: ReconcileInput): ReconciliationAction[] {
  const { current, proposed } = input;
  const actions: ReconciliationAction[] = [];
  const locked = new Set(current.lockedFields);

  // ---- BP fields -----------------------------------------------------------
  const unlockedFields: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(proposed.fields)) {
    if (locked.has(field)) {
      actions.push({
        kind: "blocked-by-lock",
        bpId: proposed.id,
        field,
        attempted: value,
      });
      continue;
    }
    unlockedFields[field] = value;
  }

  if (!current.exists) {
    actions.push({ kind: "create-bp", bpId: proposed.id, fields: unlockedFields });
  } else {
    // refresh-bp is idempotent — always emit so lastSeen gets bumped at the
    // write layer even when no fields changed value.
    actions.push({ kind: "refresh-bp", bpId: proposed.id, fields: unlockedFields });
  }

  // ---- Edges: proposed ⇒ current ------------------------------------------
  const proposedIds = new Set(proposed.components.map((c) => c.id));
  for (const comp of proposed.components) {
    const existing = current.components.get(comp.id);
    if (existing?.status === "rejected") {
      // Whether or not the rejection was human-locked, don't re-add this run.
      // A human can later un-reject via `curate`.
      actions.push({
        kind: "respect-rejection",
        bpId: proposed.id,
        componentId: comp.id,
      });
      continue;
    }
    if (existing?.lockedByHuman) {
      // Human-added edge — trust humans. Analyst won't touch it.
      actions.push({
        kind: "skip-locked-edge",
        bpId: proposed.id,
        componentId: comp.id,
      });
      continue;
    }
    actions.push({
      kind: "upsert-edge",
      bpId: proposed.id,
      componentId: comp.id,
      role: comp.role,
      evidence: proposed.evidence,
      addedBy: proposed.addedBy,
      isNew: !existing,
    });
  }

  // ---- Edges: current ⇒ proposed (the "disappeared" set) -------------------
  // Anything currently linked that's NOT in the fresh proposal is candidate-stale.
  for (const [compId, existing] of current.components) {
    if (proposedIds.has(compId)) continue;
    if (existing.lockedByHuman) continue; // humans own this; don't touch
    if (existing.status === "stale") continue; // already marked
    if (existing.status === "rejected") continue; // irrelevant
    actions.push({
      kind: "mark-stale",
      bpId: proposed.id,
      componentId: compId,
      lastSeen: existing.lastSeen,
    });
  }

  return actions;
}
