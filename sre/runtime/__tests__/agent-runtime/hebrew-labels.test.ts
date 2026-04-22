import { describe, it, expect } from "vitest";
import {
  toHebrew,
  roleLabel,
  TRANSLITERATIONS,
  BUSINESS_TERMS,
} from "../../src/agent-runtime/hebrew-labels.js";

describe("toHebrew — exact business-term match", () => {
  it("translates known member-facing features", () => {
    expect(toHebrew("Appointment Order")).toEqual({ he: "הזמנת תור", confidence: "exact" });
    expect(toHebrew("Medical File")).toEqual({ he: "תיק רפואי", confidence: "exact" });
    expect(toHebrew("Test Results")).toEqual({ he: "תוצאות בדיקות", confidence: "exact" });
    expect(toHebrew("Communication With Doctor")).toEqual({
      he: "תקשורת עם הרופא",
      confidence: "exact",
    });
    expect(toHebrew("Home Page")).toEqual({ he: "דף הבית", confidence: "exact" });
  });

  it("translates clinician features", () => {
    expect(toHebrew("Search Patient").he).toBe("חיפוש מטופל");
    expect(toHebrew("Drugs Approvals").he).toBe("אישורי תרופות");
    expect(toHebrew("Prescriptions App").he).toBe("מרשמים");
  });

  it("translates application containers", () => {
    expect(toHebrew("Maccabi Online").he).toBe("מכבי אונליין");
    expect(toHebrew("Portal Rofe").he).toBe("פורטל רופא");
    expect(toHebrew("protocols_nurse").he).toBe("פרוטוקולי אחיות");
  });
});

describe("toHebrew — transliteration", () => {
  it("replaces Latin-script Hebrew with original Hebrew", () => {
    expect(toHebrew("Hitchayvuyot").he).toContain("התחייבויות");
    expect(toHebrew("ZimunKehila").he).toContain("זימון קהילה");
    expect(toHebrew("HiuvYashir").he).toContain("חיוב ישיר");
  });

  it("covers every entry in the TRANSLITERATIONS table", () => {
    // Sanity check that the exported table is non-trivial.
    expect(Object.keys(TRANSLITERATIONS).length).toBeGreaterThan(0);
    for (const [lat, he] of Object.entries(TRANSLITERATIONS)) {
      const out = toHebrew(lat).he;
      if (lat === he) continue; // Mdoc etc. — intentional pass-through
      expect(out).toContain(he);
    }
  });
});

describe("toHebrew — token-level fallback", () => {
  it("translates per-word when the full phrase is not in the dictionary", () => {
    const r = toHebrew("Test Bookmark Card");
    // "Test" → "בדיקה", "Card" → "כרטיס", "Bookmark" → passthrough (not in table)
    expect(r.confidence).toBe("token");
    expect(r.he).toContain("בדיקה");
    expect(r.he).toContain("כרטיס");
  });

  it("keeps brand / technology tokens in Latin script", () => {
    const r = toHebrew("Upload API Kafka");
    expect(r.he).toContain("API");
    expect(r.he).toContain("Kafka");
    expect(r.he).toContain("העלאה");
  });
});

describe("toHebrew — passthrough on unknown input", () => {
  it("returns original text unchanged (and marks confidence)", () => {
    const r = toHebrew("Completely Unknown Widgets");
    expect(r.confidence).toBe("passthrough");
    expect(r.he).toBe("Completely Unknown Widgets");
  });

  it("handles empty / whitespace input gracefully", () => {
    expect(toHebrew("")).toEqual({ he: "", confidence: "passthrough" });
    // Trimmed whitespace yields an empty string, which is still passthrough.
    const r = toHebrew("   ");
    expect(r.confidence).toBe("passthrough");
  });
});

describe("roleLabel", () => {
  it("returns the Hebrew label for known roles", () => {
    expect(roleLabel("HOSTED_IN")).toBe("מתארח ב");
    expect(roleLabel("CALLS")).toBe("קורא ל");
    expect(roleLabel("core")).toBe("ליבה");
    expect(roleLabel("upstream")).toContain("חזית");
    expect(roleLabel("downstream")).toBe("תלויות");
  });

  it("falls back to the original role when unknown", () => {
    expect(roleLabel("MADE_UP_REL")).toBe("MADE_UP_REL");
  });
});

describe("dictionary sanity", () => {
  it("exports the business-terms dictionary as a non-trivial, frozen object", () => {
    expect(Object.keys(BUSINESS_TERMS).length).toBeGreaterThan(30);
    expect(Object.isFrozen(BUSINESS_TERMS)).toBe(true);
  });
});
