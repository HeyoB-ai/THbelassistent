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
  /** Assistent leest het antwoord terug ter controle. Aan voor alles wat telt. */
  confirm: boolean;
};

export const QUESTIONS: Question[] = [
  {
    key: "headcount",
    spoken:
      "Hoeveel medewerkers heeft {{partner}} op dit moment in dienst? " +
      "Het gaat om het aantal personen, niet om fte.",
    label: "Aantal medewerkers in dienst",
    hint: "Aantal personen op de loonlijst, niet omgerekend naar fte.",
    input: "number",
    required: true,
    confirm: true, // dit cijfer raakt de bijdrage — altijd terugkoppelen
  },
  {
    key: "headcount_basis",
    spoken:
      "En is dat inclusief oproepkrachten en stagiairs, of alleen vast en tijdelijk personeel?",
    label: "Wat zit er in dat aantal?",
    input: "choice",
    options: [
      { value: "all", label: "Inclusief oproepkrachten en stagiairs" },
      { value: "contracted", label: "Alleen vast en tijdelijk personeel" },
      { value: "unsure", label: "Weet ik niet zeker" },
    ],
    required: true,
    confirm: false,
  },
  {
    key: "expected_change",
    spoken:
      "Verwacht u dat dit aantal het komende jaar groeit, gelijk blijft, of krimpt?",
    label: "Verwachting komend jaar",
    input: "choice",
    options: [
      { value: "grow", label: "Groeit" },
      { value: "stable", label: "Blijft gelijk" },
      { value: "shrink", label: "Krimpt" },
      { value: "unsure", label: "Weet ik niet" },
    ],
    required: false,
    confirm: false,
  },
  {
    key: "contact_for_billing",
    spoken:
      "Wie kunnen we bij {{partner}} het beste benaderen over de jaarlijkse bijdrage?",
    label: "Contactpersoon voor de bijdrage",
    input: "text",
    required: false,
    confirm: false,
  },
  {
    key: "remarks",
    spoken: "Heeft u verder nog iets dat u ons wilt meegeven?",
    label: "Opmerkingen",
    input: "text",
    required: false,
    confirm: false,
  },
];

/** Zod-schema, afgeleid van bovenstaande definitie. */
export const AnswerSchema = z.object({
  headcount: z.number().int().min(0).max(100_000),
  headcount_basis: z.enum(["all", "contracted", "unsure"]),
  expected_change: z.enum(["grow", "stable", "shrink", "unsure"]).optional(),
  contact_for_billing: z.string().max(200).optional(),
  remarks: z.string().max(2000).optional(),
});

export type Answers = z.infer<typeof AnswerSchema>;

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
        enum: ["completed", "partial", "refused"],
        description:
          "completed = alle verplichte vragen beantwoord. " +
          "partial = gesprek eindigde voortijdig. " +
          "refused = partner wil niet meedoen.",
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
