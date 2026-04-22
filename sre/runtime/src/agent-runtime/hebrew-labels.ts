// Hebrew translation module — converts English business-process names and
// relation labels into Hebrew for RTL visualisations.
//
// Implementation notes:
//   - The dictionary is intentionally conservative. Entries the author is not
//     confident about are omitted rather than guessed — a human reviewer
//     replaces missing translations at deploy time.
//   - The module treats translation in three layers:
//       1. Transliterations: Latin-script Hebrew → original (Hitchayvuyot → התחייבויות)
//       2. Phrase match: known business noun-phrases → Hebrew noun-phrase
//       3. Verb prefix: if the input starts with an English verb marker
//          ("View", "Order", "Submit") we translate the whole prefix-noun pair.
//   - Unknown text is returned unchanged; it's more honest than a bad guess.
//   - Brand / technology names (Kafka, NET, SAP, Umbraco, Tyto, API) are kept
//     in Latin script in Hebrew output; bidi rendering handles the mix.
//
// Language ops:
//   - This module is a seed dictionary for Maccabi's domain. A production
//     deployment would load the dictionary from a YAML maintained by the
//     product / localisation team, not embed it in code.

/** Latin-script transliterations of Hebrew words observed in Maccabi service names. */
export const TRANSLITERATIONS: Readonly<Record<string, string>> = Object.freeze({
  Hitchayvuyot: "התחייבויות",
  HiuvYashir: "חיוב ישיר",
  ZimunKehila: "זימון קהילה",
  Shivuki: "שיווק",
  Tivi: "טבעי",
  Rofe: "רופא",
  Kehila: "קהילה",
  Mdoc: "Mdoc", // brand / acronym — keep
});

/** Known multi-word business-process and noun phrases, English → Hebrew. */
export const BUSINESS_TERMS: Readonly<Record<string, string>> = Object.freeze({
  // --- Member-facing features ---
  "Appointment Order": "הזמנת תור",
  "Maccabi Appointment Order": "הזמנת תור – מכבי",
  "Medical File": "תיק רפואי",
  "Maccabi Medical File": "תיק רפואי – מכבי",
  "Medical Files": "תיקים רפואיים",
  "Test Results": "תוצאות בדיקות",
  "Maccabi Test Results": "תוצאות בדיקות – מכבי",
  "Communication With Doctor": "תקשורת עם הרופא",
  "Home Page": "דף הבית",
  "Push Notification": "התראת דחיפה",
  "Push Management": "ניהול התראות",
  "Maccabi Requests And Approvals": "בקשות ואישורים – מכבי",
  "Requests And Approvals": "בקשות ואישורים",
  "Contact Patient": "צור קשר עם מטופל",
  "Digital Cards": "כרטיסים דיגיטליים",
  "Noahs Wallet": "הארנק של נח",
  Wallet: "ארנק",
  Vaccinations: "חיסונים",
  "Cannabis License": "רישיון קנאביס",
  "Contact US Cannabis License": "פנייה – רישיון קנאביס",
  "Unsubscribe Form": "טופס ביטול הרשמה",
  "Purchased Medication Report": "דו\"ח תרופות שנרכשו",
  "Member Details Minimal": "פרטי חבר – תמצית",
  "Offsprings And Details Extend": "פרטי ילדים – הרחבה",
  "Dynamic Category": "קטגוריה דינמית",
  "Main App": "אפליקציה ראשית",

  // --- Clinician-facing features (Portal Rofe) ---
  Tasks: "משימות",
  "Clinic Tasks": "משימות מרפאה",
  "Clinic Profile": "פרופיל מרפאה",
  "Clinic Absences API": "היעדרויות מרפאה",
  "Clinic Radar Api": "ראדאר מרפאה",
  "Search Patient": "חיפוש מטופל",
  "Online Requests": "בקשות אונליין",
  "Prescriptions App": "מרשמים",
  "Drugs Approvals": "אישורי תרופות",
  "Medication Approval": "אישור תרופה",
  "Real Time App": "יישום בזמן אמת",
  "Upload Files": "העלאת קבצים",
  Files: "קבצים",
  News: "חדשות",
  Articles: "מאמרים",
  "Articles.Api": "מאמרים",
  Bookmarks: "סימניות",
  Phr: "תיק בריאות אישי (PHR)",

  // --- Generic components / shared infra ---
  Content: "תוכן",
  "Message Utils": "כלי הודעות",
  "Form Utils": "כלי טפסים",
  "Short Links": "קישורים קצרים",
  "Short Links NET": "קישורים קצרים (NET)",
  "Maccabi Login": "התחברות למכבי",
  Login: "התחברות",
  "Maccabi Kafka": "Kafka – מכבי",
  "All Actions": "כל הפעולות",
  "Maccabi Utils Tyto": "Tyto – כלים",
  "Maccabi Utils": "כלי מכבי",
  "Maccabi Utils.Active Directory": "Active Directory – כלי מכבי",

  // --- Application containers ---
  Maccabi_Online: "מכבי אונליין",
  "Maccabi Online": "מכבי אונליין",
  maccabi_tivi: "מכבי טבעי",
  "Maccabi Tivi": "מכבי טבעי",
  portal_rofe: "פורטל רופא",
  "Portal Rofe": "פורטל רופא",
  protocols_nurse: "פרוטוקולי אחיות",
  "Protocols Nurse": "פרוטוקולי אחיות",
  Shivuki: "שיווק",
  shivuki: "שיווק",
  Cannabis: "קנאביס",
  "Service Guide": "מדריך השירות",
  ServiceGuide: "מדריך השירות",
  "Unidentified Mala SG": "מדריך שירות – כללי",
  "Unidentified_Mala_SG": "מדריך שירות – כללי",
  openshift: "OpenShift",
  "Orders API": "API הזמנות",
  "Payments API": "API תשלומים",
  "Payments API (Production)": "API תשלומים (Production)",
});

