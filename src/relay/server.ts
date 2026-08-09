import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { q, one, getCampaign, logEvent } from "../lib/db.js";
import { SurveyAgent, OPENING, type PartnerContext } from "./agent.js";
import { AnswerSchema } from "../survey.js";
import { releasePartner } from "../lib/partners.js";

/**
 * Twilio ConversationRelay praat hier overheen.
 *
 * Binnen:  setup / prompt / interrupt / dtmf / error
 * Buiten:  {type:"text"} om te laten uitspreken, {type:"end"} om op te hangen
 *
 * De spraakherkenning en de stem regelt Twilio; wij zien alleen tekst.
 */

// ---------------------------------------------------------------------------
// TODO: tijdelijk voor diagnose — verwijderen zodra de vertraging tussen
// opnemen en de eerste gesproken zin verklaard is.
//
// Alles wat wij kunnen zien begint bij de websocket-verbinding. Is de tijd van
// verbinding tot de opening klein, dan zit de vertraging ervóór (Twilio belt,
// haalt de TwiML op bij Netlify, opent pas daarna deze socket) of erna (de TTS
// van Google die de zin moet inspreken) — beide buiten dit proces.
// ---------------------------------------------------------------------------
let callSeq = 0;

type Timing = {
  seq: number;
  connected: number;
  setup: number | null;
  openingSentAt: number | null;
  mark(label: string, extra?: string): void;
};

function newTiming(): Timing {
  return {
    seq: ++callSeq,
    connected: Date.now(),
    setup: null,
    openingSentAt: null,
    mark(label, extra) {
      const now = Date.now();
      const sinceSetup = this.setup === null ? "" : ` | +${now - this.setup}ms na setup`;
      console.log(
        `[timing #${this.seq}] +${now - this.connected}ms na verbinding${sinceSetup} — ${label}` +
          (extra ? ` (${extra})` : ""),
      );
    },
  };
}

type Session = {
  partner: PartnerContext;
  agent: SurveyAgent;
  attemptId: string | null;
  callSid: string;
  startedAt: number;
  closed: boolean;
};

export async function startRelayServer(port: number) {
  // We hangen de WebSocket aan een gewone http-server, zodat dezelfde poort ook
  // een healthcheck kan serveren. Zo zie je in de browser of de worker draait,
  // en kan Railway de service monitoren.
  const http = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  const wss = new WebSocketServer({ server: http });

  // TODO: tijdelijk voor diagnose — verwijderen zodra de herstart-oorzaak bekend is.
  // Deze drie handlers testen de hypothese "de server sluit zichzelf".
  // LET OP: door een 'error'-listener te registreren gooit de http-server een
  // latere fout niet meer als uncaught exception; hij wordt nu gelogd.
  http.on("close", () => console.log("[relay] http-server is gesloten"));
  wss.on("close", () => console.log("[relay] websocket-server is gesloten"));
  http.on("error", (err) => console.error("[relay] http-server fout:", err));

  // listen() is asynchroon: pas bij 'listening' luistert de server echt. Voorheen
  // logden we succes voordat het binden gelukt was, en kwam een bindfout (zoals
  // EADDRINUSE) pas ná "[worker] gestart" naar buiten — als uncaught exception.
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, () => {
      http.off("error", reject);
      resolve();
    });
  });
  console.log(`[relay] luistert op :${port} (ws + GET /health)`);

  wss.on("connection", (ws) => {
    let session: Session | null = null;
    const t = newTiming();
    t.mark("websocket-verbinding open — vanaf hier meten we");

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Elk binnenkomend bericht met een tijdstempel: zo zie je of Twilio
      // tussen verbinding en setup nog iets stuurt, en wanneer de gebelde
      // voor het eerst iets zegt.
      t.mark(`bericht "${msg.type}" ontvangen`);
      if (msg.type === "setup") t.setup = Date.now();

      try {
        switch (msg.type) {
          case "setup":
            session = await handleSetup(ws, msg, t);
            break;

          case "prompt":
            if (session && msg.last) await handlePrompt(ws, session, msg.voicePrompt);
            break;

          case "interrupt":
            // De beller praat er doorheen. Twilio kapt de TTS af, maar het
            // model schrijft door: nu we streamen zouden we frames blijven
            // sturen voor tekst die niemand meer hoort. Dus ook afkappen.
            session?.agent.interrupt();
            break;

          case "error":
            console.error("[relay] fout van Twilio:", msg.description);
            break;
        }
      } catch (err) {
        console.error("[relay] verwerkingsfout:", err);
        safeEnd(ws, session, "failed");
      }
    });

    ws.on("close", async () => {
      // Een rejectie hier heeft geen aanroeper die hem opvangt: 'close' is een
      // event-callback, dus zonder try/catch legt hij het hele proces om.
      try {
        if (session && !session.closed) await finalize(session, "aborted");
      } catch (err) {
        console.error("[relay] afronden na sluiten van de socket faalde:", err);
      }
    });
  });

  return wss;
}

