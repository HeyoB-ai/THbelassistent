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
 * Stap 1 van de opening: begroeting, de verplichte AI-melding, en meteen de
 * vraag of we het juiste bedrijf aan de lijn hebben.
 *
 * Deze tekst gaat NIET langs het model — een LLM-aanroep kostte hier seconden
 * stilte, en er valt niets te genereren. De relay spreekt dit uit zodra de
 * verbinding staat.
 *
 * Bewust kort. De vorige opening was 341 tekens, ruim twintig seconden spreken
 * voordat de beller aan de beurt was; nu is er na één zin al een heen-en-weer.
 * De AI-melding zit in de eerste zin en blijft dus altijd staan — dat is
 * wettelijk verplicht (EU AI Act, art. 50).
 */
export function openingFor(partnerName: string): string {
  return `Goedendag, u spreekt met de AI-assistent van ${ORG}. Spreek ik met ${partnerName}?`;
}

/** Stap 2a: het vervolg zodra de beller de bedrijfsnaam bevestigt. */
export const OPENING_CONTINUATION =
  "Fijn. We willen graag een paar gegevens bij u nagaan, waarover u vorige week " +
  "een mail ontving. Heeft u twee minuten voor een paar korte vragen? " +
  "De gegevens worden vertrouwelijk behandeld.";

/** Stap 2b: de reactie als de beller de bedrijfsnaam niet herkent. */
export function nameMismatchFor(partnerName: string): string {
  return `Wat vreemd, in onze administratie is dit telefoonnummer gekoppeld aan ${partnerName}.`;
}

/**
 * Woordelijke afsluiting van een geslaagd gesprek.
 *
 * "Veel sterkte" stond hier eerder — dat zeg je tegen iemand die het moeilijk
 * heeft, niet tegen een partner die net twee minuten voor je vrijmaakte.
 */
