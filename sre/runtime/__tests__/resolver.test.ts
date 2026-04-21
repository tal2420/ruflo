import { describe, it, expect } from "vitest";
import { resolve } from "../src/entity-resolver/index.js";
import type { SourceEntity } from "../src/entity-resolver/index.js";
import { paymentsApi, notifications, distantCousin } from "./fixtures/payments.js";

describe("resolve — end-to-end decisions", () => {
  it("auto-links dynatrace ↔ solarwinds on identical FQDN", () => {
    const r = resolve(paymentsApi.dynatrace, paymentsApi.solarwinds);
    expect(r.decision).toBe("link");
    expect(r.method).toBe("deterministic-fqdn");
    expect(r.confidence).toBe(1);
  });

  it("auto-links dynatrace ↔ bmcHelix via consensus (name + tags + graph-context)", () => {
    // No deterministic signal between these two — only probabilistic ones.
    const r = resolve(paymentsApi.dynatrace, paymentsApi.bmcHelix);
    expect(r.decision).toBe("link");
    expect(r.method).toMatch(/^consensus:/);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("auto-links bmcDiscovery ↔ dynatrace on identical repo URL", () => {
    const a = { ...paymentsApi.dynatrace, repoUrl: "https://github.com/corp/payments-api" };
    const r = resolve(a, paymentsApi.bmcDiscovery);
    expect(r.decision).toBe("link");
    expect(r.method).toBe("deterministic-repo");
  });

  it("queues when only one medium-confidence signal is present", () => {
    // Make entities share ONLY a name similarity, nothing else.
    const a: SourceEntity = {
      source: "dynatrace",
      sourceId: "S1",
      canonicalType: "Service",
      names: ["payments-api"],
      tags: {},
      observedAt: "2026-04-21T10:00:00Z",
    };
    const b: SourceEntity = {
      source: "bmc_helix",
      sourceId: "S2",
      canonicalType: "Service",
      names: ["Payments API"],
      tags: {},
      observedAt: "2026-04-21T10:00:00Z",
    };
    const r = resolve(a, b);
    expect(r.decision).toBe("queue");
    expect(r.reason).toMatch(/single_medium_signal/);
  });

  it("returns no-match when canonical types differ — cross-type linking is forbidden", () => {
    const a = { ...paymentsApi.dynatrace };
    const b: SourceEntity = { ...paymentsApi.solarwinds, canonicalType: "Host" };
    const r = resolve(a, b);
    expect(r.decision).toBe("no-match");
    expect(r.reason).toMatch(/type_mismatch/);
  });

  it("does not link two distinct services that merely share a team tag", () => {
    const r = resolve(paymentsApi.dynatrace, notifications.dynatrace);
    // Shared team+env (tags matcher) and possibly a low-similarity name are noise.
    // Expect either queue (one medium signal) or no-match — NEVER link.
    expect(r.decision).not.toBe("link");
  });

  it("does not link payments-api to inventory-worker despite same team/env", () => {
    const r = resolve(paymentsApi.dynatrace, distantCousin.dynatrace);
    expect(r.decision).not.toBe("link");
  });

  it("queues payments-api vs inventory-worker when they share only tags", () => {
    // Two matchers may fire weakly — tags overlap (team+env), name is dissimilar.
    // This is exactly the kind of case the reconciliation queue exists for.
    const r = resolve(distantCousin.dynatrace, distantCousin.bmcHelix);
    expect(r.decision).toBe("queue");
  });

  it("embedding alone cannot authorize a link — must be corroborated", () => {
    // Two entities with a perfect embedding match but no other signals.
    const v = [0.1, 0.2, 0.3, 0.4, 0.5];
    const a: SourceEntity = {
      source: "dynatrace",
      sourceId: "E1",
      canonicalType: "Service",
      names: ["unrelated-service-a"],
      tags: {},
      embedding: v,
      observedAt: "2026-04-21T10:00:00Z",
    };
    const b: SourceEntity = {
      source: "bmc_helix",
      sourceId: "E2",
      canonicalType: "Service",
      names: ["totally-different-name"],
      tags: {},
      embedding: v,
      observedAt: "2026-04-21T10:00:00Z",
    };
    const r = resolve(a, b);
    expect(r.decision).toBe("queue");
  });

  it("identity short-circuit: same source + sourceId returns link with confidence 1", () => {
    const r = resolve(paymentsApi.dynatrace, paymentsApi.dynatrace);
    expect(r.decision).toBe("link");
    expect(r.confidence).toBe(1);
    expect(r.method).toBe("identity");
  });

  it("populates votes on every decision so audits can reconstruct why", () => {
    const r = resolve(paymentsApi.dynatrace, paymentsApi.bmcHelix);
    expect(Array.isArray(r.votes)).toBe(true);
    expect(r.votes.length).toBeGreaterThan(0);
    for (const v of r.votes) {
      expect(v.matcher).toBeTruthy();
      expect(v.method).toBeTruthy();
      expect(typeof v.confidence).toBe("number");
    }
  });
});
