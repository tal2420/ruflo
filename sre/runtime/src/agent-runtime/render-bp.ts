// Renders a Mermaid flowchart for a single BusinessProcess.
//
// Supports either English (default, flowchart TB) or Hebrew with RTL-appropriate
// layout (flowchart RL, all labels piped through toHebrew). Pure with respect
// to rendering — the caller supplies the data (one Neo4j query, one function
// call). Intentionally no I/O here so this is unit-testable without Neo4j.

import { toHebrew, roleLabel } from "./hebrew-labels.js";

export interface RenderComponent {
  id: string;
  primaryName: string;
  /** "core" | "upstream" | "downstream" | undefined (for application-scope BPs). */
  role?: "core" | "upstream" | "downstream";
}

export interface RenderBpInput {
  bp: {
    id: string;
    name: string;
    scope?: "application" | "feature";
    criticalityTier?: number;
    sourceName?: string;
  };
  /** The application this feature is hosted in, if any. */
  hostedIn?: { id: string; name: string };
  components: RenderComponent[];
}

export interface RenderOptions {
  lang?: "en" | "he";
}

function escapeLabel(s: string): string {
  // Mermaid-friendly label escaping: strip braces/quotes/brackets that break parsing.
  return s.replace(/["`{}]/g, " ").replace(/\s+/g, " ").trim();
}

function safeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 48);
}

function translate(s: string, lang: "en" | "he"): string {
  if (lang !== "he") return s;
  return toHebrew(s).he;
}

/** Compose a Mermaid flowchart for a single BusinessProcess. */
export function renderBp(input: RenderBpInput, opts: RenderOptions = {}): string {
  const lang = opts.lang ?? "en";
  const direction = lang === "he" ? "RL" : "TB";
  const lines: string[] = [];
  lines.push(`flowchart ${direction}`);

  // Root node — the BP itself.
  const bpLabel = translate(input.bp.name, lang);
  const tier = input.bp.criticalityTier ?? "?";
  const scopeLabel =
    lang === "he"
      ? input.bp.scope === "feature"
        ? "תהליך עסקי"
        : "יישום"
      : input.bp.scope ?? "process";
  lines.push(`  BP["${escapeLabel(bpLabel)}<br/>${scopeLabel} · tier-${tier}"]`);

  // Host application (if any).
  if (input.hostedIn) {
    const hostLabel = translate(input.hostedIn.name, lang);
    lines.push(`  APP["${escapeLabel(hostLabel)}"]`);
    const edgeLabel = lang === "he" ? roleLabel("HOSTED_IN") : "hosted in";
    lines.push(`  BP -->|${edgeLabel}| APP`);
  }

  // Components grouped by role.
  const byRole: Record<string, RenderComponent[]> = { core: [], upstream: [], downstream: [], other: [] };
  for (const c of input.components) {
    const r = c.role ?? "other";
    (byRole[r] ??= []).push(c);
  }

  const emit = (roleKey: "core" | "upstream" | "downstream" | "other") => {
    const items = byRole[roleKey];
    if (!items || items.length === 0) return;
    const sub = safeId(`ROLE_${roleKey}`).toUpperCase();
    const title = lang === "he" ? (roleKey === "other" ? "רכיבים" : roleLabel(roleKey)) : roleKey;
    lines.push(`  subgraph ${sub}["${title}"]`);
    for (const c of items) {
      // Component names often include brand/port/path tokens — mostly keep as-is;
      // feed through the translator only for tokens in KEEP_LATIN handling.
      const label = lang === "he" ? toHebrew(c.primaryName).he : c.primaryName;
      lines.push(`    ${safeId(c.id)}["${escapeLabel(label)}"]`);
    }
    lines.push(`  end`);
    lines.push(`  BP --> ${sub}`);
  };
  emit("upstream");
  emit("core");
  emit("downstream");
  emit("other");

  return lines.join("\n");
}
