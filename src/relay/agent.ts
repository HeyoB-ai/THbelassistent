import Anthropic from "@anthropic-ai/sdk";
import { QUESTIONS, toolInputSchema, spokenText } from "../survey.js";

/** Zonder ORG_NAME zou de verplichte opening "van undefined" zeggen. */
const ORG = process.env.ORG_NAME || "TechnoHub";

/**
 * Het model waarmee het gesprek gevoerd wordt.
 *
 * Haiku is hier de juiste keuze: korte gestructureerde antwoorden in een strak
 * enquêtegesprek, waarbij lage latency zwaarder weegt dan diepgang. Wil je
 * Sonnet ernaast leggen, zet dan SURVEY_MODEL=claude-sonnet-5 in de omgeving —
 * geen codewijziging nodig.
 *
 * Bewust `||` en niet `??`: een lege SURVEY_MODEL="" zou anders doorgegeven
 * worden en een 404 opleveren.
 */
const MODEL = process.env.SURVEY_MODEL || "claude-haiku-4-5";

// TODO: tijdelijk voor diagnose — verwijderen zodra de latency verklaard is.
console.log(`[llm] model=${MODEL}${process.env.SURVEY_MODEL ? "" : " (standaard, SURVEY_MODEL niet gezet)"}`);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type PartnerContext = {
  id: string;
  name: string;
  contactName: string | null;
  knownHeadcount: number | null;
};

export type Turn = { role: "user" | "assistant"; content: string; at: string };

export type SubmitPayload = {
  completion: "completed" | "partial" | "refused" | "no_time";
  confidence: "high" | "low";
  callback_requested_at?: string;
  [key: string]: unknown;
};

/**
 * De opening staat hier als vaste tekst en gaat NIET langs het model.
 *
 * Een LLM-aanroep kostte hier zo'n zeven seconden stilte nadat de gebelde
 * opneemt — genoeg om op te hangen. De tekst is toch woordelijk voorgeschreven,
 * dus er valt niets te genereren. De relay spreekt dit uit zodra de verbinding
 * staat; het model neemt het gesprek daarna over.
 *
 * De AI-vermelding is wettelijk verplicht (EU AI Act, art. 50) en staat daarom
 * in de eerste zin.
 */
export const OPENING =
  `Goedendag, u spreekt met de digitale AI-assistent van ${ORG}. ` +
  "We zetten AI in om enerzijds een test uit te voeren, en anderzijds omdat we " +
  "een aantal gegevens van u willen nagaan. We hebben u hier vorige week een " +
  "mail over gestuurd. Heeft u twee minuten om een paar korte vragen te " +
  "beantwoorden? De gegevens worden vertrouwelijk behandeld.";

/** Woordelijke afronding als de gebelde nu geen tijd heeft. */
export const NO_TIME_CLOSING =
  "Geen probleem, ik begrijp het. U heeft van ons ook een mail ontvangen met " +
  "een link waarmee u het zelf kunt invullen wanneer het u beter uitkomt. " +
  "Anders proberen wij u op een ander moment nog eens te bereiken. " +
  "Een prettige dag verder.";

const SUBMIT_TOOL = {
  name: "submit_survey",
  description:
    "Roep dit precies één keer aan, aan het einde van het gesprek. Ook als het " +
    "gesprek voortijdig eindigt of de partner niet wil meedoen — vul dan " +
    "completion in als 'partial' of 'refused' en laat onbekende velden weg. " +
    "Na het aanroepen van deze tool wordt het gesprek beëindigd.",
  input_schema: toolInputSchema(),
};

