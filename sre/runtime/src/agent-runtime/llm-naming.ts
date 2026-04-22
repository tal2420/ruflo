// LLM-assisted rename pass for BusinessProcess nodes.
//
// The analyst produces *accurate* names ("Maccabi.Mdoc.Components.Drugs Approvals",
// "OffspringsAndDetailsExtend") that are unusable in a business-facing chart.
// This module calls Claude with Maccabi-domain guidance + worked examples and
// returns a clean {name, nameHe, rationale} triple.
//
// Design notes:
//   - The long system prompt is placed under cache_control so repeat calls in
//     a batch hit the Anthropic cache (~0.1× base cost for cached tokens). The
//     prompt is long enough (≥2048 tokens) to cross Sonnet 4.6's minimum
//     cacheable-prefix threshold. Verify hits via usage.cache_read_input_tokens.
//   - Model defaults to Sonnet 4.6 (balanced cost/quality for batch work);
//     override via SREFLOW_RENAME_MODEL env var. Opus for quality, Haiku for
//     speed/cost on trivial renames.
//   - Output goes through Zod (messages.parse) so the calling script gets
//     typed fields and no ad-hoc JSON.parse.
//   - The Anthropic client is injected, which keeps this module 100% unit
//     testable without a network.

import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";

export interface BpRenameContext {
  /** Current (typically ugly) name on the BP. */
  currentName: string;
  /** Optional current Hebrew name, if any. */
  currentNameHe?: string;
  /** Original source-system service name (e.g., from Dynatrace). */
  sourceName?: string;
  /** scope: "application" or "feature". */
  scope?: "application" | "feature";
  /** Hosting application (e.g., "Maccabi Online"). Set only for features. */
  hostedIn?: string;
  /** A few representative component names to give the LLM context. */
  sampleComponents?: string[];
}

export const RenameProposalSchema = z.object({
  name: z.string().min(2).max(80),
  nameHe: z.string().min(1).max(80),
  rationale: z.string().min(3).max(300),
});

export type RenameProposal = z.infer<typeof RenameProposalSchema>;

/** JSON Schema sent to the API — controls what the model emits. */
const RENAME_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "Short business-oriented English name (2-5 words). No .API/.Service suffix.",
      minLength: 2,
      maxLength: 80,
    },
    nameHe: {
      type: "string",
      description:
        "Hebrew translation in Hebrew script suitable for Maccabi internal usage.",
      minLength: 1,
      maxLength: 80,
    },
    rationale: {
      type: "string",
      description: "Brief (1-2 sentence) justification of the rename.",
      minLength: 3,
      maxLength: 300,
    },
  },
  required: ["name", "nameHe", "rationale"],
  additionalProperties: false,
} as const;

/**
 * Domain + style guidance. Long, stable, and cache-friendly. Worked examples
 * are included so the model is anchored by concrete cases from the Maccabi
 * landscape rather than guessing from the current name alone.
 */
