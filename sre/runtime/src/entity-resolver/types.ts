// Canonical-facing types for the entity resolver.
//
// These mirror sre/schema/entity_schema.json. Future work should generate them
// from the JSON Schema; for now they are hand-written and kept in sync.

export type SourceSystem =
  | "dynatrace"
  | "solarwinds"
  | "bmc_helix"
  | "bmc_discovery"
  | "doc"
  | "manual";

export type CanonicalType =
  | "Service"
  | "ProcessGroup"
  | "Host"
  | "Datacenter"
  | "Cluster"
  | "Database"
  | "Datastore"
  | "NetworkDevice"
  | "Interface"
  | "Subnet"
  | "VLAN"
  | "IpAssignment"
  | "AppMonitor"
  | "ConfigDrift"
  | "SoftwareInstance"
  | "BusinessApplicationInstance"
  | "BusinessService"
  | "BusinessProcess";

export interface K8sCoords {
  cluster: string;
  namespace: string;
  workload: string;
}

/** What a collector emits for a single source-system entity. */
export interface SourceEntity {
  source: SourceSystem;
  sourceId: string;
  canonicalType: CanonicalType;
  names: string[];
  tags: Record<string, string>;
  descriptions?: string[];

  // Deterministic identity anchors — each collector fills in whichever it has.
  fqdn?: string;
  awsArn?: string;
  gcpResourceName?: string;
  k8s?: K8sCoords;
  mac?: string;
  repoUrl?: string;

  /** IDs of already-resolved canonical entities this node links to. */
  neighborCanonicalIds?: string[];

  /** Optional precomputed description embedding (e.g., 384-dim MiniLM). */
  embedding?: number[];

  observedAt: string;
}

export interface MatchVote {
  matcher: string;
  method: string;
  confidence: number; // 0..1
  evidence: string;
}

export type MatchDecision = "link" | "queue" | "no-match";

export interface MatchResult {
  decision: MatchDecision;
  /** Overall confidence when decision is "link". Undefined otherwise. */
  confidence?: number;
  /** Summary method when decision is "link". */
  method?: string;
  /** Reason for queue/no-match. */
  reason?: string;
  votes: MatchVote[];
}

export interface Thresholds {
  /** Confidence at or above which a deterministic vote (or consensus avg) auto-links. */
  high: number;
  /** Confidence at or above which a vote counts toward consensus. */
  medium: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = Object.freeze({
  high: 0.9,
  medium: 0.75,
});

export interface ResolveOptions {
  thresholds?: Thresholds;
}
