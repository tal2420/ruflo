import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
import {
  mapEntity,
  fetchEntities,
  TYPE_MAP,
  type DynatraceApiEntity,
  type DynatraceListResponse,
  type FetchLike,
} from "../../scripts/phase0/adapters/dynatrace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pageJson = JSON.parse(
  readFileSync(pathResolve(__dirname, "fixtures/dynatrace-services-page.json"), "utf8"),
) as DynatraceListResponse;

describe("mapEntity", () => {
  it("maps a SERVICE to canonical 'Service' with tags and k8s triple", () => {
    const raw = pageJson.entities.find((e) => e.entityId === "SERVICE-REAL001")!;
    const mapped = mapEntity(raw);
    expect(mapped).not.toBeNull();
    expect(mapped!.source).toBe("dynatrace");
    expect(mapped!.sourceId).toBe("SERVICE-REAL001");
    expect(mapped!.canonicalType).toBe("Service");
    expect(mapped!.names).toEqual(["checkout-web-prod"]);
    expect(mapped!.tags).toMatchObject({ team: "checkout", env: "prod", tier: "1" });
    expect(mapped!.k8s).toEqual({
      cluster: "prod-us-east-1",
      namespace: "checkout",
      workload: "checkout-web",
    });
    expect(mapped!.fqdn).toBe("checkout-web.prod.corp.internal");
  });

  it("filters out tags whose context is not CONTEXTLESS (e.g. AWS-scoped)", () => {
    const raw = pageJson.entities.find((e) => e.entityId === "SERVICE-REAL002")!;
    const mapped = mapEntity(raw);
    expect(mapped!.tags).not.toHaveProperty("AWS.region");
    expect(mapped!.tags).toMatchObject({ team: "payments", env: "prod" });
  });

  it("falls back to detectedName when no explicit fqdn tag is present", () => {
    const raw = pageJson.entities.find((e) => e.entityId === "SERVICE-REAL002")!;
    const mapped = mapEntity(raw);
    expect(mapped!.fqdn).toBe("payments-api.prod.corp.internal");
  });

  it("maps HOST to canonical 'Host'", () => {
    const raw = pageJson.entities.find((e) => e.entityId === "HOST-REAL003")!;
    const mapped = mapEntity(raw);
    expect(mapped!.canonicalType).toBe("Host");
    expect(mapped!.k8s).toBeUndefined();
  });

  it("returns null for unsupported Dynatrace entity types", () => {
    const raw: DynatraceApiEntity = {
      entityId: "NETWORK_INTERFACE-REAL004",
      displayName: "eth0",
      type: "NETWORK_INTERFACE",
    };
    expect(mapEntity(raw)).toBeNull();
  });

  it("converts lastSeenTms to ISO, defaults to now when absent", () => {
    const withTms = mapEntity(pageJson.entities[0]!)!;
    expect(withTms.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(withTms.observedAt).getTime()).toBe(1745193600000);

    const withoutTms = mapEntity({
      entityId: "SERVICE-X",
      displayName: "x",
      type: "SERVICE",
    })!;
    expect(withoutTms.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("TYPE_MAP covers the core Phase-0 Dynatrace types", () => {
    expect(TYPE_MAP["SERVICE"]).toBe("Service");
    expect(TYPE_MAP["HOST"]).toBe("Host");
    expect(TYPE_MAP["KUBERNETES_CLUSTER"]).toBe("Cluster");
  });
});

describe("fetchEntities (no network — injected fetch)", () => {
  function mockFetch(responses: Response[]): FetchLike {
    let i = 0;
    return async (_url: string, _init?: RequestInit) => {
      const next = responses[i++];
      if (!next) throw new Error("mockFetch exhausted");
      return next;
    };
  }

  function jsonResp(body: DynatraceListResponse): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("paginates until nextPageKey is absent and merges mapped entities", async () => {
    const page1: DynatraceListResponse = {
      entities: [pageJson.entities[0]!, pageJson.entities[1]!],
      nextPageKey: "pk-2",
    };
    const page2: DynatraceListResponse = {
      entities: [pageJson.entities[2]!, pageJson.entities[3]!],
      nextPageKey: null,
    };
    const fetchImpl = mockFetch([jsonResp(page1), jsonResp(page2)]);

    const result = await fetchEntities(
      { tenantUrl: "https://tenant.example.com", apiToken: "t" },
      fetchImpl,
    );
    // 4 raw entities in; 3 map (the NETWORK_INTERFACE is unsupported).
    expect(result.length).toBe(3);
    expect(result.map((e) => e.sourceId).sort()).toEqual([
      "HOST-REAL003",
      "SERVICE-REAL001",
      "SERVICE-REAL002",
    ]);
  });

  it("retries on 429 with Retry-After then succeeds", async () => {
    const retry = new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "0" },
    });
    const ok = jsonResp({ entities: [pageJson.entities[0]!] });
    const result = await fetchEntities(
      { tenantUrl: "https://tenant.example.com", apiToken: "t" },
      mockFetch([retry, ok]),
    );
    expect(result.length).toBe(1);
  });

  it("throws a clear error on 401/403 auth failure", async () => {
    const unauth = new Response("Unauthorized", { status: 401 });
    await expect(
      fetchEntities(
        { tenantUrl: "https://tenant.example.com", apiToken: "bad" },
        mockFetch([unauth]),
      ),
    ).rejects.toThrow(/auth failed/i);
  });

  it("throws on unexpected non-2xx", async () => {
    const err = new Response("boom", { status: 500 });
    await expect(
      fetchEntities(
        { tenantUrl: "https://tenant.example.com", apiToken: "t" },
        mockFetch([err]),
      ),
    ).rejects.toThrow(/500/);
  });

  it("applies managementZone into the entitySelector of the initial request", async () => {
    let capturedUrl = "";
    const fetchImpl: FetchLike = async (url, _init) => {
      capturedUrl = url;
      return jsonResp({ entities: [] });
    };
    await fetchEntities(
      {
        tenantUrl: "https://tenant.example.com",
        apiToken: "t",
        managementZone: "sandbox-checkout",
      },
      fetchImpl,
    );
    expect(capturedUrl).toMatch(/entitySelector=/);
    expect(decodeURIComponent(capturedUrl)).toContain('mzName("sandbox-checkout")');
  });
});