const RENAME_SYSTEM_PROMPT = `You are a senior healthcare-IT business analyst working with Maccabi Healthcare Services, a large Israeli health maintenance organization (HMO).

Your job: given a Business Process record whose name is currently a technical/code-shaped string (extracted from Dynatrace, BMC Helix, or a service manifest), propose:
  1. A short, business-oriented **English** name (2 to 5 words) that a product manager or clinical stakeholder would recognize at a glance.
  2. An equivalent **Hebrew** name in Hebrew script (not Latin transliteration), suitable for internal Maccabi documentation.
  3. A brief **rationale** (one or two sentences) justifying the rename.

Return ONLY the structured JSON output that matches the schema the caller provides. No preamble, no markdown, no extra text.

## Context about Maccabi's portfolio

- **Maccabi Online (מכבי אונליין)** — the member-facing web portal and mobile app. Features include: appointment ordering, medical-file viewing, test-results display, communication with the doctor, push notifications, member requests and approvals, home page, SSO / identity, document / PDF generation, dynamic content cards.
- **Portal Rofe (פורטל רופא)** — the clinician / physician portal. "Rofe" (רופא) means doctor. Features include: patient search, contact patient, drug approvals, prescriptions, test-results review, PHR (תיק בריאות אישי), clinic tasks, clinic profile, clinic absences, online requests, upload files, news, articles, bookmarks, real-time notifications.
- **Protocols Nurse / CRM (פרוטוקולי אחיות)** — the nurse triage / clinical CRM platform.
- **Maccabi Tivi (מכבי טבעי)** — natural / complementary medicine program (Tivi = טבעי = natural).
- **Cannabis (קנאביס)** — the medical cannabis program, with license-request flows.
- **Shivuki (שיווק)** — marketing platform.
- **Service Guide (מדריך השירות)** — the service-catalogue knowledge base, member-facing and internal.
- **OpenShift** — a cluster of newer microservices (Login, Kafka, Medical File, Appointment Order, Test Results, Vaccinations, Purchased Medications, Wallet, Digital Cards, etc.).
- **ESB (Infra_ESB)** — the Enterprise Service Bus; infrastructure, NOT a business process.

## Transliteration glossary (Latin-script Hebrew that appears in service names)

Translate these to real Hebrew when you see them:
- Hitchayvuyot → התחייבויות (member commitments / pre-authorisations)
- HiuvYashir → חיוב ישיר (direct debit)
- ZimunKehila → זימון קהילה (community outreach call)
- Kehila → קהילה (community)
- Rofe → רופא (doctor)
- Shivuki → שיווק (marketing)
- Tivi → טבעי (natural)
- Phrmc → פרמצבטי (pharmaceutical — clinical pharmacy)
- CLICS → CLICS (keep; clinical information system brand; do not transliterate)

## Naming rules

1. **English name**: 2–5 words, business-oriented, in Title Case.
   - Strip \`.API\`, \`.Api\`, \`.Services\`, \`.ws.provider\`, port suffixes (\`:8878\`), and trailing version digits (e.g., \`6\` in \`MaccabiTestResults6\`).
   - Prefer an *action* noun phrase for user-facing features (e.g., "Schedule Appointment", "View Test Results") and a *descriptor* noun phrase for components ("Document Converter", "Web Frontend").
   - For applications/containers, keep the familiar brand ("Maccabi Online", "Portal Rofe") — do not over-translate.
   - Keep brand tokens in Latin script: Kafka, SAP, Active Directory, OpenShift, Umbraco, Tyto, React.

2. **Hebrew name**: 1–4 words, natural Hebrew.
   - Use real Hebrew script. Never transliterate (e.g., NOT "Maccabi Online"; yes "מכבי אונליין").
   - Brand tokens and technology names may stay in Latin (Kafka, SAP) inside the Hebrew string — this is idiomatic.
   - Be concise — avoid over-literal translations ("אפליקציה לניהול דחיפות של התראות" → just "ניהול התראות").

3. **Rationale**: one or two sentences. Explain *what* the service does (inferred from the name + hosting app + components), *why* you chose those words, and (if relevant) why you rejected an obvious alternative.

## Worked examples

Input: { currentName: "MaccabiTestResults6.API", sourceName: "MaccabiTestResults6.API (/MACCABIUTILSTESTRESULTS)", scope: "feature", hostedIn: "Maccabi Online", sampleComponents: ["ReactSiteV4", "MaccabiUtilsSso", "ConverterApi"] }
Output: { "name": "View Test Results", "nameHe": "צפייה בתוצאות בדיקה", "rationale": "A user action on a member portal — hosted in Maccabi Online, the core API is named for displaying lab test results to the member. The Hebrew uses ‘בדיקה’ (singular/mass noun) which reads naturally." }

Input: { currentName: "AppointmentOrder.Api", sourceName: "AppointmentOrder.Api (/APPOINTMENTORDERAPI)", scope: "feature", hostedIn: "Maccabi Online" }
Output: { "name": "Schedule Appointment", "nameHe": "קביעת תור", "rationale": "‘Order’ here means ordering/booking an appointment; the idiomatic business verb is schedule/book (‘קביעת תור’ in Hebrew)." }

Input: { currentName: "OffspringsAndDetailsExtend.API", scope: "feature", hostedIn: "openshift" }
Output: { "name": "Member Dependents Details", "nameHe": "פרטי תלויים", "rationale": "‘Offsprings’ is a codey spelling of dependents/children associated with a member. Extends the basic member-details call." }

Input: { currentName: "macHitchayvuyot.ws.provider", sourceName: "macHitchayvuyot.ws.provider", scope: "feature", hostedIn: "Unidentified_Mala_SG" }
Output: { "name": "Member Commitments", "nameHe": "התחייבויות חבר", "rationale": "Transliterates Hitchayvuyot → התחייבויות (pre-authorisation / commitment) — a member-facing service about insurance commitments." }

Input: { currentName: "Maccabi.Mdoc.Components.DrugsApprovals.Api", sourceName: "Maccabi.Mdoc.Components.DrugsApprovals.Api (/DRUGSAPPROVALSAPI)", scope: "feature", hostedIn: "Portal Rofe" }
Output: { "name": "Drug Approval Workflow", "nameHe": "אישור תרופות", "rationale": "Clinician workflow (in Portal Rofe) for approving medication prescriptions." }

Input: { currentName: "Maccabi_Online", sourceName: "Maccabi_Online", scope: "application" }
Output: { "name": "Maccabi Online", "nameHe": "מכבי אונליין", "rationale": "Known product name — keep as-is; use idiomatic Hebrew spelling." }

Input: { currentName: "portal_rofe", sourceName: "portal_rofe", scope: "application" }
Output: { "name": "Portal Rofe", "nameHe": "פורטל רופא", "rationale": "Clinician portal. ‘Rofe’ (רופא) = doctor." }

Input: { currentName: "ReactSiteV4", scope: "feature", hostedIn: "Maccabi Online" }
Output: { "name": "Web Frontend", "nameHe": "ממשק אינטרנט", "rationale": "Infrastructure component — the React-based web front-end that hosts the portal UI." }

Input: { currentName: "MaccabiKafka", scope: "feature", hostedIn: "openshift" }
Output: { "name": "Event Stream Service", "nameHe": "שירות Kafka", "rationale": "Shared Kafka-based messaging infrastructure. Keep ‘Kafka’ in Latin; it is the standard brand." }

Input: { currentName: "Default", sourceName: "Default Web Site:80 (/MaccabiUtilsMedicalFile)", scope: "feature", hostedIn: "Maccabi Online" }
Output: { "name": "Legacy IIS Endpoint", "nameHe": "נקודת קצה IIS", "rationale": "Generic IIS default-site routing; not a product feature. Labelled as infrastructure so it's clear no ownership change is implied." }

## Constraints — things to never do

- Never invent a business process from a name that says nothing (e.g., "Default Web Site", "Requests", "System.*"). For these, produce an infrastructure / runtime label, not a feature name.
- Never translate brand or technology names to Hebrew (Kafka, SAP, React, Active Directory, Umbraco, Tyto, OpenShift, CLICS).
- Never produce a Hebrew name in Latin script. If you are genuinely uncertain about a Hebrew spelling, use a neutral phrase like "שירות רפואי" rather than Latin transliteration.
- Never exceed 5 words in English or 4 words in Hebrew for a feature-scope name.
`;

