import { describe, it, expect } from "vitest";
import {
  matchFqdn,
  matchCloudResource,
  matchK8s,
  matchMac,
  matchRepo,
  matchSameAsTag,
} from "../src/entity-resolver/matchers/deterministic.js";
import { paymentsApi, notifications } from "./fixtures/payments.js";

describe("deterministic matchers", () => {
  it("matches on identical FQDN (case-insensitive)", () => {
    const v = matchFqdn(paymentsApi.dynatrace, paymentsApi.solarwinds);
    expect(v).not.toBeNull();
    expect(v?.confidence).toBe(1);
    expect(v?.method).toBe("deterministic-fqdn");
  });

  it("does not match on different FQDNs", () => {
    const v = matchFqdn(paymentsApi.dynatrace, notifications.dynatrace);
    expect(v).toBeNull();
  });

  it("returns null when either FQDN is missing", () => {
    expect(matchFqdn(paymentsApi.dynatrace, paymentsApi.bmcHelix)).toBeNull();
    expect(matchFqdn(paymentsApi.bmcHelix, paymentsApi.dynatrace)).toBeNull();
  });

  it("matches on identical AWS ARN", () => {
    const a = { ...paymentsApi.dynatrace, awsArn: "arn:aws:lambda:us-east-1:111:function:payments" };
    const b = { ...paymentsApi.solarwinds, awsArn: "arn:aws:lambda:us-east-1:111:function:payments", fqdn: undefined };
    const v = matchCloudResource(a, b);
    expect(v?.confidence).toBe(1);
    expect(v?.method).toBe("deterministic-arn");
  });

  it("matches on identical GCP resource name", () => {
    const a = { ...paymentsApi.dynatrace, gcpResourceName: "projects/corp/locations/us/services/payments" };
    const b = { ...paymentsApi.solarwinds, gcpResourceName: "projects/corp/locations/us/services/payments", fqdn: undefined };
    expect(matchCloudResource(a, b)?.confidence).toBe(1);
  });

  it("matches on (cluster, namespace, workload) triple", () => {
    const a = paymentsApi.dynatrace;
    const b = {
      ...paymentsApi.bmcHelix,
      k8s: { cluster: "prod-us-east-1", namespace: "payments", workload: "payments-api" },
    };
    const v = matchK8s(a, b);
    expect(v?.confidence).toBe(1);
    expect(v?.method).toBe("deterministic-k8s");
  });

  it("rejects when any k8s coord differs", () => {
    const a = paymentsApi.dynatrace;
    const b = {
      ...paymentsApi.bmcHelix,
      k8s: { cluster: "prod-us-east-1", namespace: "payments", workload: "DIFFERENT" },
    };
    expect(matchK8s(a, b)).toBeNull();
  });

  it("matches MAC addresses with different formatting", () => {
    const a = { ...paymentsApi.dynatrace, mac: "AA:BB:CC:11:22:33" };
    const b = { ...paymentsApi.solarwinds, mac: "aa-bb-cc-11-22-33", fqdn: undefined };
    expect(matchMac(a, b)?.confidence).toBe(1);
  });

  it("matches repo URLs ignoring trailing slash and .git suffix", () => {
    const a = { ...paymentsApi.bmcDiscovery, repoUrl: "https://github.com/corp/payments-api.git" };
    const b = { ...paymentsApi.dynatrace, repoUrl: "https://github.com/corp/payments-api/" };
    expect(matchRepo(a, b)?.confidence).toBe(1);
  });

  it("matches on explicit same_as tag (either direction)", () => {
    const a = { ...paymentsApi.dynatrace, tags: { ...paymentsApi.dynatrace.tags, same_as: "bmc_helix:CI-0000456" } };
    const b = paymentsApi.bmcHelix;
    expect(matchSameAsTag(a, b)?.confidence).toBe(1);
    // And swap order
    expect(matchSameAsTag(b, a)?.confidence).toBe(1);
  });
});
