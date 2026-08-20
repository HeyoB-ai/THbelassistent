import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { q, one, logEvent } from "@/lib/db";
import { AnswerSchema } from "@/survey";
import {
  customerNumber,
  fetchStructuredFromApi,
  normalise,
  outline,
  readStructured,
  verifyRequest,
} from "@/lib/vapi";

/**
 * Vapi levert het gesprek af.
 *
 * Vapi voert sinds de migratie zelf de belenquête uit. Aan het eind van elk
 * gesprek stuurt het hier het `end-of-call-report`-event naartoe. Wij halen er
 * de zes antwoorden uit, zoeken de partner op het gebelde nummer, en schrijven
 * één rij in `responses` — dezelfde tabel die het dashboard en de Excel-export
 * al lezen. Er verandert dus niets aan het datamodel; alleen de bron van de
 * antwoorden is nu Vapi in plaats van de eigen relay.
 *
 * Drie dingen die dit endpoint bewust doet:
 *
 *   1. Het leest defensief. Waar Vapi de structured output neerzet ligt in de
 *      documentatie niet hard vast, dus proberen we de bekende plekken op
 *      volgorde in plaats van er één te kiezen. Zie src/lib/vapi.ts.
 *   2. Het wacht kort. De extractie is een LLM-aanroep die pas een paar
 *      seconden ná het gesprek klaar is, dus zit de data vaak nog niet in de
 *      webhook. Dan halen we de call alsnog op via de API — binnen een harde
 *      deadline, want een Netlify-functie mag maar tien seconden duren.
 *   3. Het schrijft niets weg wat het niet kan thuisbrengen. Een nummer dat
 *      niet bij een partner hoort levert een luide logregel op en verder niets:
 *      liever een gat dat opvalt dan een antwoord onder de verkeerde naam.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hoe lang dit endpoint zichzelf gunt vóór het antwoord geeft. Netlify kapt een
 * functie na tien seconden af; blijven we daar ruim onder, dan is het antwoord
 * aan Vapi altijd een echt antwoord en nooit een time-out.
 */
const DEADLINE_MS = 7_000;

export async function POST(req: NextRequest) {
  try {
    return await handle(req);
  } catch (err) {
    // Onverwacht — in de praktijk de database die er even niet is. Hier bewust
    // géén 200: Vapi probeert het dan opnieuw, en de dubbelcontrole verderop
    // zorgt dat een geslaagde tweede poging geen tweede rij oplevert. Een 200
    // zou dit gesprek definitief kwijtmaken.
    console.error("[vapi] onverwachte fout bij het verwerken van de webhook:", err);
    return new NextResponse("Verwerking mislukt", { status: 500 });
  }
}

