import type { SourceEntity, MatchVote } from "../types.js";

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Embedding similarity — operates on precomputed description embeddings attached
 * to the entity. The resolver is pure; generating embeddings is the doc-collector's job.
 * Only emits a vote when cosine ≥ 0.6 (below that it's noise).
 */
export function matchEmbedding(
  a: SourceEntity,
  b: SourceEntity,
): MatchVote | null {
  if (!a.embedding || !b.embedding) return null;
  const sim = cosineSimilarity(a.embedding, b.embedding);
  if (sim < 0.6) return null;
  // Map cosine similarity onto a confidence. We cap at 0.92 so embedding alone
  // never hits the "high" threshold — a textual match can corroborate but
  // shouldn't solo-authorize a link.
  const confidence = Math.min(0.92, sim);
  return {
    matcher: "embedding",
    method: "embedding-similarity",
    confidence,
    evidence: `cosine=${sim.toFixed(3)}`,
  };
}