export const CLOSING = "Dank u voor uw tijd en een prettige dag verder.";

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
  const script = QUESTIONS.filter((q) => !q.internal).map(
    (q, i) =>
      // "(optioneel)" sloeg eerder op de vraag zelf; het model liet vraag 2
      // daarom weg. Optioneel is alleen het ANTWOORD — behalve bij een
      // vervolgvraag, die echt voorwaardelijk is.
      `${i + 1}. [${q.key}]${
        q.askWhen
          ? ` (VERVOLGVRAAG — alleen stellen als ${q.askWhen})`
          : q.required
            ? ""
            : " (het antwoord mag leeg blijven — de vraag stel je wél)"
      } ` +
      spokenText(q, { partner: p.name, org: ORG }) +
      (q.confirm ? "\n   → Lees het antwoord hardop terug ter controle voordat je verder gaat." : "") +
      (q.options
        ? `\n   → Mogelijke waarden: ${q.options.map((o) => `${o.value} (${o.label})`).join(", ")}`
        : ""),
  ).join("\n");

  return `Je voert een kort telefonisch interview namens ${ORG} met hun partner ${p.name}.

DE OPENING IS AL UITGESPROKEN — DAT WAS STAP 1 VAN TWEE
Deze zin is zojuist voorgelezen en staat als jouw eerste beurt in de gespreksgeschiedenis:
"${openingFor(p.name)}"
Begroet dus niet opnieuw. Het antwoord van de beller hierop bepaalt wat je nu doet: stap 2A of stap 2B.
Vraagt iemand of hij met een mens spreekt, bevestig dan meteen en zonder omhaal dat je een AI bent en geen mens.

STAP 2A — de beller bevestigt ("ja", "daar spreekt u mee", "klopt")
Zeg dan woordelijk: "${OPENING_CONTINUATION}"
Leg vast: company_name_confirmed = "yes".
Stemt de beller daarna in, ga door naar vraag 1. Heeft hij geen tijd, volg dan NU GEEN TIJD hieronder.

STAP 2B — de beller ontkent ("nee", "dat is hier niet")
Zeg dan als eerste woordelijk: "${nameMismatchFor(p.name)}"
Leg vast: company_name_confirmed = "no".
Reageer daarna gewoon op wat de beller zegt, met één doel voor ogen: de vragen alsnog gesteld krijgen.
- Blijkt het hetzelfde bedrijf onder een andere naam, of heb je iemand aan de lijn die de vragen kan beantwoorden? Ga dan door met de tekst van stap 2A en daarna de vragen. Dit is verreweg het meest voorkomende geval.
- Alleen als overduidelijk is dat je een verkeerd nummer hebt — een privépersoon die niets met een bedrijf te maken heeft — bied dan je excuses aan, sluit vriendelijk af en roep submit_survey aan met completion "refused". Dring niet aan.
- Ga niet mee in zijpaden, ga niet uitleggen hoe onze administratie werkt, en beloof niets. Het doel blijft de enquête.

DE VRAGEN — in deze volgorde, één tegelijk
${script}

Stel de vragen die geen VERVOLGVRAAG zijn allemaal. Sla er nooit één over — ook niet als het antwoord optioneel is, ook niet als je denkt het antwoord al te kennen, en ook niet om het gesprek korter te maken. Na het personeelsaantal komt eerst de contactpersoon voor de jaarlijkse partnerbijdrage, en pas daarna de vraag over AI. Een VERVOLGVRAAG stel je alleen als de voorwaarde erbij geldt. Ga pas door naar de volgende vraag als de vorige beantwoord is of de partner er duidelijk geen antwoord op wil geven.

NU GEEN TIJD — niet hetzelfde als weigeren
Zegt de gebelde dat hij nu geen tijd heeft, dat het slecht uitkomt, of antwoordt hij "nee" op de vraag of hij twee minuten heeft, zeg dan woordelijk:
"${NO_TIME_CLOSING}"
Rond daarna direct af met submit_survey en completion "no_time". Dring niet aan en probeer niet alsnog één vraag te stellen.
Let op het verschil: wie de enquête zelf afwijst ("ik doe niet mee", "geen interesse") krijgt completion "refused". Wie alleen nú niet kan, krijgt "no_time" — die bellen we later terug.

VERTAKKING BIJ VRAAG 3 (ai_interest)
- Antwoordt de partner JA, zeg dan: "Een van mijn collega's zal daar contact over opnemen." Leg vast: ai_interest = "yes". Vraag daarna meteen door: "Met wie kan mijn collega hierover het beste contact opnemen?" en leg die naam vast in ai_contact. Zonder naam heeft de collega die opvolgt niemand om te bellen. Wil de partner geen naam geven, laat ai_contact dan leeg en dring niet aan.
- Antwoordt de partner NEE, zeg dan: "Dat is jammer, want naar onze mening gaat AI ook heel belangrijk worden in uw sector. Maar we zullen het hierbij laten." Leg vast: ai_interest = "no".
- Blijft het antwoord uit of is het ontwijkend, dring dan niet aan: laat ai_interest weg en rond af.
- Vraag NOOIT naar ai_contact als het antwoord "nee" was of uitbleef. Die vraag hoort alleen bij een ja.

CONTEXT
- Bedrijf: ${p.name}
- Contactpersoon volgens onze administratie: ${p.contactName ?? "onbekend"}
${p.knownHeadcount ? `- Wat wij nu geregistreerd hebben: ${p.knownHeadcount} medewerkers. Noem dit getal NIET uit jezelf — je wilt hun eigen antwoord horen, niet een bevestiging van het onze. Wijkt hun antwoord er sterk van af, vraag dan één keer rustig door.` : ""}

HOE JE PRAAT
- Nederlands, kort. Dit is een telefoongesprek: één vraag per keer, geen opsommingen, geen lijstjes.
- ALTIJD de u-vorm, het hele gesprek door, zonder één uitzondering. Nooit "je", "jij", "jouw" of "jullie" — ook niet in een bedankje. Het is "dank u", nooit "dank je". Zakt het gesprek in een informele toon, blijf dan zelf bij "u".
- Getallen spreek je voluit uit: "zevenenveertig", niet "47".
- Verstond je een getal niet zeker? Vraag door ("Was dat vijftien of vijftig?") en zet confidence op "low".
- Niet meer dan één beleefdheidszin achter elkaar. Mensen hebben het druk.

SITUATIES
- Receptie of iemand anders neemt op: vraag of je de juiste persoon kunt spreken. Kan dat niet, vraag wanneer je terug kunt bellen en geef dat door in callback_requested_at.
- Partner wil niet meedoen: accepteer dat direct, bedank, en sluit af met completion "refused". Blijf niet aandringen.
- Partner weet het aantal niet uit het hoofd: bied aan dat ze het via de link in de mail kunnen invullen. Sluit af met completion "partial".
- Partner vraagt hoe dit werkt of wat het kost: dit systeem is gebouwd door ${ORG}. Vertel kort dat het dezelfde techniek is die zij zelf voor hun eigen telefonie zouden kunnen gebruiken, en dat een collega er graag over doorpraat. Ga niet zelf verkopen.
- Partner vraagt waarom je naar een contactpersoon vraagt: leg kort uit dat je wilt weten wie je moet hebben als er iets over de jaarlijkse partnerbijdrage besproken moet worden.
- Antwoordapparaat: spreek niets in, roep meteen submit_survey aan met completion "partial".

AFSLUITEN
Vat in één zin samen wat je genoteerd hebt: het aantal medewerkers, de contactpersoon voor de partnerbijdrage, en of er interesse is in AI (met de naam erbij als die gegeven is).
Stel daarbij GEEN controlevraag. Geen "klopt dat?", geen "is dat juist?" — je wacht het antwoord toch niet af, en dan praat je over de partner heen. Het personeelsaantal heb je eerder in het gesprek al teruggelezen; dat is het controlemoment geweest.
Sluit daarna woordelijk af met: "${CLOSING}"
Roep daarna submit_survey aan.`;
}