export interface ProposeBetterNameOptions {
  /** Override the default model. Reads SREFLOW_RENAME_MODEL env var by default. */
  model?: string;
  /** max_tokens; defaults to 512 — enough for the structured output. */
  maxTokens?: number;
}

function formatUserPrompt(ctx: BpRenameContext): string {
  const payload = {
    currentName: ctx.currentName,
    currentNameHe: ctx.currentNameHe,
    sourceName: ctx.sourceName,
    scope: ctx.scope,
    hostedIn: ctx.hostedIn,
    sampleComponents: ctx.sampleComponents,
  };
  return (
    "Here is the Business Process to rename. Respond with the structured JSON output only.\n\n" +
    JSON.stringify(payload, null, 2)
  );
}

export function defaultModel(): string {
  return process.env.SREFLOW_RENAME_MODEL ?? "claude-sonnet-4-6";
}

/**
 * Call Claude to propose a better name. The `client` is injected so tests can
 * supply a mock. On success, returns the parsed Zod-validated proposal plus
 * the raw usage record (so the caller can log cache-hit metrics).
 *
 * Uses the API's explicit json_schema output-format contract (not the
 * zodOutputFormat helper) — keeps the contract independent of any particular
 * zod version and still validates the returned text through the zod schema.
 */
export async function proposeBetterName(
  client: Anthropic,
  ctx: BpRenameContext,
  opts: ProposeBetterNameOptions = {},
): Promise<{ proposal: RenameProposal; usage: Message["usage"] }> {
  const model = opts.model ?? defaultModel();
  // stream: false narrows the return type to Message (not MessageStream).
  const response = (await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 512,
    stream: false,
    system: [
      {
        type: "text",
        text: RENAME_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: formatUserPrompt(ctx) }],
    // The SDK's MessageCreateParams type lags the API's output_config field.
    // Cast narrowly; nothing else about the request shape changes.
    ...({
      output_config: {
        format: { type: "json_schema", schema: RENAME_JSON_SCHEMA },
      },
    } as Record<string, unknown>),
  } as Parameters<Anthropic["messages"]["create"]>[0])) as Message;

  const textBlock = response.content.find(
    (b): b is Extract<typeof response.content[number], { type: "text" }> =>
      b.type === "text",
  );
  if (!textBlock) {
    throw new Error(
      `LLM rename returned no text block (stop_reason=${response.stop_reason})`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error(
      `LLM rename returned non-JSON text: ${(e as Error).message}`,
    );
  }
  const parsed = RenameProposalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `LLM rename returned output that failed validation: ${parsed.error.message}`,
    );
  }
  return { proposal: parsed.data, usage: response.usage };
}

/** Heuristic: a name that's likely worth running through the LLM renamer. */
export function needsRename(name: string): boolean {
  if (!name) return false;
  // Contains dots — typical of Maccabi.Mdoc.Components.X style.
  if (name.includes(".")) return true;
  // Starts with lowercase mac* + capital — the Maccabi internal prefix that
  // escaped humanize (e.g., raw "macPhrmcIntegrationToClics").
  if (/^mac[A-Z]/.test(name)) return true;
  // More than three CamelCase runs with no spaces — jammed names.
  const humpSegments = name.split(/\s+/).filter((t) => /[A-Z][a-z]+[A-Z]/.test(t));
  if (humpSegments.length > 0 && !name.includes(" ")) return true;
  // Suspiciously long or contains port/path fragments.
  if (name.length > 40) return true;
  if (/:\d+/.test(name)) return true;
  return false;
}
