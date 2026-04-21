import type { SourceEntity, MatchVote } from "../types.js";

/** Levenshtein distance — classic DP. O(nm) space-optimized to O(min(n,m)). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure a is the shorter one.
  if (a.length > b.length) [a, b] = [b, a];
  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  let curr = new Array(a.length + 1).fill(0);
  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        curr[i - 1] + 1, // insert
        (prev[i] ?? 0) + 1, // delete
        (prev[i - 1] ?? 0) + cost, // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[a.length] ?? 0;
}

/** Normalizes a name for fuzzy comparison: lower, strip envs/region suffixes, collapse spaces/dashes. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(prod|production|stage|staging|dev|qa|us-east-\d|eu-west-\d)\b/g, "")
    .replace(/[-_\s]+/g, " ")
    .trim();
}

/**
 * Name similarity — compares the best pair across both entities' name lists.
 * Low Levenshtein on normalized names + overlap in team/owner tags → higher confidence.
 */
export function matchName(a: SourceEntity, b: SourceEntity): MatchVote | null {
  if (a.names.length === 0 || b.names.length === 0) return null;
  let bestRatio = 0;
  let bestPair: [string, string] | null = null;
  for (const an of a.names) {
    for (const bn of b.names) {
      const na = normalizeName(an);
      const nb = normalizeName(bn);
      if (!na || !nb) continue;
      const dist = levenshtein(na, nb);
      const ratio = 1 - dist / Math.max(na.length, nb.length);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestPair = [an, bn];
      }
    }
  }
  if (!bestPair) return null;

  // Boost when a shared team tag agrees.
  const teamA = a.tags["team"] ?? a.tags["owner"];
  const teamB = b.tags["team"] ?? b.tags["owner"];
  const teamBoost = teamA && teamA === teamB ? 0.08 : 0;

  const confidence = Math.min(1, Math.max(0, bestRatio + teamBoost));
  // Only emit a vote when the similarity is actually meaningful.
  if (confidence < 0.5) return null;

  return {
    matcher: "name",
    method: "probabilistic-name",
    confidence,
    evidence: `names="${bestPair[0]}" vs "${bestPair[1]}"${teamBoost ? " +team" : ""}`,
  };
}

/**
 * Tag overlap — counts tags that match exactly on key AND value. Ignores
 * well-known noisy tags (source, observedAt, ...).
 */
const IGNORE_TAGS = new Set([
  "source",
  "observedAt",
  "observed_at",
  "last_seen",
  "ingested_at",
]);

export function matchTags(a: SourceEntity, b: SourceEntity): MatchVote | null {
  let shared = 0;
  const evidence: string[] = [];
  for (const [k, v] of Object.entries(a.tags)) {
    if (IGNORE_TAGS.has(k)) continue;
    if (b.tags[k] === v) {
      shared += 1;
      if (evidence.length < 3) evidence.push(`${k}=${v}`);
    }
  }
  if (shared < 2) return null;
  const confidence = shared >= 3 ? 0.85 : 0.7;
  return {
    matcher: "tags",
    method: "probabilistic-tags",
    confidence,
    evidence: `shared=${shared}: ${evidence.join(", ")}`,
  };
}

/**
 * Graph-context similarity — shared proportion of already-linked neighbors.
 * Requires both entities to carry `neighborCanonicalIds`. Emits a vote only
 * when overlap is meaningful (≥3 shared or ≥50% overlap of the smaller set).
 */
export function matchGraphContext(
  a: SourceEntity,
  b: SourceEntity,
): MatchVote | null {
  const na = a.neighborCanonicalIds ?? [];
  const nb = b.neighborCanonicalIds ?? [];
  if (na.length === 0 || nb.length === 0) return null;
  const setA = new Set(na);
  let shared = 0;
  for (const id of nb) if (setA.has(id)) shared += 1;
  const smaller = Math.min(na.length, nb.length);
  const overlap = shared / smaller;
  if (shared < 3 && overlap < 0.5) return null;
  const confidence = shared >= 5 ? 0.9 : overlap >= 0.8 ? 0.85 : 0.75;
  return {
    matcher: "graph-context",
    method: "probabilistic-graph-context",
    confidence,
    evidence: `shared=${shared}/${smaller} (${Math.round(overlap * 100)}%)`,
  };
}

export const PROBABILISTIC_MATCHERS: Array<
  (a: SourceEntity, b: SourceEntity) => MatchVote | null
> = [matchName, matchTags, matchGraphContext];
