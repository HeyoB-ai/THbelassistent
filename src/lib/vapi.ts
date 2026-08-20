import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Alles wat nodig is om een Vapi-webhook te lezen, los van de route zelf.
 *
 * Staat apart omdat het de enige code in dit project is die afhangt van een
 * payload-vorm die wij niet in de hand hebben. Hier zit de defensie: de paden
 * waar Vapi de antwoorden neerzet, de drie manieren waarop het zich
 * legitimeert, en het opschonen van wat een spraakmodel ervan bakt. Zonder
 * database eromheen, zodat je het los kunt uitproberen op een echte payload.
 */

/** De zes velden die de Structured Output van Vapi oplevert. */
export const FIELDS = [
  "headcount",
  "contact_for_billing",
  "contact_for_billing_email",
  "contact_for_activities",
  "contact_for_activities_email",
  "company_name_confirmed",
] as const;

// ---------------------------------------------------------------------------
// Authenticatie
// ---------------------------------------------------------------------------

/** Eén header opvragen; zo hoeft dit bestand niets van Next.js te weten. */
export type Headers = (name: string) => string | null;

/**
 * Is deze request echt van Vapi?
 *
 * Vapi kent drie manieren om zich te legitimeren, en welke je krijgt hangt af
 * van het soort credential dat in het dashboard is ingesteld. We accepteren ze
 * alle drie tegen hetzelfde geheim, zodat een wijziging aan de Vapi-kant dit
 * endpoint niet omver haalt:
 *
 *   - `X-Vapi-Secret: <geheim>`         (de klassieke server.secret)
 *   - `Authorization: Bearer <geheim>`  (bearer-token-credential)
 *   - `X-Vapi-Signature: <hmac>`        (HMAC-credential, SHA-256)
 *
 * Zonder geheim gaat de deur op slot: een open webhook zou iedereen antwoorden
 * in onze database laten schrijven.
 */
export function verifyRequest(
  headers: Headers,
  rawBody: string,
  secret: string | undefined,
): "ok" | "invalid" | "unconfigured" {
  if (!secret) return "unconfigured";

  const plain = headers("x-vapi-secret");
  if (plain && sameSecret(plain.trim(), secret)) return "ok";

  const authorization = headers("authorization");
  if (authorization) {
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    if (sameSecret(token, secret)) return "ok";
  }

  const signature = headers("x-vapi-signature");
  if (signature && signatureMatches(signature, rawBody, secret, headers("x-vapi-timestamp"))) {
    return "ok";
  }

  return "invalid";
}

/** Vergelijking die niet verklapt hoeveel tekens er klopten. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * HMAC-controle. Het handtekeningformaat is in Vapi instelbaar, dus we
 * accepteren zowel de kale hash als de `t=…,v1=…`-vorm, en zowel hex als
 * base64. Staat er een tijdstempel bij, dan tekenen we ook `<t>.<body>` — dat
 * is de gangbare vorm voor replay-bescherming.
 */