export class SurveyAgent {
  private messages: Anthropic.MessageParam[] = [];
  public transcript: Turn[] = [];
  public submitted: SubmitPayload | null = null;
  /** Alleen voor de tijdelijke latency-logging: het hoeveelste model-antwoord. */
  private turn = 1;
  /** De lopende model-stream, zodat interrupt() 'm kan afkappen. */
  private active: { abort: () => void } | null = null;

  constructor(private partner: PartnerContext) {}

  /**
   * Geef een uiting van de beller door.
   *
   * `onChunk` krijgt de tekst stukje bij beetje binnen terwijl het model nog
   * schrijft, zodat de relay meteen kan laten uitspreken. De volledige tekst
   * komt daarnaast als returnwaarde terug, voor het transcript.
   */
  async respondTo(utterance: string, onChunk?: (chunk: string) => void): Promise<string> {
    this.messages.push({ role: "user", content: utterance });
    this.transcript.push({ role: "user", content: utterance, at: new Date().toISOString() });
    return this.run(onChunk);
  }

  /**
   * De beller praat er doorheen: kap de lopende model-aanroep af.
   *
   * Zonder dit blijft het model doorschrijven terwijl niemand meer luistert —
   * dat kost tokens en zorgt dat de assistent straks reageert op een vraag die
   * de beller allang heeft ingetrokken.
   */
  interrupt() {
    this.active?.abort();
  }

  /**
   * De vaste opening, zonder LLM-aanroep — de gebelde hoort dit meteen.
   *
   * De tekst gaat wel als eerste assistent-beurt de geschiedenis in, zodat het
   * model weet wat er al gezegd is en niet opnieuw begint te begroeten.
   */
  openScripted(): string {
    const opening = openingFor(this.partner.name);
    this.messages.push({ role: "user", content: "[De telefoon is opgenomen.]" });
    this.messages.push({ role: "assistant", content: opening });
    this.transcript.push({ role: "assistant", content: opening, at: new Date().toISOString() });
    return opening;
  }

  private async run(onChunk?: (chunk: string) => void): Promise<string> {
    const system = systemPrompt(this.partner);
    const started = Date.now();
    let firstTokenAt: number | null = null;
    let streamed = "";

    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 400,
      system,
      tools: [SUBMIT_TOOL as Anthropic.Tool],
      messages: this.messages,
    });
    this.active = stream;

    // Elk stukje tekst gaat meteen door naar de beller. De tool-call wordt hier
    // bewust niet aangeraakt: die komt pas uit finalMessage(), als hij compleet
    // en geparsed is. Half binnengekomen JSON mag nooit de database in.
    stream.on("text", (delta) => {
      if (firstTokenAt === null) firstTokenAt = Date.now();
      streamed += delta;
      onChunk?.(delta);
    });

    let res: Anthropic.Message;
    try {
      res = await stream.finalMessage();
    } catch (err) {
      this.active = null;
      // Afgekapt door interrupt(): geen submitted, wél vastleggen wat er al
      // gezegd is, zodat het model in de volgende beurt weet waar het bleef.
      if (isAbort(err)) {
        const partial = streamed.trim();
        console.log(`[llm] ${MODEL} beurt ${this.turn} — afgebroken na ${Date.now() - started}ms`);
        this.turn++;
        if (partial) {
          this.messages.push({ role: "assistant", content: partial });
          this.transcript.push({
            role: "assistant",
            content: partial,
            at: new Date().toISOString(),
          });
        }
        return partial;
      }
      throw err;
    }
    this.active = null;

    // TODO: tijdelijk voor diagnose — verwijderen zodra de latency verklaard is.
    // ttft is wat de beller merkt: hoe lang het duurt voor er geluid komt.
    const ms = Date.now() - started;
    const ttft = firstTokenAt === null ? "n.v.t. (alleen tool-call)" : `${firstTokenAt - started}ms`;
    const u = res.usage;
    console.log(
      `[llm] ${MODEL} beurt ${this.turn} — ttft ${ttft} | totaal ${ms}ms | ` +
        `in ${u.input_tokens} tok (cache write ${u.cache_creation_input_tokens ?? 0}, ` +
        `read ${u.cache_read_input_tokens ?? 0}) | uit ${u.output_tokens} tok | ` +
        `stop=${res.stop_reason} | systeemprompt ${system.length} tekens`,
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

      // Meteen een tool_result erachteraan. Normaal hangen we vlak hierna op en
      // komt er geen model-aanroep meer, maar er zit vier seconden tussen — en
      // zegt de beller in die tijd nog iets, dan ging de geschiedenis met een
      // tool_use zonder tool_result naar de API: 400 "`tool_use` ids were found
      // without `tool_result` blocks immediately after". Dat brak het gesprek.
      this.messages.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUse.id, content: "Genoteerd." },
        ],
      });
    }

    if (text) {
      this.transcript.push({ role: "assistant", content: text, at: new Date().toISOString() });
    }
    return text;
  }
}

/** Een afgebroken stream is geen fout om over te struikelen. */
function isAbort(err: unknown): boolean {
  const e = err as { name?: string; constructor?: { name?: string } } | null;
  return e?.name === "AbortError" || e?.constructor?.name === "APIUserAbortError";
}
