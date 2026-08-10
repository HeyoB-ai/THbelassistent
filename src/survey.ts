import { z } from "zod";

/**
 * De enquête staat hier één keer gedefinieerd.
 *
 * Hetzelfde bestand voedt:
 *   - het JSON-schema van de tool die de telefoonassistent aanroept
 *   - de velden van het webformulier op /s/[token]
 *   - de bevestigingsmail
 *   - de Excel-export
 *
 * Wijzig je een vraag, dan wijzigen alle vier mee. Dat is het hele punt.
 */

export type Question = {
  key: string;
  /** Wat de assistent letterlijk zegt aan de telefoon. */
  spoken: string;
  /** Het label boven het invoerveld op het webformulier. */
  label: string;
  /** Toelichting onder het veld, alleen web. */
  hint?: string;
  input: "number" | "text" | "choice" | "boolean";
  options?: { value: string; label: string }[];
  required: boolean;
  /**
   * Vervolgvraag: alleen stellen als deze voorwaarde geldt. De tekst gaat
   * woordelijk de systeemprompt in, dus schrijf 'm als instructie aan de
   * assistent. Op het webformulier staat het veld gewoon altijd.
   */
  askWhen?: string;
  /**
   * Geen vraag aan de partner, maar iets wat de assistent zelf vaststelt uit
   * het gesprek. Staat niet op het webformulier en niet in de vragenlijst die
   * de assistent afwerkt, maar telt verder als een gewoon antwoord: het gaat
   * mee in het toolschema, het dashboard en de export.
   */
  internal?: boolean;
  /** Assistent leest het antwoord terug ter controle. Aan voor alles wat telt. */
  confirm: boolean;
};

export const QUESTIONS: Question[] = [
  {
    key: "headcount",
    spoken:
      "Hoeveel medewerkers heeft {{partner}} op dit moment in vaste of " +
      "tijdelijke dienst? Het gaat om het aantal personen, niet om fte.",
    label: "Aantal medewerkers in dienst",
    // De afbakening zit bewust in de vraag zelf, zodat er geen losse
    // vervolgvraag over oproepkrachten en stagiairs meer nodig is.
    hint: "Personen in vaste of tijdelijke dienst, niet omgerekend naar fte. Oproepkrachten en stagiairs tellen niet mee.",
    input: "number",
    required: true,
    confirm: true, // dit cijfer raakt de partnerbijdrage — altijd teruglezen
  },
  {
    key: "contact_for_billing",
    spoken:
      "Wie kunnen we bij {{partner}} het beste benaderen over de jaarlijkse partnerbijdrage?",
    label: "Contactpersoon voor de partnerbijdrage",
    input: "text",
    required: false,
    confirm: false,
  },
  {
    key: "ai_interest",
    spoken:
      "Als {{org}} zetten we in op het promoten van AI voor onze partners. " +
      "Daarvoor hebben we de AI-cirkel opgezet, en bouwen we applicaties zoals " +
      "deze. Bent u geïnteresseerd om meer te leren over de inzet van AI " +
      "binnen uw onderneming?",
    label: "Interesse in AI",
    hint: "Bij interesse neemt een collega hierover contact op.",
    input: "choice",
    options: [
      { value: "yes", label: "Ja" },
      { value: "no", label: "Nee" },
    ],
    required: true,
    confirm: false,
  },
  {
    key: "ai_contact",
    spoken: "Met wie kan mijn collega hierover het beste contact opnemen?",
    label: "Contactpersoon voor AI",
    hint: "Alleen invullen als u interesse heeft in AI.",
    input: "text",
    required: false,
    // Zonder naam heeft de collega die opvolgt wel een 'ja' maar niemand om te
    // bellen. Bij 'nee' is de vraag zinloos, dus die slaan we over.
    askWhen: 'de partner JA antwoordde op ai_interest — bij "nee" sla je hem over',
    confirm: false,
  },
  {
    key: "company_name_confirmed",
    // Wordt niet als vraag gesteld: dit volgt uit de bedrijfsbevestiging in de
    // opening. Staat "no", dan is het telefoonnummer mogelijk aan de verkeerde
    // partner gekoppeld of is de naam verouderd — werk voor de administratie.
    spoken: "",
    label: "Bedrijfsnaam bevestigd",
    input: "choice",
    options: [
      { value: "yes", label: "Ja" },
      { value: "no", label: "Nee — naam niet herkend" },
    ],
    required: false,
    internal: true,
    confirm: false,
  },
];