async function handleSetup(ws: WebSocket, msg: any, t: Timing): Promise<Session | null> {
  t.mark("handleSetup binnen — er is nog niets geawait");

  // Eerst praten, dan pas opzoeken. Alles wat hiervóór gebeurt is stilte voor
  // iemand die net heeft opgenomen; de opening hangt niet van de partner af.
  const sendStart = Date.now();
  speak(ws, OPENING);
  t.openingSentAt = Date.now();
  t.mark(
    "opening de deur uit",
    `${OPENING.length} tekens, ws.send duurde ${t.openingSentAt - sendStart}ms, ` +
      `nog ${ws.bufferedAmount} bytes in de socketbuffer`,
  );

  const partnerId = msg.customParameters?.partnerId;
  const lookupStart = Date.now();
  const partner = await one<any>(
    `select id, name, contact_name, known_headcount from partners where id = $1`,
    [partnerId],
  );
  t.mark(
    "partner-lookup klaar",
    `${Date.now() - lookupStart}ms, ` +
      (t.openingSentAt === null
        ? "LET OP: dit gebeurde VOOR de opening"
        : "na de opening, zoals bedoeld"),
  );
  if (!partner) {
    console.error(`[relay] onbekende partner in setup: ${partnerId}`);
    ws.send(JSON.stringify({ type: "end" }));
    return null;
  }

  const attemptStart = Date.now();
  const attempt = await one<{ id: string }>(
    `select id from call_attempts where twilio_sid = $1`,
    [msg.callSid],
  );
  t.mark("call_attempts-lookup klaar", `${Date.now() - attemptStart}ms`);

  const ctx: PartnerContext = {
    id: partner.id,
    name: partner.name,
    contactName: partner.contact_name,
    knownHeadcount: partner.known_headcount,
  };

  const session: Session = {
    partner: ctx,
    agent: new SurveyAgent(ctx),
    attemptId: attempt?.id ?? null,
    callSid: msg.callSid,
    startedAt: Date.now(),
    closed: false,
  };

  // De opening is hierboven al uitgesproken; dit zet 'm in de geschiedenis van
  // het model zodat het niet opnieuw begint te begroeten.
  session.agent.openScripted();
  t.mark("setup afgerond, sessie staat klaar");
  return session;
}

async function handlePrompt(ws: WebSocket, session: Session, utterance: string) {
  // De tekst gaat stuk voor stuk de deur uit terwijl het model nog schrijft,
  // zodat de TTS begint bij de eerste woorden in plaats van na het hele antwoord.
  const speaker = createSpeaker(ws);
  await session.agent.respondTo(utterance, (chunk) => speaker.push(chunk));
  speaker.end();

  if (session.agent.submitted) {
    // Even wachten tot de afsluitende zin is uitgesproken voordat we ophangen.
    // Ook hier geldt: geen aanroeper, dus alles moet binnen de callback worden
    // afgevangen. In die vier seconden kan de beller allang opgehangen hebben.
    setTimeout(async () => {
      try {
        await finalize(session, "submitted");
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ done: true }) }));
        }
      } catch (err) {
        console.error("[relay] afronden na ingevulde vragenlijst faalde:", err);
      }
    }, 4000);
  }
}

