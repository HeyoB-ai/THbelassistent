import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { q, one, getCampaign, logEvent } from "../lib/db.js";
import { SurveyAgent, type PartnerContext } from "./agent.js";
import { AnswerSchema } from "../survey.js";
import { sendConfirmation } from "../lib/mail.js";
import { releasePartner } from "../lib/partners.js";

/**
 * Twilio ConversationRelay praat hier overheen.
 *
 * Binnen:  setup / prompt / interrupt / dtmf / error
 * Buiten:  {type:"text"} om te laten uitspreken, {type:"end"} om op te hangen
 *
 * De spraakherkenning en de stem regelt Twilio; wij zien alleen tekst.
 */

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

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      try {
        switch (msg.type) {
          case "setup":
            session = await handleSetup(ws, msg);
            break;

          case "prompt":
            if (session && msg.last) await handlePrompt(ws, session, msg.voicePrompt);
            break;

          case "interrupt":
            // De beller praat er doorheen. Twilio kapt de TTS al af; wij
            // hoeven alleen te zorgen dat we niet doorpompen.
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
      if (session && !session.closed) await finalize(session, "aborted");
    });
  });

  return wss;
}

async function handleSetup(ws: WebSocket, msg: any): Promise<Session | null> {
  const partnerId = msg.customParameters?.partnerId;
  const partner = await one<any>(
    `select id, name, contact_name, known_headcount from partners where id = $1`,
    [partnerId],
  );
  if (!partner) {
    ws.send(JSON.stringify({ type: "end" }));
    return null;
  }

  const attempt = await one<{ id: string }>(
    `select id from call_attempts where twilio_sid = $1`,
    [msg.callSid],
  );

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

  const opening = await session.agent.open();
  speak(ws, opening);
  return session;
}

async function handlePrompt(ws: WebSocket, session: Session, utterance: string) {
  const reply = await session.agent.respondTo(utterance);

  if (session.agent.submitted) {
    if (reply) speak(ws, reply);
    // Even wachten tot de afsluitende zin is uitgesproken voordat we ophangen.
    setTimeout(async () => {
      await finalize(session, "submitted");
      ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ done: true }) }));
    }, 4000);
    return;
  }

  speak(ws, reply);
}

function speak(ws: WebSocket, text: string) {
  if (!text) return;
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
 * Gesprek afronden: transcript wegschrijven, antwoorden valideren, partner
 * op de juiste status zetten en de bevestigingsmail versturen.
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

    const confirmToken = randomUUID();
    await q(
      `insert into responses (partner_id, source, answers, confidence, attempt_id, confirm_token)
       values ($1,'call',$2,$3,$4,$5)
       on conflict (partner_id) do update
         set source='call', answers=excluded.answers, confidence=excluded.confidence,
             attempt_id=excluded.attempt_id, confirm_token=excluded.confirm_token,
             confirmed_at=null, updated_at=now()`,
      [session.partner.id, JSON.stringify(parsed.data), confidence, session.attemptId, confirmToken],
    );

    await q(`update partners set status='completed', updated_at=now() where id=$1`, [
      session.partner.id,
    ]);

    // Niets gaat naar de facturatie voordat de partner dit bevestigt.
    await sendConfirmation(session.partner.id, confirmToken);
    await logEvent("answers_recorded", { confidence }, session.partner.id);
    return;
  }

  // --- Voortijdig geëindigd: terug in de wachtrij -------------------------
  await releasePartner(session.partner.id, "no_answer", campaign);
}