/** Relation / role labels used in the rendered diagram. */
export const RELATION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  HOSTED_IN: "מתארח ב",
  REALIZED_BY: "ממומש ע\"י",
  CALLS: "קורא ל",
  DEPENDS_ON: "תלוי ב",
  core: "ליבה",
  upstream: "חזית / מפעיל",
  downstream: "תלויות",
  supporting: "תמיכה",
  application: "יישום",
  feature: "תהליך עסקי",
});

/** Generic English verb/noun tokens → Hebrew, applied as last-resort word swaps. */
const TOKEN_MAP: Readonly<Record<string, string>> = Object.freeze({
  Medical: "רפואי",
  File: "תיק",
  Files: "תיקים",
  Results: "תוצאות",
  Test: "בדיקה",
  Tests: "בדיקות",
  Order: "הזמנה",
  Orders: "הזמנות",
  Appointment: "תור",
  Prescription: "מרשם",
  Prescriptions: "מרשמים",
  Drug: "תרופה",
  Drugs: "תרופות",
  Approval: "אישור",
  Approvals: "אישורים",
  Push: "התראת דחיפה",
  Notification: "התראה",
  Notifications: "התראות",
  Card: "כרטיס",
  Cards: "כרטיסים",
  Home: "בית",
  Page: "דף",
  Doctor: "רופא",
  Patient: "מטופל",
  Search: "חיפוש",
  Clinic: "מרפאה",
  Content: "תוכן",
  Login: "התחברות",
  Member: "חבר",
  Members: "חברים",
  Request: "בקשה",
  Requests: "בקשות",
  Tasks: "משימות",
  Task: "משימה",
  News: "חדשות",
  Upload: "העלאה",
  Download: "הורדה",
  Wallet: "ארנק",
  Link: "קישור",
  Links: "קישורים",
  Application: "יישום",
  Service: "שירות",
  Services: "שירותים",
  Authentication: "אימות",
  Vaccination: "חיסון",
  Vaccinations: "חיסונים",
  Cannabis: "קנאביס",
  Online: "אונליין",
  Offline: "לא מקוון",
  Communication: "תקשורת",
  Integration: "אינטגרציה",
  Maccabi: "מכבי",
  Components: "רכיבים",
  Details: "פרטים",
  Category: "קטגוריה",
  Absences: "היעדרויות",
  Profile: "פרופיל",
  Real: "מציאותי",
  Time: "זמן",
  List: "רשימה",
  Form: "טופס",
  Forms: "טפסים",
  Utils: "כלים",
  Message: "הודעה",
  Actions: "פעולות",
});

/** Tokens that should stay in Latin script (brand / technology / acronyms). */
const KEEP_LATIN = new Set([
  "API",
  "Api",
  "NET",
  "SAP",
  "SSO",
  "Kafka",
  "Umbraco",
  "Tyto",
  "Mdoc",
  "CRM",
  "PHR",
  "Phrmc",
  "CLICS",
  "Production",
  "Active",
  "Directory",
]);

function applyTransliterations(s: string): string {
  let out = s;
  for (const [lat, he] of Object.entries(TRANSLITERATIONS)) {
    out = out.split(lat).join(he);
  }
  return out;
}

function tokenTranslate(s: string): string {
  // Replace each run of alphabetic characters with its TOKEN_MAP translation
  // (if any), preserving non-alpha separators (dots, colons, commas). This
  // handles dotted namespaces like "Maccabi.Mdoc.Components.Drugs" where
  // individual words should translate but the structural dots remain.
  return s.replace(/[A-Za-z]+/g, (word) => {
    if (KEEP_LATIN.has(word)) return word;
    return TOKEN_MAP[word] ?? word;
  });
}

export interface TranslateResult {
  he: string;
  /** "exact" = whole-phrase match; "token" = per-word translation; "passthrough" = unchanged. */
  confidence: "exact" | "token" | "passthrough";
}

/**
 * Translate an English business label to Hebrew. Strategy:
 *   1. Exact whole-phrase match on the original input — dictionary keys are
 *      in English, so we consult them *before* any transliteration.
 *   2. Apply transliterations (Hitchayvuyot → התחייבויות) and retry exact match.
 *   3. Per-token lookup via TOKEN_MAP, with KEEP_LATIN tokens preserved.
 *   4. If nothing changed, return the (transliterated) original with
 *      "passthrough" — honest about not knowing.
 */
export function toHebrew(name: string): TranslateResult {
  if (!name) return { he: name, confidence: "passthrough" };
  const trimmed = name.trim();
  if (!trimmed) return { he: "", confidence: "passthrough" };

  // Step 1: exact match on the raw input.
  const exact = BUSINESS_TERMS[trimmed];
  if (exact) return { he: exact, confidence: "exact" };

  // Step 2: transliterate then retry exact match.
  const translit = applyTransliterations(trimmed);
  if (translit !== trimmed) {
    const exactTrans = BUSINESS_TERMS[translit];
    if (exactTrans) return { he: exactTrans, confidence: "exact" };
  }

  // Step 3: token-level translation.
  const tokened = tokenTranslate(translit);
  if (tokened !== translit) return { he: tokened, confidence: "token" };
  return { he: translit, confidence: "passthrough" };
}

export function roleLabel(role: string): string {
  return RELATION_LABELS[role] ?? role;
}
