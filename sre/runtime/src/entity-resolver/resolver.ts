import type {
  SourceEntity,
  MatchResult,
  MatchVote,
  ResolveOptions,
} from "./types.js";
import { DEFAULT_THRESHOLDS } from "./types.js";
import { DETERMINISTIC_MATCHERS } from "./matchers/deterministic.js";
import { PROBABILISTIC_MATCHERS } from "./matchers/probabilistic.js";
import { matchEmbedding } from "./matchers/embedding.js";

/**
 * Decide whether two source-system entities refer to the same real-world thing.
 *
 * Pipeline (from sre/agents/graph/entity-resolver.md):
 *   1. Deterministic matchers — first high-confidence hit auto-links.
 *   2. Structured probabilistic + embedding — votes aggregated.
 *   3. Consensus — ≥2 votes ≥ medium threshold AND their mean ≥ high threshold → link.
 *   4. Otherwise → queue (single medium signal) or no-match.
 *
 * Canonical types must agree. Different types never link — entity resolution
 * operates within a type.
 */
export function resolve(
  a: SourceEntity,
  b: SourceEntity,
  opts: ResolveOptions = {},
): MatchResult {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  if (a.canonicalType !== b.canonicalType) {
    return {
      decision: "no-match",
      reason: `type_mismatch: ${a.canonicalType} vs ${b.canonicalType}`,
      votes: [],
    };
  }

  // Short-circuit identity: same source + same sourceId = trivially the same.
  if (a.source === b.source && a.sourceId === b.sourceId) {
    return {
      decision: "link",
      confidence: 1,
      method: "identity",
      votes: [
        {
          matcher: "identity",
          method: "identity",
          confidence: 1,
          evidence: `${a.source}:${a.sourceId}`,
        },
      ],
    };
  }

  const votes: MatchVote[] = [];

  for (const matcher of DETERMINISTIC_MATCHERS) {
    const v = matcher(a, b);
    if (!v) continue;
    votes.push(v);
    if (v.confidence >= thresholds.high) {
      return {
        decision: "link",
        confidence: v.confidence,
        method: v.method,
        votes,
      };
    }
  }

  for (const matcher of PROBABILISTIC_MATCHERS) {
    const v = matcher(a, b);
    if (v) votes.push(v);
  }

  const emb = matchEmbedding(a, b);
  if (emb) votes.push(emb);

  const aboveMedium = votes.filter((v) => v.confidence >= thresholds.medium);

  if (aboveMedium.length >= 2) {
    const mean =
      aboveMedium.reduce((s, v) => s + v.confidence, 0) / aboveMedium.length;
    if (mean >= thresholds.high) {
      return {
        decision: "link",
        confidence: mean,
        method: `consensus:${aboveMedium.map((v) => v.matcher).join("+")}`,
        votes,
      };
    }
    return {
      decision: "queue",
      reason: `medium_consensus_mean=${mean.toFixed(2)}`,
      votes,
    };
  }

  if (aboveMedium.length === 1) {
    return {
      decision: "queue",
      reason: `single_medium_signal:${aboveMedium[0]?.matcher}`,
      votes,
    };
  }

  return { decision: "no-match", reason: "below_thresholds", votes };
}
