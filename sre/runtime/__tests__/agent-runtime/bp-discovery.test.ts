import { describe, it, expect } from "vitest";
import {
  proposeBusinessProcesses,
  type TaggedEntity,
} from "../../src/agent-runtime/agents/bp-discovery.js";

function svc(id: string, ...tags: string[]): TaggedEntity {
  return { id, tagsFlat: tags };
}

describe("proposeBusinessProcesses", () => {
  it("picks up a clean dual-signal cluster and sets inferenceMethod accordingly", () => {
    const entities: TaggedEntity[] = [];
    for (let i = 0; i < 20; i++) {
      entities.push(
        svc(`dynatrace:S-${i}`, "APPLICATION=Maccabi_Online", "dt.host_group.id=App_MaccabiOnline", "env=prod"),
      );
    }
    const picks = proposeBusinessProcesses(entities, { minMembers: 5 });
    expect(picks[0]).toBeTruthy();
    const bp = picks[0]!;
    expect(bp.memberIds.length).toBe(20);
    expect(bp.inferenceMethod).toMatch(/dual-signal/);
    expect(bp.anchorTags).toHaveLength(2);
  });

  it("rejects candidates below minMembers", () => {
    const entities: TaggedEntity[] = [
      svc("dynatrace:A", "APPLICATION=tiny"),
      svc("dynatrace:B", "APPLICATION=tiny"),
    ];
    expect(proposeBusinessProcesses(entities, { minMembers: 5 })).toEqual([]);
  });

  it("rejects candidates above maxMembers (probably infra, not a process)", () => {
    const entities: TaggedEntity[] = [];
    for (let i = 0; i < 1200; i++) {
      entities.push(svc(`dynatrace:H-${i}`, "dt.host_group.id=Infra_ESB", "dt.owner=ESB"));
    }
    const picks = proposeBusinessProcesses(entities, { maxMembers: 500 });
    expect(picks).toEqual([]);
  });

  it("deduplicates overlapping candidates, keeping the better-ranked anchor key", () => {
    const entities: TaggedEntity[] = [];
    for (let i = 0; i < 15; i++) {
      // Every service carries both APPLICATION and dt.host_group.id — perfect overlap.
      entities.push(
        svc(`dynatrace:O-${i}`, "APPLICATION=portal_rofe", "dt.host_group.id=App_PortalRofe"),
      );
    }
    const picks = proposeBusinessProcesses(entities, { minMembers: 5 });
    // Only one candidate should survive de-duplication.
    expect(picks).toHaveLength(1);
    // APPLICATION ranks higher than dt.host_group.id in the default anchorKeys list.
    expect(picks[0]!.anchorTags[0]).toBe("APPLICATION=portal_rofe");
  });

  it("returns candidates sorted by score descending", () => {
    const entities: TaggedEntity[] = [];
    for (let i = 0; i < 30; i++) {
      entities.push(svc(`d:big-${i}`, "APPLICATION=big_app"));
    }
    for (let i = 0; i < 8; i++) {
      entities.push(svc(`d:small-${i}`, "APPLICATION=small_app"));
    }
    const picks = proposeBusinessProcesses(entities, { minMembers: 5 });
    expect(picks[0]!.name).toBe("big_app");
    expect(picks[1]!.name).toBe("small_app");
  });

  it("picks BMC-style business_service tags even without a host_group corroborator", () => {
    const entities: TaggedEntity[] = [];
    for (let i = 0; i < 10; i++) {
      entities.push(svc(`bmc_helix:CI-${i}`, "business_service=checkout"));
    }
    const picks = proposeBusinessProcesses(entities, { minMembers: 5 });
    expect(picks[0]).toBeTruthy();
    const bp = picks[0]!;
    expect(bp.name).toBe("checkout");
    expect(bp.inferenceMethod).toMatch(/tag-anchor/);
  });

  it("stable ids so re-running produces the same BusinessProcess id", () => {
    const entities: TaggedEntity[] = [];
    for (let i = 0; i < 10; i++) {
      entities.push(svc(`dynatrace:S-${i}`, "APPLICATION=My_App"));
    }
    const a = proposeBusinessProcesses(entities);
    const b = proposeBusinessProcesses(entities);
    expect(a[0]!.id).toBe(b[0]!.id);
    expect(a[0]!.id).toMatch(/^bp-application-my-app$/);
  });

  it("ignores non-anchor tag keys", () => {
    const entities: TaggedEntity[] = [];
    for (let i = 0; i < 20; i++) {
      entities.push(svc(`d:x-${i}`, "team=x", "env=prod")); // no anchor key
    }
    expect(proposeBusinessProcesses(entities)).toEqual([]);
  });

  it("respects custom anchor keys", () => {
    const entities: TaggedEntity[] = [];
    for (let i = 0; i < 8; i++) {
      entities.push(svc(`d:t-${i}`, "team=payments"));
    }
    const picks = proposeBusinessProcesses(entities, { anchorKeys: ["team"], minMembers: 5 });
    expect(picks).toHaveLength(1);
    expect(picks[0]!.name).toBe("payments");
  });
});
