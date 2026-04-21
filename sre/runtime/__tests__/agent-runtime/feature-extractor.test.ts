import { describe, it, expect } from "vitest";
import {
  extractFeatures,
  humanizeFeatureName,
  looksLikeFeatureApi,
  type CallEdge,
  type ServiceRecord,
} from "../../src/agent-runtime/agents/feature-extractor.js";

describe("looksLikeFeatureApi", () => {
  it("accepts .Api and .API suffixes", () => {
    expect(looksLikeFeatureApi("AppointmentOrder.Api")).toBe(true);
    expect(looksLikeFeatureApi("MedicalFile.API")).toBe(true);
    expect(looksLikeFeatureApi("MaccabiTestResults6.API (/MACCABITESTRESULTS)")).toBe(true);
  });

  it("accepts .Services suffix", () => {
    expect(looksLikeFeatureApi("macManualPrescriptions.services")).toBe(false); // lowercase .services not matched — too permissive
    expect(looksLikeFeatureApi("SomethingFeature.Services")).toBe(true);
  });

  it("accepts legacy .ws.provider and .asmx endpoints", () => {
    expect(looksLikeFeatureApi("macPhrmcIntegrationToClics.ws.provider")).toBe(true);
    expect(looksLikeFeatureApi("OldLegacy.asmx.provider")).toBe(true);
  });

  it("rejects generic IIS / framework services", () => {
    expect(looksLikeFeatureApi("Default Web Site:80 (/BookmarksApi)")).toBe(false);
    expect(looksLikeFeatureApi("Requests executed in background threads of IIS app pool X")).toBe(false);
    expect(looksLikeFeatureApi("System.Web.Hosting.IApplicationHost")).toBe(false);
    expect(looksLikeFeatureApi("Microsoft.Something")).toBe(false);
    expect(looksLikeFeatureApi("localhost:8080")).toBe(false);
  });

  it("rejects empty or pool-handler names", () => {
    expect(looksLikeFeatureApi("")).toBe(false);
    expect(looksLikeFeatureApi("MultiTenant Host")).toBe(false);
  });
});

describe("humanizeFeatureName", () => {
  it("splits camelCase and drops API suffix", () => {
    expect(humanizeFeatureName("AppointmentOrder.Api (/APPOINTMENTORDERAPI)")).toBe("Appointment Order");
    expect(humanizeFeatureName("MedicalFile.Api (/MEDICALFILEAPI)")).toBe("Medical File");
    expect(humanizeFeatureName("CommunicationWithDoctor.API")).toBe("Communication With Doctor");
    expect(humanizeFeatureName("HomePage.API (/HOMEPAGEAPI)")).toBe("Home Page");
    expect(humanizeFeatureName("MainApp.Api (/MAINAPPAPI)")).toBe("Main App");
    expect(humanizeFeatureName("PushManagement.Api:443")).toBe("Push Management");
  });

  it("drops trailing version digits", () => {
    expect(humanizeFeatureName("MaccabiTestResults6.API")).toBe("Maccabi Test Results");
    expect(humanizeFeatureName("MaccabiRequestsAndApprovals6.API")).toBe("Maccabi Requests And Approvals");
  });

  it("strips the 'mac' lowercase prefix used by Maccabi internal services", () => {
    expect(humanizeFeatureName("macPhrmcIntegrationToClics.ws.provider")).toBe("Phrmc Integration To Clics");
    expect(humanizeFeatureName("macHitchayvuyot.ws.provider")).toBe("Hitchayvuyot");
  });
});

describe("extractFeatures", () => {
  const maccabiOnlineServices: ServiceRecord[] = [
    { id: "canonical-A", name: "AppointmentOrder.Api (/APPOINTMENTORDERAPI)" },
    { id: "canonical-B", name: "MedicalFile.Api (/MEDICALFILEAPI)" },
    { id: "canonical-C", name: "ReactSiteV4:80,8789" },
    { id: "canonical-D", name: "MaccabiUtilsSso:8878" },
    { id: "canonical-E", name: "PdfServices:8787" },
    { id: "canonical-F", name: "Default Web Site:80 (/BookmarksApi)" }, // excluded
  ];
  const callEdges: CallEdge[] = [
    { fromId: "canonical-C", toId: "canonical-A" }, // ReactSiteV4 → AppointmentOrder
    { fromId: "canonical-C", toId: "canonical-B" }, // ReactSiteV4 → MedicalFile
    { fromId: "canonical-A", toId: "canonical-E" }, // AppointmentOrder → PdfServices
    { fromId: "canonical-B", toId: "canonical-D" }, // MedicalFile → SSO
  ];

  it("emits one FeatureCandidate per feature-named service", () => {
    const features = extractFeatures(maccabiOnlineServices, callEdges);
    const names = features.map((f) => f.name).sort();
    // Feature-named services: AppointmentOrder, MedicalFile.
    // ReactSiteV4, SSO, PDF, Default are NOT feature-named.
    expect(names).toEqual(["Appointment Order", "Medical File"]);
  });

  it("walks the call graph to assemble upstream + downstream components", () => {
    const features = extractFeatures(maccabiOnlineServices, callEdges);
    const ao = features.find((f) => f.name === "Appointment Order")!;
    expect(ao.components.core).toBe("canonical-A");
    expect(ao.components.upstream).toEqual(["canonical-C"]); // ReactSiteV4 calls it
    expect(ao.components.downstream).toEqual(["canonical-E"]); // calls PdfServices

    const mf = features.find((f) => f.name === "Medical File")!;
    expect(mf.components.upstream).toEqual(["canonical-C"]);
    expect(mf.components.downstream).toEqual(["canonical-D"]);
  });

  it("ids are stable: same input → same ids", () => {
    const a = extractFeatures(maccabiOnlineServices, callEdges);
    const b = extractFeatures(maccabiOnlineServices, callEdges);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(a.find((f) => f.name === "Appointment Order")!.id).toBe("bp-feature-appointment-order");
  });

  it("respects scopeToIds to limit features to a subset", () => {
    const features = extractFeatures(maccabiOnlineServices, callEdges, {
      scopeToIds: new Set(["canonical-A"]),
    });
    expect(features.map((f) => f.name)).toEqual(["Appointment Order"]);
  });

  it("returns empty array when no feature-named services are present", () => {
    const onlyRuntime: ServiceRecord[] = [
      { id: "x", name: "Default Web Site" },
      { id: "y", name: "Requests executed in background threads" },
    ];
    expect(extractFeatures(onlyRuntime, [])).toEqual([]);
  });

  it("disambiguates duplicate names with a short id suffix", () => {
    const dups: ServiceRecord[] = [
      { id: "canonical-aaaa1111", name: "HomePage.API" },
      { id: "canonical-bbbb2222", name: "HomePage.API" },
    ];
    const features = extractFeatures(dups, []);
    const ids = features.map((f) => f.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe("bp-feature-home-page");
    expect(ids[1]).toMatch(/^bp-feature-home-page-/);
  });
});
