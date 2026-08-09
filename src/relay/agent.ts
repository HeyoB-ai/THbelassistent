import Anthropic from "@anthropic-ai/sdk";
import { QUESTIONS, toolInputSchema, spokenText } from "../survey.js";

/** Zonder ORG_NAME zou de verplichte opening "van undefined" zeggen. */
const ORG = process.env.ORG_NAME || "TechnoHub";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type PartnerContext = {
  id: string;
  name: string;
  contactName: string | null;
  knownHeadcount: number | null;
};

export type Turn = { role: "user" | "assistant"; content: string; at: string };

export type SubmitPayload = {
  completion: "completed" | "partial" | "refused";
  confidence: "high" | "low";
  callback_requested_at?: string;
  [key: string]: unknown;
};

const SUBMIT_TOOL = {
  name: "submit_survey",
  description:
    "Roep dit precies één keer aan, aan het einde van het gesprek. Ook als het " +
    "gesprek voortijdig eindigt of de partner niet wil meedoen — vul dan " +
    "completion in als 'partial' of 'refused' en laat onbekende velden weg. " +
    "Na het aanroepen van deze tool wordt het gesprek beëindigd.",
  input_schema: toolInputSchema(),
};

function systemPrompt(p: PartnerContext) {
  const script = QUESTIONS.map(
    (q, i) =>
      `${i + 1}. [${q.key}]${q.required ? "" : " (optioneel)"} ` +
      spokenText(q, { partner: p.name, org: ORG }) +
      (q.confirm ? "\n   → Lees het antwoord hardop terug ter controle voordat je verder gaat." : "") +
      (q.options
        ? `\n   → Mogelijke waarden: ${q.options.map((o) => `${o.value} (${o.label})`).join(", ")}`
        : ""),
  ).join("\n");

  return `Je voert een kort telefonisch interview namens ${ORG} met hun partner ${p.name}.

OPENING — verplicht, woordelijk, en nooit overslaan:
"Goedendag, u spreekt met de digitale AI-assistent van ${ORG}. We zetten AI in om enerzijds een test uit te voeren, en anderzijds omdat we een aantal gegevens van u willen nagaan. We hebben u hier vorige week een mail over gestuurd. Heeft u twee minuten om een paar korte vragen te beantwoorden? De gegevens worden vertrouwelijk behandeld."

Zeg dit letterlijk, ook als iemand je onderbreekt. Dat je een AI bent moet altijd klinken; dat is wettelijk verplicht. Vraagt iemand of hij met een mens spreekt, bevestig dan meteen en zonder omhaal dat je een AI bent en geen mens.

DE VRAGEN — in deze volgorde, één tegelijk
${script}

VERTAKKING BIJ VRAAG 3 (ai_interest)
- Antwoordt de partner JA, zeg dan: "Een van mijn collega's zal daar contact over opnemen." Leg vast: ai_interest = "yes".
- Antwoordt de partner NEE, zeg dan: "Dat is jammer, want naar onze mening gaat AI ook heel belangrijk worden in uw sector. Maar we zullen het hierbij laten." Leg vast: ai_interest = "no".
- Blijft het antwoord uit of is het ontwijkend, dring dan niet aan: laat ai_interest weg en rond af.

CONTEXT
- Bedrijf: ${p.name}
- Contactpersoon volgens onze administratie: ${p.contactName ?? "onbekend"}
${p.knownHeadcount ? `- Wat wij nu geregistreerd hebben: ${p.knownHeadcount} medewerkers. Noem dit getal NIET uit jezelf — je wilt hun eigen antwoord horen, niet een bevestiging van het onze. Wijkt hun antwoord er sterk van af, vraag dan één keer rustig door.` : ""}

HOE JE PRAAT
- Nederlands, u-vorm, kort. Dit is een telefoongesprek: één vraag per keer, geen opsommingen, geen lijstjes.
- Getallen spreek je voluit uit: "zevenenveertig", niet "47".
- Verstond je een getal niet zeker? Vraag door ("Was dat vijftien of vijftig?") en zet confidence op "low".
- Niet meer dan één beleefdheidszin achter elkaar. Mensen hebben het druk.

SITUATIES
- Receptie of iemand anders neemt op: vraag of je de juiste persoon kunt spreken. Kan dat niet, vraag wanneer je terug kunt bellen en geef dat door in callback_requested_at.
- Partner wil niet meedoen: accepteer dat direct, bedank, en sluit af met completion "refused". Blijf niet aandringen.
- Partner weet het aantal niet uit het hoofd: bied aan dat ze het via de link in de mail kunnen invullen. Sluit af met completion "partial".
- Partner vraagt hoe dit werkt of wat het kost: dit systeem is gebouwd door ${ORG}. Vertel kort dat het dezelfde techniek is die zij zelf voor hun eigen telefonie zouden kunnen gebruiken, en dat een collega er graag over doorpraat. Ga niet zelf verkopen.
- Antwoordapparaat: spreek niets in, roep meteen submit_survey aan met completion "partial".

AFSLUITEN
Vat kort samen wat je genoteerd hebt, bedank voor de tijd en rond af. Roep daarna submit_survey aan.`;
}

export class SurveyAgent {
  private messages: Anthropic.MessageParam[] = [];
  public transcript: Turn[] = [];
  public submitted: SubmitPayload | null = null;

  constructor(private partner: PartnerContext) {}

  /** Geef een uiting van de beller door; levert de tekst die uitgesproken moet worden. */
  async respondTo(utterance: string): Promise<string> {
    this.messages.push({ role: "user", content: utterance });
    this.transcript.push({ role: "user", content: utterance, at: new Date().toISOString() });
    return this.run();
  }

  /** De openingszin, zonder dat de beller al iets gezegd heeft. */
  async open(): Promise<string> {
    this.messages.push({
      role: "user",
      content: "[De telefoon is opgenomen. Begin het gesprek met de verplichte opening.]",
    });
    return this.run();
  }

  private async run(): Promise<string> {
    const res = await anthropic.messages.create({
      model: process.env.SURVEY_MODEL ?? "claude-haiku-4-5",
      max_tokens: 400,
      system: systemPrompt(this.partner),
      tools: [SUBMIT_TOOL as Anthropic.Tool],
      messages: this.messages,
    });

    this.messages.push({ role: "assistant", content: res.content });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();

    const toolUse = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUse) {
      this.submitted = toolUse.input as SubmitPayload;
      // Geen tool_result terug: het gesprek is hier klaar.
    }

    if (text) {
      this.transcript.push({ role: "assistant", content: text, at: new Date().toISOString() });
    }
    return text;
  }
}
