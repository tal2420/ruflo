import { describe, it, expect } from "vitest";
import {
  renderBp,
  type RenderBpInput,
} from "../../src/agent-runtime/render-bp.js";

const sample: RenderBpInput = {
  bp: {
    id: "bp-feature-appointment-order",
    name: "Appointment Order",
    scope: "feature",
    criticalityTier: 2,
    sourceName: "AppointmentOrder.Api (/APPOINTMENTORDERAPI)",
  },
  hostedIn: { id: "bp-application-maccabi-online", name: "Maccabi Online" },
  components: [
    { id: "canonical-core", primaryName: "AppointmentOrder.Api (/APPOINTMENTORDERAPI)", role: "core" },
    { id: "canonical-up", primaryName: "ReactSiteV4:80,8789", role: "upstream" },
    { id: "canonical-down1", primaryName: "ConverterApi:85", role: "downstream" },
    { id: "canonical-down2", primaryName: "Default Web Site:80 (/MaccabiUtilsMedicalFile)", role: "downstream" },
  ],
};

describe("renderBp — English", () => {
  const out = renderBp(sample, { lang: "en" });
  it("uses top-bottom direction for English", () => {
    expect(out.split("\n")[0]).toBe("flowchart TB");
  });
  it("includes the BP label and tier", () => {
    expect(out).toContain('BP["Appointment Order');
    expect(out).toContain("tier-2");
  });
  it("renders the hosted_in edge to the application", () => {
    expect(out).toMatch(/BP -->\|hosted in\| APP/);
    expect(out).toContain('APP["Maccabi Online"]');
  });
  it("groups components into upstream / core / downstream subgraphs", () => {
    expect(out).toContain('subgraph ROLE_UPSTREAM["upstream"]');
    expect(out).toContain('subgraph ROLE_CORE["core"]');
    expect(out).toContain('subgraph ROLE_DOWNSTREAM["downstream"]');
  });
});

describe("renderBp — Hebrew", () => {
  const out = renderBp(sample, { lang: "he" });
  it("uses right-left direction for Hebrew", () => {
    expect(out.split("\n")[0]).toBe("flowchart RL");
  });
  it("translates the BP name", () => {
    expect(out).toContain("הזמנת תור");
  });
  it("translates the host application name", () => {
    expect(out).toContain("מכבי אונליין");
  });
  it("translates the role subgraph titles", () => {
    // Hebrew role labels
    expect(out).toMatch(/subgraph ROLE_CORE\["ליבה"\]/);
    expect(out).toMatch(/subgraph ROLE_UPSTREAM\["חזית/);
    expect(out).toMatch(/subgraph ROLE_DOWNSTREAM\["תלויות"\]/);
  });
  it("translates the hosted_in edge label", () => {
    expect(out).toContain("מתארח ב");
  });
  it("uses feature-scope Hebrew label in the header", () => {
    expect(out).toContain("תהליך עסקי");
  });
});

describe("renderBp — edge cases", () => {
  it("handles a BP with no host application and no components", () => {
    const out = renderBp({
      bp: { id: "bp-empty", name: "Empty", scope: "application", criticalityTier: 3 },
      components: [],
    });
    expect(out).toContain("flowchart TB");
    expect(out).toContain("Empty");
    expect(out).not.toContain("APP[");
    expect(out).not.toContain("subgraph");
  });

  it("produces deterministic output for the same input", () => {
    const a = renderBp(sample, { lang: "he" });
    const b = renderBp(sample, { lang: "he" });
    expect(a).toBe(b);
  });
});