async function handle(req: NextRequest) {
  const startedAt = Date.now();
  const msLeft = () => DEADLINE_MS - (Date.now() - startedAt);

  // Ruwe body, niet req.json(): een HMAC-handtekening gaat over de bytes zoals
  // ze binnenkwamen, niet over een opnieuw geserialiseerd object.
  const rawBody = await req.text();

  const auth = verifyRequest(
    (name) => req.headers.get(name),
    rawBody,
    process.env.VAPI_WEBHOOK_SECRET,
  );
  if (auth === "unconfigured") {
    console.error("[vapi] VAPI_WEBHOOK_SECRET ontbreekt — webhook geweigerd");
    return new NextResponse("Webhook-authenticatie is niet geconfigureerd.", { status: 503 });
  }
  if (auth === "invalid") {
    console.warn("[vapi] webhook geweigerd: authenticatie klopt niet");
    return new NextResponse("Unauthorized", { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.warn("[vapi] body is geen geldige JSON — genegeerd");
    return NextResponse.json({ ok: true });
  }

  // De envelope is { message: { … } }; sommige integraties sturen het bericht
  // plat. Beide gevallen komen hier op hetzelfde neer.
  const msg = body?.message ?? body;
  const type = msg?.type;

  if (type !== "end-of-call-report") {
    // status-update, transcript, speech-update: netjes bevestigen en klaar.
    return NextResponse.json({ ok: true, ignored: type ?? "onbekend" });
  }

  // Het vangnet voor de eerste testgesprekken: welke sleutels stuurt Vapi ons
  // echt? Alleen de vorm, geen waarden — hier staan namen en nummers in.
  console.log("[vapi] payload-vorm:", JSON.stringify(outline(body)));

  const call = msg?.call ?? body?.call ?? {};
  const callId: string | undefined = call?.id ?? msg?.callId ?? msg?.call?.id;

  if (!callId) {
    console.error("[vapi] end-of-call-report zonder call-id — kan niets thuisbrengen");
    await logEvent("vapi_call_id_missing", { keys: Object.keys(msg ?? {}) });
    return NextResponse.json({ ok: true, stored: false, reason: "call_id_missing" });
  }

  // --- Al verwerkt? -------------------------------------------------------
  // Vapi stuurt een webhook opnieuw als hij ons antwoord niet vertrouwt. De
  // call-id staat in de opgeslagen antwoorden, dus die is onze sleutel.
  const already = await one<{ partner_id: string }>(
    `select partner_id from responses where answers ->> 'vapi_call_id' = $1`,
    [callId],
  );
  if (already) {
    console.log(
      `[vapi] call ${callId} was al verwerkt voor partner ${already.partner_id} — overgeslagen`,
    );
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // --- De antwoorden ophalen ---------------------------------------------
  let structured = readStructured(msg) ?? readStructured(body);
  let origin: "webhook" | "api" = "webhook";

  if (!structured) {
    const fetched = await fetchStructuredFromApi(callId, msLeft);
    if (fetched) {
      structured = fetched.structured;
      origin = "api";
      // De opgehaalde call is ook een tweede kans op het klantnummer.
      if (!call.customer && fetched.call?.customer) call.customer = fetched.call.customer;
    }
  }

  if (!structured) {
    console.error(
      `[vapi] geen structured output voor call ${callId} — niet in de webhook en niet via de API. ` +
        `Dit gesprek is NIET opgeslagen; haal 'm handmatig op in het Vapi-dashboard.`,
    );
    await logEvent("vapi_structured_missing", { call_id: callId });
    return NextResponse.json({ ok: true, stored: false, reason: "structured_output_missing" });
  }

  console.log(`[vapi] structured output voor call ${callId} gevonden via ${origin}`);

  // --- De partner erbij zoeken -------------------------------------------
  const number = customerNumber(msg, body, call);
  if (!number) {
    console.error(`[vapi] call ${callId} heeft geen klantnummer in de payload — niets opgeslagen`);
    await logEvent("vapi_number_missing", { call_id: callId });
    return NextResponse.json({ ok: true, stored: false, reason: "number_missing" });
  }

  const match = await findPartner(number);
  if (match.kind !== "found") {
    console.error(
      `[vapi] geen eenduidige partner voor ${number} (call ${callId}, ${match.kind}) — ` +
        `niets opgeslagen. Controleer het telefoonnummer in de partnerlijst.`,
    );
    await logEvent("vapi_partner_unmatched", {
      call_id: callId,
      number,
      reason: match.kind,
      candidates: match.candidates,
    });
    return NextResponse.json({ ok: true, stored: false, reason: match.kind });
  }

  const partner = match.partner;

  // --- Valideren ----------------------------------------------------------
  const parsed = AnswerSchema.safeParse(normalise(structured));
  if (!parsed.success) {
    // Onbruikbare antwoorden niet in responses zetten — het dashboard en de
    // export zouden er dan half werk in tonen. Wel bewaren in het auditlog,
    // zodat er niets verdwijnt en iemand het na kan lopen.
    console.error(
      `[vapi] antwoorden van call ${callId} (partner ${partner.name}) zijn ongeldig:`,
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
    await logEvent(
      "vapi_invalid_answers",
      { call_id: callId, issues: parsed.error.issues, raw: structured },
      partner.id,
    );
    return NextResponse.json({ ok: true, stored: false, reason: "invalid_answers" });
  }

  const answers = { ...parsed.data, vapi_call_id: callId };

  // --- Wegschrijven -------------------------------------------------------
  // Eén rij per partner (partner_id is de primaire sleutel), laatste versie
  // wint — precies zoals de relay en het webformulier het deden. Het
  // confirm_token blijft staan als het er al was, zodat een eerder verstuurde
  // bevestigingslink blijft werken.
  await q(
    `insert into responses (partner_id, source, answers, confidence, confirm_token, confirmed_at)
     values ($1,'call',$2,'high',$3, now())
     on conflict (partner_id) do update
       set source='call', answers=excluded.answers, confidence='high',
           confirm_token=coalesce(responses.confirm_token, excluded.confirm_token),
           confirmed_at=now(), updated_at=now()`,
    [partner.id, JSON.stringify(answers), randomUUID()],
  );

  // Is de bedrijfsnaam niet herkend, dan staat dit nummer mogelijk bij de
  // verkeerde partner. De antwoorden bewaren we, maar de partner gaat naar
  // 'completed' ("wacht op akkoord") in plaats van 'verified', zodat het cijfer
  // niet ongezien de facturatie in loopt. Het dashboard zet er al een "naam?"
  // bij zodra company_name_confirmed op "no" staat. Geen van beide statussen
  // komt terug in de belwachtrij, dus hij wordt hier niet opnieuw voor gebeld.
  const nameMismatch = parsed.data.company_name_confirmed === "no";
  const status = nameMismatch ? "completed" : "verified";

  await q(`update partners set status = $2, updated_at = now() where id = $1`, [partner.id, status]);

  await logEvent(
    "vapi_answers_recorded",
    {
      call_id: callId,
      origin,
      headcount: parsed.data.headcount,
      company_name_confirmed: parsed.data.company_name_confirmed ?? null,
      status,
    },
    partner.id,
  );

  console.log(
    `[vapi] call ${callId}: partner ${partner.name} (${partner.id}), ` +
      `${parsed.data.headcount} medewerkers, bron ${origin}, status ${status} — opgeslagen`,
  );

  return NextResponse.json({ ok: true, stored: true, partner_id: partner.id, status });
}

// ---------------------------------------------------------------------------
// Partner opzoeken op telefoonnummer
// ---------------------------------------------------------------------------

type Partner = { id: string; name: string; phone: string };
type Match =
  | { kind: "found"; partner: Partner; candidates?: undefined }
  | { kind: "no_match" | "ambiguous"; partner?: undefined; candidates: string[] };

/**
 * Zoek de partner bij het gebelde nummer.
 *
 * Drie manieren, van streng naar soepel: exact zoals opgeslagen, dezelfde
 * cijfers, of dezelfde laatste negen cijfers — dat laatste vangt
 * +31657812417 tegen 0657812417 op. Levert de soepelste manier meer dan één
 * partner op, dan kiezen we niet: dan is het werk voor een mens.
 */
async function findPartner(number: string): Promise<Match> {
  const all = number.replace(/[^0-9]/g, "");
  const tail = all.length >= 9 ? all.slice(-9) : "";

  const rows = await q<Partner & { rank: number }>(
    `select id, name, phone,
            case when phone = $1 then 1
                 when regexp_replace(phone, '[^0-9]', '', 'g') = $2 then 2
                 else 3 end as rank
       from partners
      where phone = $1
         or regexp_replace(phone, '[^0-9]', '', 'g') = $2
         or ($3 <> '' and right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = $3)
      order by rank
      limit 3`,
    [number, all, tail],
  );

  if (rows.length === 0) return { kind: "no_match", candidates: [] };
  if (rows.length > 1 && rows[0].rank === rows[1].rank) {
    return { kind: "ambiguous", candidates: rows.map((r) => `${r.name} (${r.phone})`) };
  }
  return { kind: "found", partner: rows[0] };
}
