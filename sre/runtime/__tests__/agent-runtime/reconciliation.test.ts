import { describe, it, expect } from "vitest";
import {
  reconcile,
  type CurrentBpState,
  type ExistingEdge,
  type ProposedBp,
  type ReconciliationAction,
} from "../../src/agent-runtime/agents/reconciliation.js";

function mkEdge(overrides: Partial<ExistingEdge> = {}): ExistingEdge {
  return {
    role: "core",
    status: "active",
    addedBy: "business-process-analyst",
    firstSeen: "2026-04-01T00:00:00Z",
    lastSeen: "2026-04-20T00:00:00Z",
    evidence: "auto",
    lockedByHuman: false,
    ...overrides,
  };
}

function mkCurrent(overrides: Partial<CurrentBpState> = {}): CurrentBpState {
  return {
    exists: true,
    lockedFields: [],
    components: new Map(),
    ...overrides,
  };
}

function mkProposal(overrides: Partial<ProposedBp> = {}): ProposedBp {
  return {
    id: "bp-feature-x",
    fields: { name: "X", criticalityTier: 2 },
    components: [],
    evidence: "auto @ now",
    addedBy: "business-process-analyst",
    ...overrides,
  };
}

function only<T extends ReconciliationAction["kind"]>(
  actions: ReconciliationAction[],
  kind: T,
): Extract<ReconciliationAction, { kind: T }>[] {
  return actions.filter((a) => a.kind === kind) as Extract<ReconciliationAction, { kind: T }>[];
}

// ----------------------------------------------------------------------------

describe("reconcile — BP field locking", () => {
  it("creates a new BP when none exists", () => {
    const actions = reconcile({
      current: { exists: false, lockedFields: [], components: new Map() },
      proposed: mkProposal({ fields: { name: "New", nameHe: "חדש" } }),
    });
    const creates = only(actions, "create-bp");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.fields).toEqual({ name: "New", nameHe: "חדש" });
  });

  it("refreshes an existing BP, keeping locked fields intact", () => {
    const actions = reconcile({
      current: mkCurrent({ lockedFields: ["name", "nameHe"] }),
      proposed: mkProposal({
        fields: { name: "AutoName", nameHe: "שם אוטומטי", criticalityTier: 1 },
      }),
    });
    const refresh = only(actions, "refresh-bp")[0]!;
    // locked fields are stripped from the write payload
    expect(refresh.fields).not.toHaveProperty("name");
    expect(refresh.fields).not.toHaveProperty("nameHe");
    expect(refresh.fields).toHaveProperty("criticalityTier", 1);
    // and each blocked field is surfaced as a log entry
    const blocked = only(actions, "blocked-by-lock").map((a) => a.field).sort();
    expect(blocked).toEqual(["name", "nameHe"]);
  });

  it("emits nothing for fields that aren't proposed", () => {
    const actions = reconcile({
      current: mkCurrent({ lockedFields: ["criticalityTier"] }),
      proposed: mkProposal({ fields: { name: "Only name" } }),
    });
    expect(only(actions, "blocked-by-lock")).toHaveLength(0);
    expect(only(actions, "refresh-bp")[0]!.fields).toEqual({ name: "Only name" });
  });
});

describe("reconcile — edge reconciliation", () => {
  it("marks a new edge as isNew and upserts it", () => {
    const actions = reconcile({
      current: mkCurrent(),
      proposed: mkProposal({
        components: [{ id: "canonical-A", role: "core" }],
      }),
    });
    const up = only(actions, "upsert-edge")[0]!;
    expect(up.isNew).toBe(true);
    expect(up.role).toBe("core");
    expect(up.evidence).toBe("auto @ now");
  });

  it("refreshes an already-present edge (isNew=false)", () => {
    const actions = reconcile({
      current: mkCurrent({ components: new Map([["canonical-A", mkEdge()]]) }),
      proposed: mkProposal({
        components: [{ id: "canonical-A", role: "core" }],
      }),
    });
    const up = only(actions, "upsert-edge")[0]!;
    expect(up.isNew).toBe(false);
  });

  it("marks an existing edge stale when it isn't in the proposal", () => {
    const actions = reconcile({
      current: mkCurrent({ components: new Map([["canonical-X", mkEdge()]]) }),
      proposed: mkProposal({ components: [{ id: "canonical-Y", role: "core" }] }),
    });
    const stale = only(actions, "mark-stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]!.componentId).toBe("canonical-X");
    // Y is newly upserted
    expect(only(actions, "upsert-edge")[0]!.componentId).toBe("canonical-Y");
  });

  it("does not mark a human-locked edge stale even if it's missing from the proposal", () => {
    const actions = reconcile({
      current: mkCurrent({
        components: new Map([
          ["canonical-HUMAN", mkEdge({ lockedByHuman: true, addedBy: "human:alice" })],
        ]),
      }),
      proposed: mkProposal({ components: [] }),
    });
    expect(only(actions, "mark-stale")).toHaveLength(0);
  });

  it("skips a human-locked edge when the analyst proposes the same component", () => {
    const actions = reconcile({
      current: mkCurrent({
        components: new Map([
          ["canonical-H", mkEdge({ lockedByHuman: true, role: "downstream" })],
        ]),
      }),
      proposed: mkProposal({
        components: [{ id: "canonical-H", role: "core" }],
      }),
    });
    expect(only(actions, "skip-locked-edge")).toHaveLength(1);
    expect(only(actions, "upsert-edge")).toHaveLength(0);
  });

  it("respects a rejected edge — does not re-upsert even when proposed again", () => {
    const actions = reconcile({
      current: mkCurrent({
        components: new Map([
          ["canonical-R", mkEdge({ status: "rejected", addedBy: "human:alice" })],
        ]),
      }),
      proposed: mkProposal({
        components: [{ id: "canonical-R", role: "core" }],
      }),
    });
    expect(only(actions, "respect-rejection")).toHaveLength(1);
    expect(only(actions, "upsert-edge")).toHaveLength(0);
  });

  it("leaves an already-stale edge alone (no re-mark)", () => {
    const actions = reconcile({
      current: mkCurrent({
        components: new Map([["canonical-S", mkEdge({ status: "stale" })]]),
      }),
      proposed: mkProposal({ components: [] }),
    });
    expect(only(actions, "mark-stale")).toHaveLength(0);
  });

  it("restores a previously-stale edge when the evidence returns (no longer stale)", () => {
    const actions = reconcile({
      current: mkCurrent({
        components: new Map([["canonical-S", mkEdge({ status: "stale" })]]),
      }),
      proposed: mkProposal({
        components: [{ id: "canonical-S", role: "downstream" }],
      }),
    });
    // Upsert path handles re-activation (the write layer will SET status=active).
    expect(only(actions, "upsert-edge")).toHaveLength(1);
    expect(only(actions, "mark-stale")).toHaveLength(0);
  });
});

describe("reconcile — totality", () => {
  it("every proposed component AND every current component gets exactly one action", () => {
    const currentIds = ["c-A", "c-B", "c-C"];
    const proposedIds = ["c-B", "c-C", "c-D"];
    const current = mkCurrent({
      components: new Map(currentIds.map((id) => [id, mkEdge()])),
    });
    const proposed = mkProposal({
      components: proposedIds.map((id) => ({ id, role: "core" })),
    });
    const actions = reconcile({ current, proposed });
    const touched = new Set<string>();
    for (const a of actions) {
      if ("componentId" in a) touched.add(a.componentId);
    }
    const union = new Set([...currentIds, ...proposedIds]);
    expect(touched).toEqual(union);
  });
});
