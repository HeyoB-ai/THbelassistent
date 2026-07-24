import "dotenv/config";
import twilio from "twilio";
import { q, one, getCampaign, logEvent, pool } from "./lib/db.js";
import { isCallableMoment } from "./lib/callWindow.js";
import { releasePartner } from "./lib/partners.js";
import { startRelayServer } from "./relay/server.js";

/**
 * De worker.
 *
 * Eén tick per 15 seconden:
 *   1. lees de campagnestatus  (dit is de noodrem)
 *   2. mag er nu gebeld worden (werkdag, binnen het venster)
 *   3. hoeveel gesprekken lopen er
 *   4. claim het verschil, bel ze
 *
 * Bewust geen Redis of aparte queue-library. Bij honderd partners is
 * `select ... for update skip locked` eenvoudiger, en de database is toch al
 * de bron van waarheid. Bij duizenden partners zou ik dit vervangen.
 */

const TICK_MS = 15_000;
const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const campaign = await getCampaign();

    if (campaign.status === "stopped") {
      await abortLiveCalls();
      return;
    }
    if (campaign.status !== "running") return;

    const now = new Date();
    const w = { start: campaign.window_start, end: campaign.window_end };
    if (!isCallableMoment(now, w)) {
      return; // buiten het belvenster; whyNotCallable(now, w) vertelt waarom
    }

    const live = await one<{ n: string }>(
      `select count(*)::text as n from partners where status = 'calling'`,
    );
    const slots = campaign.max_concurrent - Number(live!.n);
    if (slots <= 0) return;

    const claimed = await claimPartners(slots, campaign.max_attempts);
    for (const p of claimed) {
      await placeCall(p).catch(async (err) => {
        console.error(`[worker] bellen mislukt voor ${p.name}:`, err.message);
        await releasePartner(p.id, "failed", campaign);
      });
    }
  } catch (err) {
    console.error("[worker] tick faalde:", err);
  } finally {
    ticking = false;
  }
}

type ClaimedPartner = {
  id: string;
  name: string;
  phone: string;
  attempts: number;
  contact_name: string | null;
  known_headcount: number | null;
};

/**
 * Claim partners die aan de beurt zijn. SKIP LOCKED zorgt dat twee workers
 * nooit dezelfde partner pakken — je kunt dit proces dus veilig schalen.
 *
 * Volgorde: eerst wie zelf een belmoment koos, dan wie het langst wacht.
 */
async function claimPartners(limit: number, maxAttempts: number): Promise<ClaimedPartner[]> {
  const rows = await q<ClaimedPartner>(
    `
    with due as (
      select id from partners
       where do_not_call = false
         and attempts < $2
         and status in ('announced','no_answer','scheduled')
         and (scheduled_for is null or scheduled_for <= now())
       order by (status = 'scheduled') desc, scheduled_for nulls last, created_at
       limit $1
       for update skip locked
    )
    update partners p
       set status = 'calling',
           attempts = p.attempts + 1,
           updated_at = now()
      from due
     where p.id = due.id
     returning p.id, p.name, p.phone, p.attempts, p.contact_name, p.known_headcount
    `,
    [limit, maxAttempts],
  );
  return rows;
}

async function placeCall(p: ClaimedPartner) {
  const call = await client.calls.create({
    to: p.phone,
    from: process.env.TWILIO_FROM_NUMBER!,
    url: `${process.env.PUBLIC_BASE_URL}/api/twiml?partner=${p.id}`,
    statusCallback: `${process.env.PUBLIC_BASE_URL}/api/twilio-status`,
    statusCallbackEvent: ["initiated", "answered", "completed"],

    // Zonder dit praat de assistent tegen een voicemail en tel je dat als 'gedaan'.
    machineDetection: "DetectMessageEnd",
    machineDetectionTimeout: 15,

    timeout: 25,
    record: process.env.RECORD_CALLS === "true",
  });

  await q(
    `insert into call_attempts (partner_id, twilio_sid) values ($1,$2)`,
    [p.id, call.sid],
  );
  await logEvent("call_placed", { sid: call.sid, attempt: p.attempts }, p.id);
  console.log(`[worker] belt ${p.name} (poging ${p.attempts}) — ${call.sid}`);
}

/** Bij 'stopped': hang lopende gesprekken op. */
async function abortLiveCalls() {
  const rows = await q<{ id: string; twilio_sid: string }>(
    `select p.id, ca.twilio_sid
       from partners p
       join call_attempts ca on ca.partner_id = p.id and ca.ended_at is null
      where p.status = 'calling'`,
  );
  for (const r of rows) {
    try {
      await client.calls(r.twilio_sid).update({ status: "completed" });
    } catch {
      /* gesprek was al voorbij */
    }
    await q(`update partners set status = 'no_answer' where id = $1`, [r.id]);
    await q(
      `update call_attempts set outcome = 'aborted', ended_at = now() where twilio_sid = $1`,
      [r.twilio_sid],
    );
  }
  if (rows.length) await logEvent("campaign_stopped_calls_aborted", { count: rows.length });
}

// ---------------------------------------------------------------------------

async function main() {
  await startRelayServer(Number(process.env.RELAY_PORT ?? 8081));
  console.log("[worker] gestart");

  const timer = setInterval(tick, TICK_MS);
  void tick();

  const shutdown = async () => {
    clearInterval(timer);
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
