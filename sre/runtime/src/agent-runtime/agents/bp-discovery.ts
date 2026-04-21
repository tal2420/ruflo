// Pure business-process discovery heuristics.
//
// Given a snapshot of SourceEntity tags, propose candidate business processes.
// The wrapping agent does I/O; this module is dependency-free and exhaustively
// unit-tested so the discovery logic itself is debuggable without a graph.

export interface TaggedEntity {
  /** Compound `source:sourceId` — must be unique per entity. */
  id: string;
  /** Flat list of "k=v" tag atoms. */
  tagsFlat: string[];
}

export interface BusinessProcessCandidate {
  /** Stable id derived from the primary signal. */
  id: string;
  /** Proposed display name. */
  name: string;
  /** How the candidate was discovered — audit trail material. */
  inferenceMethod: string;
  /** The tag atoms that anchor this candidate; first is the primary. */
  anchorTags: string[];
  /** Ids of the member entities. */
  memberIds: string[];
  /** Numeric score — higher is a stronger candidate. */
  score: number;
}

export interface DiscoveryOptions {
  /** Tag keys whose values delineate a business-process boundary. */
  anchorKeys?: string[];
  /** Minimum member count for a candidate to be considered. */
  minMembers?: number;
  /** Maximum member count — above this the tag is probably infra, not a process. */
  maxMembers?: number;
  /** Top-N candidates to return, sorted by score descending. */
  topN?: number;
}

const DEFAULT_ANCHOR_KEYS = [
  "APPLICATION",
  "dt.host_group.id",
  "business_service",
];

interface ParsedTag {
  key: string;
  value: string;
}

function parseTag(atom: string): ParsedTag | null {
  const i = atom.indexOf("=");
  if (i <= 0) return null;
  return { key: atom.slice(0, i), value: atom.slice(i + 1) };
}

function normKey(key: string): string {
  // Lowercase and drop common host-group prefix so "App_MaccabiOnline" and
  // "Maccabi_Online" land in the same bucket for dual-signal matching.
  return key
    .toLowerCase()
    .replace(/^app_/, "")
    .replace(/^infra_/, "");
}

function normValue(value: string): string {
  return normKey(value);
}

/**
 * Propose business-process candidates from a batch of tagged entities.
 *
 * Algorithm:
 *   1. For each entity, collect the set of anchor tags (by `anchorKeys`).
 *   2. For every anchor atom, gather the set of entity ids that carry it.
 *   3. Score each anchor:
 *        baseScore   = log(memberCount)
 *        dualBonus   = 1.5 if a second anchor tag (different key) covers ≥ 80%
 *                       of the same members — "two independent signals agree"
 *        sizeWindow  = 1.0 if minMembers ≤ memberCount ≤ maxMembers, else 0.
 *   4. Filter to size window; sort by score; take topN.
 *   5. De-duplicate: if two candidates cover ≥ 80% of the same members, keep
 *      the one whose anchor key has higher priority (order in anchorKeys).
 */
export function proposeBusinessProcesses(
  entities: TaggedEntity[],
  opts: DiscoveryOptions = {},
): BusinessProcessCandidate[] {
  const anchorKeys = opts.anchorKeys ?? DEFAULT_ANCHOR_KEYS;
  const minMembers = opts.minMembers ?? 5;
  const maxMembers = opts.maxMembers ?? 500;
  const topN = opts.topN ?? 20;
  const keyRank = new Map(anchorKeys.map((k, i) => [k, i]));

  // Collect anchor atoms → member ids
  const anchorMembers = new Map<string, Set<string>>();
  for (const e of entities) {
    for (const atom of e.tagsFlat) {
      const p = parseTag(atom);
      if (!p || !anchorKeys.includes(p.key)) continue;
      let s = anchorMembers.get(atom);
      if (!s) {
        s = new Set<string>();
        anchorMembers.set(atom, s);
      }
      s.add(e.id);
    }
  }

  // Score candidates
  const raw: BusinessProcessCandidate[] = [];
  for (const [atom, members] of anchorMembers) {
    const n = members.size;
    if (n < minMembers || n > maxMembers) continue;
    const p = parseTag(atom);
    if (!p) continue;

    // Dual-signal bonus: look for another atom (different key) that overlaps
    // with ≥80% of these members.
    let dualBonus = 1.0;
    let dualAtom: string | undefined;
    const normVal = normValue(p.value);
    for (const [otherAtom, otherMembers] of anchorMembers) {
      if (otherAtom === atom) continue;
      const op = parseTag(otherAtom);
      if (!op || op.key === p.key) continue;
      // The atoms don't need identical values — just member overlap.
      let shared = 0;
      for (const id of members) if (otherMembers.has(id)) shared += 1;
      const overlap = shared / n;
      if (overlap >= 0.8) {
        // Prefer the corroborator whose normalized value looks similar.
        if (normValue(op.value) === normVal || !dualAtom) {
          dualAtom = otherAtom;
          dualBonus = 1.5;
        }
      }
    }

    const baseScore = Math.log(n);
    const score = baseScore * dualBonus;
    const anchorTags = dualAtom ? [atom, dualAtom] : [atom];
    raw.push({
      id: `bp-${normKey(p.key)}-${normValue(p.value).replace(/[^a-z0-9]+/g, "-")}`,
      name: p.value,
      inferenceMethod: dualAtom
        ? `dual-signal: ${atom} + ${dualAtom} (overlap ≥ 80%)`
        : `tag-anchor: ${atom}`,
      anchorTags,
      memberIds: Array.from(members),
      score,
    });
  }

  // Sort by score desc, stable
  raw.sort((a, b) => b.score - a.score);

  // De-duplicate: drop candidates whose members ≥80% overlap with an already-kept one.
  const kept: BusinessProcessCandidate[] = [];
  for (const cand of raw) {
    const candSet = new Set(cand.memberIds);
    const candKey = parseTag(cand.anchorTags[0]!)?.key ?? "";
    const candRank = keyRank.get(candKey) ?? 99;
    let drop = false;
    for (const prev of kept) {
      const prevSet = new Set(prev.memberIds);
      let shared = 0;
      for (const id of candSet) if (prevSet.has(id)) shared += 1;
      const smaller = Math.min(candSet.size, prevSet.size);
      if (shared / smaller < 0.8) continue;
      const prevKey = parseTag(prev.anchorTags[0]!)?.key ?? "";
      const prevRank = keyRank.get(prevKey) ?? 99;
      // Keep the one with better-ranked anchor key.
      if (prevRank <= candRank) {
        drop = true;
      } else {
        // Replace prev with cand — but we're iterating linearly, so easier:
        // mark prev for removal by re-building kept below.
        const idx = kept.indexOf(prev);
        if (idx >= 0) kept.splice(idx, 1);
      }
      break;
    }
    if (!drop) kept.push(cand);
    if (kept.length >= topN) break;
  }

  return kept;
}