/**
 * Zod-schema, afgeleid van bovenstaande definitie.
 *
 * ai_interest staat hier optioneel terwijl de vraag wél altijd gesteld wordt:
 * wie er niet op wil antwoorden, moet daarmee niet zijn hele — verder complete
 * — antwoord ongeldig maken en opnieuw gebeld worden.
 */
export const AnswerSchema = z.object({
  headcount: z.number().int().min(0).max(100_000),
  contact_for_billing: z.string().max(200).optional(),
  ai_interest: z.enum(["yes", "no"]).optional(),
  ai_contact: z.string().max(200).optional(),
  company_name_confirmed: z.enum(["yes", "no"]).optional(),
});

export type Answers = z.infer<typeof AnswerSchema>;

/**
 * De vraag zoals hij uitgesproken wordt, met de plaatshouders ingevuld.
 * {{partner}} is het bedrijf dat gebeld wordt, {{org}} zijn wij.
 */
export function spokenText(q: Question, vars: { partner: string; org: string }): string {
  return q.spoken
    .replace(/\{\{partner\}\}/g, vars.partner)
    .replace(/\{\{org\}\}/g, vars.org);
}

/** JSON-schema voor de Anthropic-tool, afgeleid van dezelfde vragen. */
export function toolInputSchema() {
  const properties: Record<string, unknown> = {};
  for (const q of QUESTIONS) {
    if (q.input === "number") {
      properties[q.key] = { type: "integer", description: q.label };
    } else if (q.input === "choice") {
      properties[q.key] = {
        type: "string",
        enum: q.options!.map((o) => o.value),
        description: `${q.label}. ${q.options!.map((o) => `${o.value} = ${o.label}`).join("; ")}`,
      };
    } else {
      properties[q.key] = { type: "string", description: q.label };
    }
  }

  return {
    type: "object" as const,
    properties: {
      ...properties,
      completion: {
        type: "string",
        enum: ["completed", "partial", "refused", "no_time"],
        description:
          "completed = alle verplichte vragen beantwoord. " +
          "partial = gesprek eindigde voortijdig. " +
          "refused = partner wil niet meedoen aan de enquête. " +
          "no_time = partner heeft nu geen tijd, maar wijst de enquête niet af; " +
          "we bellen later terug. Gebruik no_time nooit als iemand écht weigert.",
      },
      confidence: {
        type: "string",
        enum: ["high", "low"],
        description:
          "low als je het aantal medewerkers niet goed hebt verstaan of " +
          "de partner het zelf niet zeker wist. Bij low gaat het naar handmatige controle.",
      },
      callback_requested_at: {
        type: "string",
        description:
          "ISO-tijdstip als de partner om een terugbelmoment vroeg. Anders weglaten.",
      },
    },
    required: ["completion", "confidence"],
  };
}

export const LABELS: Record<string, string> = Object.fromEntries([
  ...QUESTIONS.map((q) => [q.key, q.label]),
  ...QUESTIONS.flatMap((q) =>
    (q.options ?? []).map((o) => [`${q.key}:${o.value}`, o.label]),
  ),
]);

/**
 * Eén opgeslagen antwoord, klaar om te tonen. Een keuze als "contracted" is
 * voor een lezer nietszeggend; hier wordt dat "Alleen vast en tijdelijk
 * personeel". Leeg antwoord geeft een lege string, zodat de aanroeper zelf
 * bepaalt wat er dan komt te staan ("—" op het scherm, niets in Excel).
 *
 * Het dashboard en de Excel-export gebruiken dit allebei, zodat een gewijzigde
 * vraag of een nieuwe keuze-optie meteen op beide plekken goed staat.
 */
export function answerLabel(key: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "ja" : "nee";
  const raw = String(value).trim();
  if (!raw) return "";
  return LABELS[`${key}:${raw}`] ?? raw;
}