/** Geëxporteerd zodat de omvang te meten is zonder een gesprek te voeren. */
export function systemPrompt(p: PartnerContext) {
  const script = QUESTIONS.map(
    (q, i) =>
      // "(optioneel)" sloeg eerder op de vraag zelf; het model liet vraag 2
      // daarom weg. Optioneel is alleen het ANTWOORD.
      `${i + 1}. [${q.key}]${q.required ? "" : " (het antwoord mag leeg blijven — de vraag stel je wél)"} ` +
      spokenText(q, { partner: p.name, org: ORG }) +
      (q.confirm ? "\n   → Lees het antwoord hardop terug ter controle voordat je verder gaat." : "") +
      (q.options
        ? `\n   → Mogelijke waarden: ${q.options.map((o) => `${o.value} (${o.label})`).join(", ")}`
        : ""),
  ).join("\n");

  return `Je voert een kort telefonisch interview namens ${ORG} met hun partner ${p.name}.

DE OPENING IS AL UITGESPROKEN
De begroeting is zojuist voorgelezen en staat als jouw eerste beurt in de gespreksgeschiedenis:
"${OPENING}"
Begroet dus niet opnieuw en herhaal deze tekst niet. Reageer op wat de gebelde erop antwoordt.
Vraagt iemand of hij met een mens spreekt, bevestig dan meteen en zonder omhaal dat je een AI bent en geen mens.

DE VRAGEN — alle drie, in deze volgorde, één tegelijk
${script}

Stel alle drie de vragen. Sla er nooit één over — ook niet als het antwoord optioneel is, ook niet als je denkt het antwoord al te kennen, en ook niet om het gesprek korter te maken. Na het personeelsaantal komt eerst de contactpersoon voor de bijdrage, en pas daarna de vraag over AI. Ga pas door naar de volgende vraag als de vorige beantwoord is of de partner er duidelijk geen antwoord op wil geven.

NU GEEN TIJD — niet hetzelfde als weigeren
Zegt de gebelde dat hij nu geen tijd heeft, dat het slecht uitkomt, of antwoordt hij "nee" op de vraag of hij twee minuten heeft, zeg dan woordelijk:
"${NO_TIME_CLOSING}"
Rond daarna direct af met submit_survey en completion "no_time". Dring niet aan en probeer niet alsnog één vraag te stellen.
Let op het verschil: wie de enquête zelf afwijst ("ik doe niet mee", "geen interesse") krijgt completion "refused". Wie alleen nú niet kan, krijgt "no_time" — die bellen we later terug.

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
  /** Alleen voor de tijdelijke latency-logging: het hoeveelste model-antwoord. */
  private turn = 1;

  constructor(private partner: PartnerContext) {}

  /** Geef een uiting van de beller door; levert de tekst die uitgesproken moet worden. */
  async respondTo(utterance: string): Promise<string> {
    this.messages.push({ role: "user", content: utterance });
    this.transcript.push({ role: "user", content: utterance, at: new Date().toISOString() });
    return this.run();
  }

  /**
   * De vaste opening, zonder LLM-aanroep — de gebelde hoort dit meteen.
   *
   * De tekst gaat wel als eerste assistent-beurt de geschiedenis in, zodat het
   * model weet wat er al gezegd is en niet opnieuw begint te begroeten.
   */
  openScripted(): string {
    this.messages.push({ role: "user", content: "[De telefoon is opgenomen.]" });
    this.messages.push({ role: "assistant", content: OPENING });
    this.transcript.push({ role: "assistant", content: OPENING, at: new Date().toISOString() });
    return OPENING;
  }

  private async run(): Promise<string> {
    const system = systemPrompt(this.partner);

    // TODO: tijdelijk voor diagnose — verwijderen zodra de latency verklaard is.
    // Dit is de enige plek in een beurt waar we op iets externs wachten, dus
    // deze meting zegt of de stilte na een antwoord van het model komt.
    const started = Date.now();

    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system,
      tools: [SUBMIT_TOOL as Anthropic.Tool],
      messages: this.messages,
    });

    const ms = Date.now() - started;
    const u = res.usage;
    console.log(
      `[llm] ${MODEL} beurt ${this.turn} — ${ms}ms | in ${u.input_tokens} tok ` +
        `(cache write ${u.cache_creation_input_tokens ?? 0}, read ${u.cache_read_input_tokens ?? 0}) ` +
        `| uit ${u.output_tokens} tok | stop=${res.stop_reason} | systeemprompt ${system.length} tekens`,
    );
    this.turn++;

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