/**
 * Stuurt tekst in stukjes naar ConversationRelay.
 *
 * Twilio verwacht per beurt een reeks tekstframes met last:false en precies één
 * afsluitend frame met last:true. Daarom houdt dit ding steeds één stukje vast:
 * pas als het volgende binnenkomt weet je dat het vorige niet het laatste was.
 * Komt er helemaal geen tekst (het model roept meteen de tool aan), dan gaat er
 * ook niets de deur uit.
 */
function createSpeaker(ws: WebSocket) {
  let pending: string | null = null;

  // TODO: tijdelijk voor diagnose — verwijderen zodra de pauze tussen twee
  // zinnen verklaard is.
  //
  // Wat je hier meet is het moment waarop een frame ONZE kant uit gaat. Staan
  // de frames vlak achter elkaar en hoort de beller toch een gat, dan zet de
  // TTS die pauze erin en ligt het niet aan ons. Zit het gat al tussen twee
  // frames, dan komt het van het model of van deze streaming.
  //
  // Let op de meetverschuiving: door de lookahead gaat frame N pas de deur uit
  // als stukje N+1 binnenkomt. De Δ tussen twee frames is dus de tijd die het
  // model tussen twee stukjes tekst nam, niet de tijd die de TTS nodig had.
  const seq = ++answerSeq;
  const t0 = Date.now();
  let frames = 0;
  let prevAt = t0;
  let maxGap = 0;
  let maxGapAt = 0;
  let maxGapAfter = "";

  const send = (token: string, last: boolean) => {
    // Na vier seconden praten kan de beller allang opgehangen hebben.
    if (ws.readyState !== WebSocket.OPEN) return;

    const now = Date.now();
    const gap = now - prevAt;
    frames++;
    if (gap > maxGap) {
      maxGap = gap;
      maxGapAt = frames;
      maxGapAfter = preview(token);
    }
    console.log(
      `[tts #${seq}] frame ${frames} +${now - t0}ms (${frames === 1 ? "tot eerste geluid" : `Δ${gap}ms`})` +
        `${last ? " LAATSTE" : ""}${endsSentence(token) ? " [einde zin]" : ""} "${preview(token)}"`,
    );
    prevAt = now;

    ws.send(JSON.stringify({ type: "text", token, last }));
  };

  return {
    push(chunk: string) {
      if (!chunk) return;
      if (pending !== null) send(pending, false);
      pending = chunk;
    },
    end() {
      if (pending !== null) {
        send(pending, true);
        pending = null;
      }
      console.log(
        frames === 0
          ? `[tts #${seq}] geen tekst verstuurd (alleen tool-call)`
          : `[tts #${seq}] klaar — ${frames} frames in ${Date.now() - t0}ms, ` +
              `grootste gat ${maxGap}ms vóór frame ${maxGapAt} ("${maxGapAfter}")`,
      );
    },
  };
}

/** Doorlopende nummering, zodat de frames van één antwoord bij elkaar horen. */
let answerSeq = 0;

/** Eerste woorden van een stukje, op één regel en zonder de log te vervuilen. */
function preview(token: string): string {
  const flat = token.replace(/\s+/g, " ");
  return flat.length <= 32 ? flat : `${flat.slice(0, 32)}…`;
}

/** Eindigt dit stukje een zin? Verraadt of het gat op een zinsgrens valt. */
function endsSentence(token: string): boolean {
  return /[.!?]["')\]]?\s*$/.test(token);
}

/** Eén afgeronde zin ineens — voor de vaste opening, die niet gestreamd wordt. */
function speak(ws: WebSocket, text: string) {
  if (!text) return;
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "text", token: text, last: true }));
}

function safeEnd(ws: WebSocket, session: Session | null, outcome: string) {
  try {
    ws.send(JSON.stringify({ type: "end" }));
  } catch {
    /* socket was al dicht */
  }
  if (session && !session.closed) void finalize(session, outcome);
}

