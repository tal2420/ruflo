// Dynatrace → SREFlow adapter.
//
// Fetches entities from Dynatrace's /api/v2/entities endpoint and maps them
// into SourceEntity shape for the Phase-0 pipeline. Read-only. The API token
// must be scoped to entities.read at a minimum.
//
// Reference:  https://www.dynatrace.com/support/help/dynatrace-api/environment-api/entity-v2

import type {
  SourceEntity,
  CanonicalType,
} from "../../../src/entity-resolver/types.js";

export interface DynatraceConfig {
  /** e.g. https://abc12345.live.dynatrace.com (no trailing slash) */
  tenantUrl: string;
  /** API token with entities.read scope. Never log, never persist. */
  apiToken: string;
  /** entitySelector — defaults to type(SERVICE). */
  entitySelector?: string;
  /** Restrict to a Management Zone by name (not ID). */
  managementZone?: string;
  /** Page size. Dynatrace max is 4000; default here is 500. */
  pageSize?: number;
  /** Comma-separated Fields expansion. Defaults include tags + properties. */
  fields?: string;
}

/** Raw Dynatrace entity shape (partial — only what we actually use). */
export interface DynatraceApiEntity {
  entityId: string;
  displayName: string;
  type: string;
  tags?: Array<{
    key: string;
    value?: string;
    context?: string;
    stringRepresentation?: string;
  }>;
  properties?: Record<string, unknown>;
  firstSeenTms?: number;
  lastSeenTms?: number;
  /** Relationships where this entity is the source. Keyed by relationship type (e.g. "calls"). */
  fromRelationships?: Record<string, Array<{ id: string; type?: string }>>;
  /** Relationships where this entity is the target. */
  toRelationships?: Record<string, Array<{ id: string; type?: string }>>;
}

/** One service-to-service call edge derived from Dynatrace relationships. */
export interface ServiceCallEdge {
  fromId: string;
  toId: string;
}

export interface DynatraceListResponse {
  entities: DynatraceApiEntity[];
  totalCount?: number;
  pageSize?: number;
  nextPageKey?: string | null;
}

/**
 * Dynatrace entity-type → SREFlow canonicalType. Types not in this map are
 * skipped (mapEntity returns null); extend as Phase-0 needs grow.
 */
export const TYPE_MAP: Record<string, CanonicalType> = {
  SERVICE: "Service",
  PROCESS_GROUP: "ProcessGroup",
  PROCESS_GROUP_INSTANCE: "ProcessGroup",
  HOST: "Host",
  KUBERNETES_NODE: "Host",
  KUBERNETES_CLUSTER: "Cluster",
  DATABASE_SERVICE: "Database",
  CUSTOM_DEVICE: "Service",
};

type StringRecord = Record<string, string>;

function extractTags(raw: DynatraceApiEntity["tags"]): StringRecord {
  const tags: StringRecord = {};
  if (!raw) return tags;
  for (const t of raw) {
    // Only take CONTEXTLESS tags or tags without a context declared.
    // AWS/Azure/GCP-contextual tags are scoped and would collide.
    if (t.context && t.context !== "CONTEXTLESS") continue;
    if (t.key && typeof t.value === "string") tags[t.key] = t.value;
  }
  return tags;
}

function stringProp(
  props: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = props?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function extractK8s(e: DynatraceApiEntity): SourceEntity["k8s"] {
  const tags = e.tags ?? [];
  const tagVal = (k: string): string | undefined =>
    tags.find((t) => t.key === k)?.value;

  const cluster =
    tagVal("k8s.cluster") ??
    tagVal("kubernetes.cluster") ??
    stringProp(e.properties, "kubernetesClusterName");
  const namespace =
    tagVal("k8s.namespace") ??
    tagVal("kubernetes.namespace") ??
    stringProp(e.properties, "kubernetesNamespace");
  const workload =
    tagVal("k8s.workload") ??
    tagVal("kubernetes.workload") ??
    stringProp(e.properties, "kubernetesServiceName") ??
    stringProp(e.properties, "kubernetesDeployment");

  if (cluster && namespace && workload) {
    return { cluster, namespace, workload };
  }
  return undefined;
}

function extractFqdn(
  e: DynatraceApiEntity,
  tags: StringRecord,
): string | undefined {
  return (
    tags["fqdn"] ??
    tags["hostname"] ??
    stringProp(e.properties, "detectedName") ??
    stringProp(e.properties, "discoveredName") ??
    undefined
  );
}

/** Pure: map one Dynatrace entity to a SourceEntity, or null if type isn't supported. */
export function mapEntity(e: DynatraceApiEntity): SourceEntity | null {
  const canonicalType = TYPE_MAP[e.type];
  if (!canonicalType) return null;

  const tags = extractTags(e.tags);
  const k8s = extractK8s(e);
  const fqdn = extractFqdn(e, tags);
  const observedAt = e.lastSeenTms
    ? new Date(e.lastSeenTms).toISOString()
    : new Date().toISOString();

  const entity: SourceEntity = {
    source: "dynatrace",
    sourceId: e.entityId,
    canonicalType,
    names: [e.displayName].filter(Boolean) as string[],
    tags,
    observedAt,
  };
  if (fqdn) entity.fqdn = fqdn;
  if (k8s) entity.k8s = k8s;
  return entity;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function buildInitialUrl(cfg: DynatraceConfig): string {
  const base = cfg.tenantUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/api/v2/entities`);
  let selector = cfg.entitySelector ?? "type(SERVICE)";
  if (cfg.managementZone) {
    // Escape quotes in the zone name for the selector.
    const escaped = cfg.managementZone.replace(/"/g, '\\"');
    selector += `,mzName("${escaped}")`;
  }
  url.searchParams.set("entitySelector", selector);
  url.searchParams.set("pageSize", String(cfg.pageSize ?? 500));
  url.searchParams.set("fields", cfg.fields ?? "+tags,+properties,+firstSeenTms,+lastSeenTms");
  return url.toString();
}

function buildNextUrl(cfg: DynatraceConfig, nextPageKey: string): string {
  // Dynatrace pagination: subsequent requests pass ONLY nextPageKey.
  const base = cfg.tenantUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/api/v2/entities`);
  url.searchParams.set("nextPageKey", nextPageKey);
  return url.toString();
}

async function readBody(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 1000);
  } catch {
    return "<unreadable>";
  }
}

