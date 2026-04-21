import type { SourceEntity } from "../../src/entity-resolver/types.js";

// Synthetic "payments-api" service seen across four source systems.
// Each fixture represents the same real-world thing as it appears in each system,
// with the identifier shapes that system actually uses.

export const paymentsApi = {
  dynatrace: <SourceEntity>{
    source: "dynatrace",
    sourceId: "SERVICE-ABC123",
    canonicalType: "Service",
    names: ["payments-api-prod"],
    tags: { team: "payments", env: "prod", tier: "1" },
    descriptions: ["Handles card authorisation and capture for checkout."],
    fqdn: "payments-api.prod.corp.internal",
    k8s: { cluster: "prod-us-east-1", namespace: "payments", workload: "payments-api" },
    neighborCanonicalIds: ["canonical-db-payments", "canonical-queue-payments"],
    observedAt: "2026-04-21T10:00:00Z",
  },

  solarwinds: <SourceEntity>{
    source: "solarwinds",
    sourceId: "NODE-7421",
    canonicalType: "Service",
    names: ["payments-api.prod.corp.internal"],
    tags: { team: "payments", env: "prod" },
    fqdn: "payments-api.prod.corp.internal",
    observedAt: "2026-04-21T10:00:00Z",
  },

  bmcHelix: <SourceEntity>{
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
    descriptions: ["Tier-1 business service realised by the Payments API application."],
    neighborCanonicalIds: ["canonical-db-payments"],
    observedAt: "2026-04-21T10:00:00Z",
  },

  bmcDiscovery: <SourceEntity>{
    source: "bmc_discovery",
    sourceId: "DISC-9a8f",
    canonicalType: "Service",
    names: ["payments-api"],
    tags: { team: "payments", env: "prod" },
    repoUrl: "https://github.com/corp/payments-api",
    observedAt: "2026-04-21T10:00:00Z",
  },
};

// Two distinct services that happen to share a team tag — name similarity alone
// should NOT auto-link them.
export const notifications = {
  dynatrace: <SourceEntity>{
    source: "dynatrace",
    sourceId: "SERVICE-XYZ999",
    canonicalType: "Service",
    names: ["notifications-api-prod"],
    tags: { team: "payments", env: "prod", tier: "2" },
    fqdn: "notifications-api.prod.corp.internal",
    observedAt: "2026-04-21T10:00:00Z",
  },
};

// Same team, very different service — embedding similarity should not save them.
export const distantCousin = {
  dynatrace: <SourceEntity>{
    source: "dynatrace",
    sourceId: "SERVICE-DEF789",
    canonicalType: "Service",
    names: ["inventory-worker-prod"],
    tags: { team: "payments", env: "prod" },
    fqdn: "inventory-worker.prod.corp.internal",
    observedAt: "2026-04-21T10:00:00Z",
  },
  bmcHelix: <SourceEntity>{
    source: "bmc_helix",
    sourceId: "CI-0009999",
    canonicalType: "Service",
    names: ["Inventory Worker"],
    tags: { team: "payments", env: "prod", tier: "2" },
    observedAt: "2026-04-21T10:00:00Z",
  },
};
