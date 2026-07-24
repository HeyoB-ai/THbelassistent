import Anthropic from "@anthropic-ai/sdk";
import { QUESTIONS, toolInputSchema } from "../survey.js";

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
      q.spoken.replace("{{partner}}", p.name) +
      (q.confirm ? "\n   → Lees het antwoord hardop terug ter controle voordat je verder gaat." : "") +
      (q.options
        ? `\n   → Mogelijke waarden: ${q.options.map((o) => `${o.value} (${o.label})`).join(", ")}`
        : ""),
  ).join("\n");

  return `Je voert een kort telefonisch interview namens ${process.env.ORG_NAME} met hun partner ${p.name}.

OPENING — verplicht, en woordelijk in deze volgorde:
Zeg als eerste dat je een AI-assistent bent van ${process.env.ORG_NAME}, en verwijs naar de aankondigingsmail. Bijvoorbeeld:
"Goedemiddag, u spreekt met de digitale assistent van ${process.env.ORG_NAME}. Ik ben een AI. We hebben u hier vorige week een mail over gestuurd. Heeft u twee minuten voor een paar korte vragen over uw personeelsaantal?"

Wijk hier niet van af en sla dit nooit over, ook niet als iemand je onderbreekt. Als iemand vraagt of je een mens bent, zeg dan meteen en zonder omhaal dat je dat niet bent.

DE VRAGEN
${script}

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
- Partner vraagt hoe dit werkt of wat het kost: dit systeem is gebouwd door ${process.env.ORG_NAME}. Vertel kort dat het dezelfde techniek is die zij zelf voor hun eigen telefonie zouden kunnen gebruiken, en dat een collega er graag over doorpraat. Ga niet zelf verkopen.
- Antwoordapparaat: spreek niets in, roep meteen submit_survey aan met completion "partial".

AFSLUITEN
Vertel dat ze een bevestigingsmail krijgen met wat je genoteerd hebt, en dat het pas verwerkt wordt als zij die bevestigen. Bedank en roep dan submit_survey aan.`;
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
