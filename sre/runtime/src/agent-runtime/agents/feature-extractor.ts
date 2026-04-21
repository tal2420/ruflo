// Pure feature-extractor: identifies business processes at the *feature* level
// (e.g., "Display Lab Results", "Order Appointment") from Dynatrace service
// names, not at the system/application level (Maccabi Online, Portal Rofe).
//
// A feature is something a user accomplishes. Its "component map" is the
// specific API that implements it plus the immediate services it collaborates
// with (front-end, auth, shared infrastructure, downstream data).

export interface ServiceRecord {
  /** Compound id — typically `canonical-<uuid>` or `canonical-<source>-<sourceId>`. */
  id: string;
  /** Primary display name, as emitted by the source system. */
  name: string;
}

export interface CallEdge {
  fromId: string;
  toId: string;
}

export interface FeatureCandidate {
  /** Stable id derived from the feature name. */
  id: string;
  /** Business-oriented name — "Order Appointment", not "AppointmentOrder.Api". */
  name: string;
  /** The canonical id of the service that IS this feature (the "core"). */
  coreId: string;
  /** Original service name for audit trail. */
  sourceName: string;
  /** Scope: always "feature" — distinguishes from application-level BPs. */
  scope: "feature";
  /** Components:
   *    core      — the feature's own API
   *    upstream  — services that call the core (front-end entry points)
   *    downstream — services the core calls (auth, PDF, data sources)
   */
  components: {
    core: string;
    upstream: string[];
    downstream: string[];
  };
  /** How this feature was detected — audit trail. */
  inferenceMethod: string;
}

// -----------------------------------------------------------------------------

/**
 * Match patterns that indicate a service is a *feature* entry point (a user-
 * facing API) rather than a framework/runtime service or a generic pool handler.
 *
 * Heuristics, in order of specificity:
 *   1. Name like `Something.Api` or `Something.API` — explicit API suffix.
 *   2. Name like `Something.Services` — feature-ish .NET pattern.
 *   3. Name starts with a feature-y prefix (`Maccabi`, `mac`) and is followed
 *      by a compound capitalized noun.
 *
 * Exclusions (never treated as features):
 *   - Generic IIS pool handlers: "Default Web Site", "Requests executed in…"
 *   - Framework stubs: "System.*", "Microsoft.*", "localhost"
 *   - Background workers with no API façade — too broad to be a user feature.
 */
export function looksLikeFeatureApi(name: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  // Hard exclusions.
  const excludePrefixes = ["Default", "Requests", "System", "Microsoft", "localhost", "Multi"];
  for (const p of excludePrefixes) {
    if (trimmed.startsWith(p)) return false;
  }
  // Explicit API suffix (most common).
  if (/\.(API|Api)(:\d+)?(\s|$|\()/.test(trimmed)) return true;
  // .Services suffix, common .NET WCF-style.
  if (/\.Services(:\d+)?(\s|$|\()/.test(trimmed)) return true;
  // .ws.provider / .asmx legacy web services.
  if (/\.(ws|asmx)\./.test(trimmed)) return true;
  return false;
}

/**
 * Turn a Dynatrace service name into a human-readable business-process name.
 * Examples:
 *   "AppointmentOrder.Api (/APPOINTMENTORDERAPI)"      → "Appointment Order"
 *   "MaccabiTestResults6.API (/MACCABIUTILSTESTRESULTS)" → "Maccabi Test Results"
 *   "CommunicationWithDoctor.API"                       → "Communication With Doctor"
 *   "MedicalFile.Api (/MEDICALFILEAPI)"                 → "Medical File"
 *   "HomePage.API"                                      → "Home Page"
 *   "macPhrmcIntegrationToClics.ws.provider"            → "Phrmc Integration To Clics"
 */
export function humanizeFeatureName(serviceName: string): string {
  let s = serviceName;
  // Drop the parenthesized path suffix and anything after a space.
  s = s.split("(")[0]!.trim();
  s = s.split(" ")[0]!;
  // Drop extension suffixes (.Api, .API, .Services, .ws.provider, etc.)
  s = s.replace(/\.(API|Api|Services|ws\.provider|asmx|ws|provider)(:\d+)?$/, "");
  // Drop port suffixes like `:80`, `:8787`.
  s = s.replace(/:\d+$/, "");
  // Drop trailing version digits (MaccabiTestResults6 → MaccabiTestResults).
  s = s.replace(/(\D)(\d+)$/, "$1");
  // Strip leading lowercase "mac" prefix (Maccabi internal convention).
  if (/^mac[A-Z]/.test(s)) s = s.slice(3);
  // Split camelCase / PascalCase → spaces.
  s = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Title-case the words (preserve 'SSO' etc. as-is if all caps short).
  const words = s.split(" ").filter(Boolean);
  const titled = words.map((w) => {
    if (w.length <= 4 && w === w.toUpperCase()) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  return titled.join(" ");
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// -----------------------------------------------------------------------------

export interface ExtractFeaturesOptions {
  /** If provided, limit features to services whose id is in this set. */
  scopeToIds?: Set<string>;
}

/**
 * Given a list of services and their call graph, emit one FeatureCandidate
 * per service that looks like a feature API. Direct callers become upstream;
 * direct callees become downstream.
 *
 * Pure: no I/O. Unit-testable with synthetic inputs.
 */
export function extractFeatures(
  services: ServiceRecord[],
  calls: CallEdge[],
  opts: ExtractFeaturesOptions = {},
): FeatureCandidate[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const scope = opts.scopeToIds;

  const upstream = new Map<string, Set<string>>(); // callee → { callers }
  const downstream = new Map<string, Set<string>>(); // caller → { callees }
  for (const e of calls) {
    if (!byId.has(e.fromId) || !byId.has(e.toId)) continue;
    if (!upstream.has(e.toId)) upstream.set(e.toId, new Set());
    upstream.get(e.toId)!.add(e.fromId);
    if (!downstream.has(e.fromId)) downstream.set(e.fromId, new Set());
    downstream.get(e.fromId)!.add(e.toId);
  }

  const out: FeatureCandidate[] = [];
  const usedSlugs = new Set<string>();
  for (const s of services) {
    if (scope && !scope.has(s.id)) continue;
    if (!looksLikeFeatureApi(s.name)) continue;
    const featureName = humanizeFeatureName(s.name);
    if (!featureName) continue;
    let slug = slugify(featureName);
    // If two services distill to the same slug (e.g. duplicate names), append
    // a short disambiguator so each candidate has a stable unique id.
    if (usedSlugs.has(slug)) {
      const short = s.id.replace(/^canonical-/, "").slice(0, 8);
      slug = `${slug}-${short}`;
    }
    usedSlugs.add(slug);

    out.push({
      id: `bp-feature-${slug}`,
      name: featureName,
      coreId: s.id,
      sourceName: s.name,
      scope: "feature",
      components: {
        core: s.id,
        upstream: Array.from(upstream.get(s.id) ?? []),
        downstream: Array.from(downstream.get(s.id) ?? []),
      },
      inferenceMethod: `feature-api-pattern + call-graph-walk on "${s.name}"`,
    });
  }
  return out;
}
