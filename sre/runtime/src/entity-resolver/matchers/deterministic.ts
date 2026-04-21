import type { SourceEntity, MatchVote } from "../types.js";

/** Returns a high-confidence vote if both entities share a FQDN. */
export function matchFqdn(a: SourceEntity, b: SourceEntity): MatchVote | null {
  if (!a.fqdn || !b.fqdn) return null;
  if (a.fqdn.toLowerCase() !== b.fqdn.toLowerCase()) return null;
  return {
    matcher: "fqdn",
    method: "deterministic-fqdn",
    confidence: 1,
    evidence: `fqdn="${a.fqdn}"`,
  };
}

/** Returns a high-confidence vote if both entities share an AWS ARN or GCP resource name. */
export function matchCloudResource(
  a: SourceEntity,
  b: SourceEntity,
): MatchVote | null {
  if (a.awsArn && b.awsArn && a.awsArn === b.awsArn) {
    return {
      matcher: "cloud-arn",
      method: "deterministic-arn",
      confidence: 1,
      evidence: `arn="${a.awsArn}"`,
    };
  }
  if (
    a.gcpResourceName &&
    b.gcpResourceName &&
    a.gcpResourceName === b.gcpResourceName
  ) {
    return {
      matcher: "cloud-gcp",
      method: "deterministic-arn",
      confidence: 1,
      evidence: `gcp="${a.gcpResourceName}"`,
    };
  }
  return null;
}

/** Returns a high-confidence vote if both entities share the Kubernetes (cluster, namespace, workload) triple. */
export function matchK8s(a: SourceEntity, b: SourceEntity): MatchVote | null {
  if (!a.k8s || !b.k8s) return null;
  if (
    a.k8s.cluster !== b.k8s.cluster ||
    a.k8s.namespace !== b.k8s.namespace ||
    a.k8s.workload !== b.k8s.workload
  ) {
    return null;
  }
  return {
    matcher: "k8s",
    method: "deterministic-k8s",
    confidence: 1,
    evidence: `k8s=${a.k8s.cluster}/${a.k8s.namespace}/${a.k8s.workload}`,
  };
}

/** Returns a high-confidence vote if both entities share a MAC address. */
export function matchMac(a: SourceEntity, b: SourceEntity): MatchVote | null {
  if (!a.mac || !b.mac) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (norm(a.mac) !== norm(b.mac)) return null;
  return {
    matcher: "mac",
    method: "deterministic-mac",
    confidence: 1,
    evidence: `mac="${a.mac}"`,
  };
}

/** Returns a high-confidence vote if both entities share a git repo URL. */
export function matchRepo(a: SourceEntity, b: SourceEntity): MatchVote | null {
  if (!a.repoUrl || !b.repoUrl) return null;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
  if (norm(a.repoUrl) !== norm(b.repoUrl)) return null;
  return {
    matcher: "repo",
    method: "deterministic-repo",
    confidence: 1,
    evidence: `repo="${a.repoUrl}"`,
  };
}

/**
 * Returns a high-confidence vote if either entity carries an explicit `same_as` tag
 * that points at the other's sourceId. Shape expected: `same_as:<source>:<sourceId>`.
 */
export function matchSameAsTag(
  a: SourceEntity,
  b: SourceEntity,
): MatchVote | null {
  const pointsTo = (x: SourceEntity, y: SourceEntity): boolean => {
    const tag = x.tags["same_as"];
    if (!tag) return false;
    const expected = `${y.source}:${y.sourceId}`;
    return tag === expected || tag === y.sourceId;
  };
  if (pointsTo(a, b) || pointsTo(b, a)) {
    return {
      matcher: "same-as-tag",
      method: "tag-same_as",
      confidence: 1,
      evidence: "same_as tag present",
    };
  }
  return null;
}

/** All deterministic matchers, in evaluation order. */
export const DETERMINISTIC_MATCHERS: Array<
  (a: SourceEntity, b: SourceEntity) => MatchVote | null
> = [
  matchSameAsTag,
  matchFqdn,
  matchCloudResource,
  matchK8s,
  matchMac,
  matchRepo,
];