/**
 * Gesprek afronden: transcript wegschrijven, antwoorden valideren en de partner
 * op de juiste status zetten.
 */
async function finalize(session: Session, reason: string) {
  if (session.closed) return;
  session.closed = true;

  const submitted = session.agent.submitted;
  const duration = Math.round((Date.now() - session.startedAt) / 1000);
  const campaign = await getCampaign();

  const outcome =
    submitted?.completion === "completed"
      ? "completed"
      : submitted?.completion === "refused"
        ? "refused"
        : submitted?.completion === "no_time"
          ? "no_time"
          : submitted?.completion === "partial"
            ? "partial"
            : reason === "aborted"
              ? "aborted"
              : "failed";

  await q(
    `update call_attempts
        set ended_at = now(), duration_sec = $2, outcome = $3, transcript = $4
      where id = $1`,
    [session.attemptId, duration, outcome, JSON.stringify(session.agent.transcript)],
  );

  // --- Terugbelverzoek: partner koos zelf een moment ---------------------
  if (submitted?.callback_requested_at) {
    await q(
      `update partners set status='scheduled', scheduled_for=$2, updated_at=now() where id=$1`,
      [session.partner.id, submitted.callback_requested_at],
    );
    await logEvent("callback_scheduled", { at: submitted.callback_requested_at }, session.partner.id);
    return;
  }

  // --- Nu geen tijd ------------------------------------------------------
  // Bewust géén 'refused' en géén do_not_call: deze partner is gewoon
  // benaderbaar, alleen niet nu. releasePartner zet 'm terug in de wachtrij
  // met een volgend belmoment, binnen dezelfde max_attempts. Zijn persoonlijke
  // link naar het webformulier blijft ook gewoon werken.
  if (outcome === "no_time") {
    await releasePartner(session.partner.id, "no_time", campaign);
    return;
  }

  // --- Weigering ---------------------------------------------------------
  if (outcome === "refused") {
    await q(
      `update partners set status='refused', do_not_call=true, updated_at=now() where id=$1`,
      [session.partner.id],
    );
    await logEvent("refused", {}, session.partner.id);
    return;
  }

  // --- Antwoorden binnen -------------------------------------------------
  if (outcome === "completed" && submitted) {
    const { completion, confidence, callback_requested_at, ...raw } = submitted;
    const parsed = AnswerSchema.safeParse(raw);

    if (!parsed.success) {
      // De assistent leverde iets onbruikbaars. Niet wegschrijven, opnieuw proberen.
      await logEvent("invalid_answers", { issues: parsed.error.issues }, session.partner.id);
      await q(
        `update partners set status='no_answer', updated_at=now() where id=$1`,
        [session.partner.id],
      );
      return;
    }

    // Er gaat geen bevestigingsmail meer uit: de teruglezing van het aantal aan
    // de telefoon is het bevestigingsmoment. Het token blijft bestaan zodat de
    // partner zijn eigen pagina op /s/[token] kan blijven openen en corrigeren.
    const confirmToken = randomUUID();
    await q(
      `insert into responses (partner_id, source, answers, confidence, attempt_id, confirm_token, confirmed_at)
       values ($1,'call',$2,$3,$4,$5, now())
       on conflict (partner_id) do update
         set source='call', answers=excluded.answers, confidence=excluded.confidence,
             attempt_id=excluded.attempt_id, confirm_token=excluded.confirm_token,
             confirmed_at=now(), updated_at=now()`,
      [session.partner.id, JSON.stringify(parsed.data), confidence, session.attemptId, confirmToken],
    );

    await q(`update partners set status='verified', updated_at=now() where id=$1`, [
      session.partner.id,
    ]);

    // Het enige controlemoment vóór facturatie is nu 'Even nakijken' op het
    // dashboard: lage confidence of een aantal dat sterk afwijkt van wat wij
    // geregistreerd hadden.
    await logEvent("answers_recorded", { confidence }, session.partner.id);
    return;
  }

  // --- Voortijdig geëindigd: terug in de wachtrij -------------------------
  await releasePartner(session.partner.id, "no_answer", campaign);
}