/**
 * Internal paginating iterator over raw Dynatrace entities. Handles auth,
 * 429 backoff, and nextPageKey traversal. Used by both fetchEntities (which
 * maps to SourceEntity) and fetchServiceCalls (which reads relationships).
 */
async function* iterateRawEntities(
  cfg: DynatraceConfig,
  fetchImpl: FetchLike,
): AsyncGenerator<DynatraceApiEntity, void, void> {
  let url: string | null = buildInitialUrl(cfg);
  let consecutive429s = 0;

  while (url) {
    const resp: Response = await fetchImpl(url, {
      headers: {
        Authorization: `Api-Token ${cfg.apiToken}`,
        Accept: "application/json",
      },
    });

    if (resp.status === 429) {
      consecutive429s += 1;
      if (consecutive429s > 5) {
        throw new Error(
          "Dynatrace API: too many consecutive 429 responses — aborting",
        );
      }
      const retryAfter = Number(resp.headers.get("retry-after") ?? 5);
      await new Promise((r) => setTimeout(r, Math.min(30, retryAfter) * 1000));
      continue;
    }
    consecutive429s = 0;

    if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        `Dynatrace API auth failed (${resp.status}). Check the token and its scopes (needs entities.read).`,
      );
    }
    if (!resp.ok) {
      throw new Error(
        `Dynatrace API ${resp.status}: ${await readBody(resp)}`,
      );
    }

    const data = (await resp.json()) as DynatraceListResponse;
    for (const raw of data.entities ?? []) {
      yield raw;
    }
    url = data.nextPageKey ? buildNextUrl(cfg, data.nextPageKey) : null;
  }
}

/**
 * Fetch and map all entities matching the configured selector, paginating
 * through Dynatrace's nextPageKey until exhausted. Honors 429 backoff.
 * The injected `fetchImpl` defaults to the global fetch (Node 20+).
 */
export async function fetchEntities(
  cfg: DynatraceConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<SourceEntity[]> {
  const entities: SourceEntity[] = [];
  for await (const raw of iterateRawEntities(cfg, fetchImpl)) {
    const mapped = mapEntity(raw);
    if (mapped) entities.push(mapped);
  }
  return entities;
}

/**
 * Fetch service→service call edges from Dynatrace by reading
 * `fromRelationships.calls` on each entity in the selector.
 *
 * Requires `fields=+fromRelationships` — this function forces that if the
 * caller didn't. Returns unique (fromId, toId) pairs; duplicates filtered.
 */
export async function fetchServiceCalls(
  cfg: DynatraceConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<ServiceCallEdge[]> {
  const fields = cfg.fields
    ? cfg.fields.includes("fromRelationships")
      ? cfg.fields
      : `${cfg.fields},+fromRelationships`
    : "+tags,+fromRelationships";
  const effective: DynatraceConfig = { ...cfg, fields };

  const seen = new Set<string>();
  const edges: ServiceCallEdge[] = [];
  for await (const raw of iterateRawEntities(effective, fetchImpl)) {
    const calls = raw.fromRelationships?.calls;
    if (!calls) continue;
    for (const to of calls) {
      if (!to.id) continue;
      const key = `${raw.entityId}|${to.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ fromId: raw.entityId, toId: to.id });
    }
  }
  return edges;
}
