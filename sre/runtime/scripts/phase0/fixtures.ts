// Phase-0 fixtures — synthetic multi-source entities representing a small
// "Sandbox Checkout" business process. Replace with real collector output
// when connecting to live Dynatrace/BMC/SolarWinds tenants.

import type { SourceEntity } from "../../src/entity-resolver/types.js";

const now = "2026-04-21T10:00:00Z";

export const dynatraceEntities: SourceEntity[] = [
  {
    source: "dynatrace",
    sourceId: "SERVICE-ABC123",
    canonicalType: "Service",
    names: ["payments-api-prod"],
    tags: { team: "payments", env: "prod", tier: "1" },
    fqdn: "payments-api.prod.corp.internal",
    k8s: { cluster: "prod-us-east-1", namespace: "payments", workload: "payments-api" },
    observedAt: now,
  },
  {
    source: "dynatrace",
    sourceId: "SERVICE-DEF456",
    canonicalType: "Service",
    names: ["orders-api-prod"],
    tags: { team: "orders", env: "prod", tier: "1" },
    fqdn: "orders-api.prod.corp.internal",
    repoUrl: "https://github.com/corp/orders-api",
    observedAt: now,
  },
  {
    source: "dynatrace",
    sourceId: "SERVICE-GHI789",
    canonicalType: "Service",
    names: ["checkout-web-prod"],
    tags: { team: "checkout", env: "prod", tier: "1" },
    fqdn: "checkout-web.prod.corp.internal",
    observedAt: now,
  },
  {
    source: "dynatrace",
    sourceId: "SERVICE-JKL012",
    canonicalType: "Service",
    names: ["payments-db-primary"],
    tags: { team: "payments", env: "prod", tier: "1", role: "database" },
    observedAt: now,
  },
];

export const bmcHelixEntities: SourceEntity[] = [
  {
    source: "bmc_helix",
    sourceId: "CI-0000456",
    canonicalType: "Service",
    names: ["Payments API (Production)", "Payments API"],
    tags: {
      team: "payments",
      env: "prod",
      tier: "1",
      business_service: "checkout",
    },
    k8s: { cluster: "prod-us-east-1", namespace: "payments", workload: "payments-api" },
    observedAt: now,
  },
  {
    source: "bmc_helix",
    sourceId: "CI-0000789",
    canonicalType: "Service",
    names: ["Orders API"],
    tags: {
      team: "orders",
      env: "prod",
      tier: "1",
      business_service: "checkout",
    },
    fqdn: "orders-api.prod.corp.internal",
    observedAt: now,
  },
  {
    source: "bmc_helix",
    sourceId: "CI-0000999",
    canonicalType: "Database",
    names: ["Payments Primary DB"],
    tags: { team: "payments", env: "prod", tier: "1" },
    observedAt: now,
  },
];

export const solarWindsEntities: SourceEntity[] = [
  {
    source: "solarwinds",
    sourceId: "NODE-7421",
    canonicalType: "Service",
    names: ["payments-api.prod.corp.internal"],
    tags: { team: "payments", env: "prod" },
    fqdn: "payments-api.prod.corp.internal",
    observedAt: now,
  },
];

export const allSourceEntities: SourceEntity[] = [
  ...dynatraceEntities,
  ...bmcHelixEntities,
  ...solarWindsEntities,
];