function signatureMatches(
  header: string,
  rawBody: string,
  secret: string,
  timestampHeader: string | null,
): boolean {
  const parts = header.split(",").map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2) ?? timestampHeader ?? null;

  // Elk deel kan `v1=<hash>` zijn of de kale hash. Op het label afgaan kan
  // niet: een base64-hash eindigt zelf op '=' en zou dan als label gelezen
  // worden. We houden daarom allebei de lezingen als kandidaat over.
  const given = parts
    .flatMap((p) => {
      const labelled = /^([a-z][a-z0-9_]{0,15})=(.+)$/i.exec(p);
      return labelled ? [labelled[2], p] : [p];
    })
    .filter(Boolean);

  const payloads = timestamp ? [`${timestamp}.${rawBody}`, rawBody] : [rawBody];

  for (const payload of payloads) {
    const mac = createHmac("sha256", secret).update(payload, "utf8").digest();
    for (const expected of [mac.toString("hex"), mac.toString("base64")]) {
      for (const actual of given) {
        if (sameSecret(actual, expected)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// De structured output uit de payload peuteren
// ---------------------------------------------------------------------------

/**
 * De plekken waar Vapi de geëxtraheerde antwoorden neerzet, op volgorde van
 * waarschijnlijkheid. Komt er een pad bij in een volgende Vapi-versie, dan
 * hoort het hier — niet verspreid door de code.
 */
const STRUCTURED_PATHS = [
  "analysis.structuredData",
  "call.analysis.structuredData",
  "artifact.structuredOutputs",
  "call.artifact.structuredOutputs",
  "analysis.structuredOutputs",
  "structuredOutputs",
  "structuredData",
];

export function readStructured(root: unknown): Record<string, unknown> | null {
  if (!root || typeof root !== "object") return null;
  for (const path of STRUCTURED_PATHS) {
    const found = asAnswers(valueAt(root, path));
    if (found) return found;
  }
  return null;
}

function valueAt(root: unknown, path: string): unknown {
  return path.split(".").reduce<any>((node, key) => (node == null ? node : node[key]), root);
}

/**
 * Maak van een kandidaat een antwoordobject.
 *
 * `structuredData` is meteen het object met de velden. `structuredOutputs` is
 * een verzameling — in de Vapi-API een object met de output-id als sleutel en
 * `{ name, result }` als waarde, maar we accepteren ook een array. Meerdere
 * outputs worden samengevoegd; onze zes velden zitten in de praktijk in één.
 *
 * De diepte is bewust begrensd. Elders in de payload staat het jsonschema van
 * de Structured Output zélf, met precies dezelfde veldnamen als sleutels; een
 * ongelimiteerde zoektocht zou die definitie voor een antwoord aanzien.
 */
function asAnswers(candidate: unknown, depth = 0): Record<string, unknown> | null {
  if (!candidate || typeof candidate !== "object" || depth > 2) return null;

  const node = candidate as Record<string, unknown>;
  if (FIELDS.some((f) => f in node)) return node;

  const merged: Record<string, unknown> = {};
  for (const value of Object.values(node)) {
    const inner = asAnswers((value as any)?.result, depth + 1) ?? asAnswers(value, depth + 1);
    if (inner) Object.assign(merged, inner);
  }
  return Object.keys(merged).length ? merged : null;
}

/** Het gebelde nummer, in E.164. Vapi hangt het op meerdere plekken op. */
export function customerNumber(msg: any, body: any, call: any): string | null {
  const found = [
    call?.customer?.number,
    msg?.customer?.number,
    body?.customer?.number,
    msg?.call?.customer?.number,
    call?.customer?.phoneNumber,
    msg?.phoneNumber?.number,
  ].find((p) => typeof p === "string" && p.trim());
  return found ? String(found).trim() : null;
}

// ---------------------------------------------------------------------------
// De call alsnog ophalen bij Vapi
// ---------------------------------------------------------------------------

/**
 * De extractie is een LLM-aanroep van een paar seconden, dus zit de structured
 * output vaak nog niet in de webhook. We wachten kort en vragen het na — maar
 * nooit langer dan de meegegeven deadline: liever dit ene gesprek missen (mét
 * luide logregel) dan de functie laten time-outen en álles verliezen.
 */
export async function fetchStructuredFromApi(
  callId: string,
  msLeft: () => number,
): Promise<{ structured: Record<string, unknown>; call: any } | null> {
  const key = process.env.VAPI_API_KEY;
  if (!key) {
    console.error("[vapi] VAPI_API_KEY ontbreekt — kan de structured output niet nahalen");
    return null;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = attempt === 1 ? 1_500 : 2_000;
    // Wachten heeft alleen zin als er daarna ook nog tijd is om te vragen.
    if (msLeft() < wait + 1_200) {
      console.warn(
        `[vapi] deadline bereikt na ${attempt - 1} poging(en) om call ${callId} op te halen`,
      );
      break;
    }
    await sleep(wait);

    const call = await getCall(callId, key, Math.min(3_000, msLeft() - 300));
    if (!call) continue;

    const structured = readStructured(call);
    if (structured) {
      console.log(`[vapi] structured output binnen na ${attempt} poging(en)`);
      return { structured, call };
    }
    console.log(`[vapi] poging ${attempt}: call ${callId} opgehaald, extractie nog niet klaar`);
  }
  return null;
}

async function getCall(callId: string, key: string, timeoutMs: number): Promise<any | null> {
  // /call/{id} is het gedocumenteerde pad; /calls/{id} komt in de docs ook
  // voor. Eén 404 kost ons niets, dus we proberen de tweede vorm meteen.
  for (const segment of ["call", "calls"]) {
    try {
      const res = await fetch(`https://api.vapi.ai/${segment}/${encodeURIComponent(callId)}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(Math.max(500, timeoutMs)),
      });
      if (res.status === 404) continue;
      if (!res.ok) {
        console.error(`[vapi] GET /${segment}/${callId} gaf ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error(`[vapi] GET /${segment}/${callId} mislukte:`, (err as Error).message);
      return null;
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Antwoorden opschonen
// ---------------------------------------------------------------------------

/** Wat een spraakmodel invult als het het antwoord niet heeft. */
const EMPTY = new Set(["", "-", "n/a", "na", "none", "null", "unknown", "onbekend", "geen"]);

const TEXT_FIELDS = [
  "contact_for_billing",
  "contact_for_billing_email",
  "contact_for_activities",
  "contact_for_activities_email",
] as const;

/**
 * De structured output klaarmaken voor het zod-schema.
 *
 * Vapi levert af en toe een aantal als tekst ("ongeveer 45"), een leeg veld als
 * de string "unknown", en een e-mailadres met spaties erin omdat het gespeld
 * is. Dat opruimen hoort hier en niet in het schema: het schema zegt wat geldig
 * is, dit zegt wat "leeg" betekent.
 */
export function normalise(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const headcount = raw.headcount;
  if (typeof headcount === "number" && Number.isFinite(headcount)) {
    out.headcount = Math.round(headcount);
  } else if (typeof headcount === "string") {
    const digits = headcount.replace(/[^0-9]/g, "");
    if (digits) out.headcount = Number(digits);
  }

  for (const key of TEXT_FIELDS) {
    const value = raw[key];
    if (typeof value !== "string") continue;
    let text = value.trim();
    // Een gespeld adres komt binnen als "jan @ bedrijf . nl".
    if (key.endsWith("_email")) text = text.replace(/\s+/g, "").toLowerCase();
    if (text && !EMPTY.has(text.toLowerCase())) out[key] = text.slice(0, 200);
  }

  const confirmed = raw.company_name_confirmed;
  if (confirmed != null && confirmed !== "") {
    const text = String(confirmed).trim().toLowerCase();
    out.company_name_confirmed =
      text === "yes" || text === "true" || text === "ja"
        ? "yes"
        : text === "no" || text === "false" || text === "nee"
          ? "no"
          : "unknown";
  }

  return out;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * De vorm van de payload, zonder de inhoud: welke sleutels stuurt Vapi, en van
 * welk type. Hiermee bevestigen we bij de eerste testgesprekken waar de velden
 * echt zitten, zonder telefoonnummers of transcripten in de Netlify-logs te
 * zetten.
 */
export function outline(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length ? [`${value.length}×`, outline(value[0], depth + 1)] : [];
  }
  if (typeof value === "object") {
    if (depth >= 4) return "{…}";
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as object).slice(0, 40)) {
      out[key] = outline(inner, depth + 1);
    }
    return out;
  }
  return typeof value;
}
