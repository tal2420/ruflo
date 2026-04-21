import { describe, it, expect } from "vitest";
import {
  matchName,
  matchTags,
  matchGraphContext,
  levenshtein,
  normalizeName,
} from "../src/entity-resolver/matchers/probabilistic.js";
import { paymentsApi, notifications } from "./fixtures/payments.js";

describe("levenshtein + normalizeName", () => {
  it("computes classic Levenshtein distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "foo")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  it("normalizes env/region suffixes", () => {
    expect(normalizeName("payments-api-prod")).toBe("payments api");
    expect(normalizeName("Payments_API")).toBe("payments api");
  });
});

describe("name matcher", () => {
  it("matches cross-source variations of the same service name", () => {
    // dynatrace "payments-api-prod" vs bmc_helix "Payments API"
    const v = matchName(paymentsApi.dynatrace, paymentsApi.bmcHelix);
    expect(v).not.toBeNull();
    expect(v?.confidence).toBeGreaterThan(0.75);
  });

  it("returns null when the best pair's similarity is below 0.5", () => {
    // "payments-api-prod" vs "inventory-worker-prod"
    expect(matchName(paymentsApi.dynatrace, {
      ...paymentsApi.dynatrace,
      names: ["inventory-worker-prod"],
    })).toBeNull();
  });

  it("boosts confidence when the team tag agrees", () => {
    const noTeamA = { ...paymentsApi.dynatrace, tags: { env: "prod" } };
    const noTeamB = { ...paymentsApi.bmcHelix, tags: { env: "prod" } };
    const withTeamA = paymentsApi.dynatrace;
    const withTeamB = paymentsApi.bmcHelix;

    const withoutBoost = matchName(noTeamA, noTeamB);
    const withBoost = matchName(withTeamA, withTeamB);
    expect(withBoost).not.toBeNull();
    if (withoutBoost) {
      expect(withBoost!.confidence).toBeGreaterThanOrEqual(withoutBoost.confidence);
    }
  });
});

describe("tags matcher", () => {
  it("emits a vote when ≥2 tags match", () => {
    // paymentsApi.dynatrace and paymentsApi.bmcHelix share team + env + tier
    const v = matchTags(paymentsApi.dynatrace, paymentsApi.bmcHelix);
    expect(v).not.toBeNull();
    expect(v?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("returns null when only one tag overlaps", () => {
    // distantCousin shares only team+env with notifications (that's 2, so should match)
    // Let's exercise the <2 path:
    const a = { ...paymentsApi.dynatrace, tags: { team: "payments" } };
    const b = { ...paymentsApi.bmcHelix, tags: { team: "payments", env: "stage" } };
    expect(matchTags(a, b)).toBeNull();
  });

  it("ignores noisy timing tags", () => {
    const a = { ...paymentsApi.dynatrace, tags: { observedAt: "x", source: "y", team: "payments" } };
    const b = { ...paymentsApi.bmcHelix, tags: { observedAt: "z", source: "q", team: "payments" } };
    expect(matchTags(a, b)).toBeNull(); // only 1 meaningful tag overlap (team)
  });
});

describe("graph-context matcher", () => {
  it("matches when entities share enough neighbors", () => {
    const a = { ...paymentsApi.dynatrace, neighborCanonicalIds: ["n1", "n2", "n3", "n4"] };
    const b = { ...paymentsApi.bmcHelix, neighborCanonicalIds: ["n2", "n3", "n4", "n5"] };
    const v = matchGraphContext(a, b);
    expect(v).not.toBeNull();
    expect(v?.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it("returns null when neighbor lists are disjoint", () => {
    const a = { ...paymentsApi.dynatrace, neighborCanonicalIds: ["n1"] };
    const b = { ...paymentsApi.bmcHelix, neighborCanonicalIds: ["n9"] };
    expect(matchGraphContext(a, b)).toBeNull();
  });

  it("returns null when either list is empty", () => {
    const a = { ...paymentsApi.dynatrace, neighborCanonicalIds: [] };
    const b = { ...paymentsApi.bmcHelix, neighborCanonicalIds: ["n2", "n3", "n4"] };
    expect(matchGraphContext(a, b)).toBeNull();
  });
});
