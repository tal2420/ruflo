import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  matchEmbedding,
} from "../src/entity-resolver/matchers/embedding.js";
import { paymentsApi } from "./fixtures/payments.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("returns 0 on length mismatch or empty input", () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("matchEmbedding", () => {
  it("returns null when either embedding is absent", () => {
    expect(matchEmbedding(paymentsApi.dynatrace, paymentsApi.bmcHelix)).toBeNull();
  });

  it("returns null when cosine < 0.6", () => {
    const a = { ...paymentsApi.dynatrace, embedding: [1, 0, 0] };
    const b = { ...paymentsApi.bmcHelix, embedding: [0, 1, 0] };
    expect(matchEmbedding(a, b)).toBeNull();
  });

  it("caps confidence at 0.92 so embeddings cannot solo-authorize a link", () => {
    // Identical embeddings → cosine 1, but confidence is capped at 0.92.
    const a = { ...paymentsApi.dynatrace, embedding: [0.7, 0.2, 0.1, 0.3, 0.5] };
    const b = { ...paymentsApi.bmcHelix, embedding: [0.7, 0.2, 0.1, 0.3, 0.5] };
    const v = matchEmbedding(a, b);
    expect(v).not.toBeNull();
    expect(v?.confidence).toBeLessThanOrEqual(0.92);
    expect(v?.method).toBe("embedding-similarity");
  });
});
