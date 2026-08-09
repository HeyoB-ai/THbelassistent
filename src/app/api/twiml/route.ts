import { NextRequest } from "next/server";

/**
 * TwiML voor een uitgaand gesprek.
 *
 * Twilio haalt dit op zodra er wordt opgenomen. We geven ConversationRelay
 * terug, met de partner-id als parameter zodat de websocket weet wie hij belt.
 *
 * De stem komt van Google, de TTS-provider die ConversationRelay zonder
 * externe koppeling of voice-id ondersteunt. ElevenLabs stond hier eerder,
 * maar dat vraagt een eigen account én en-US — geen optie voor een Nederlands
 * gesprek. Wil je een mannenstem: nl-NL-Chirp3-HD-Charon.
 *
 * De transcriptie draait op Deepgram Flux. Dat model doet transcriptie en
 * turn-detection in één keer, in plaats van los van elkaar; volgens Twilio
 * scheelt dat 200-600ms reactietijd per beurt en ongeveer dertig procent
 * minder valse onderbrekingen. Nederlands zit in de tien talen die Flux
 * ondersteunt.
 */

/**
 * Turn-detection: wanneer besluit Twilio dat de beller uitgesproken is.
 *
 * Twee knoppen, met verschillende rollen — draai er één tegelijk aan:
 *
 *   eotThreshold  hoe zeker Flux moet zijn dat de beurt voorbij is (0,5-0,9).
 *                 Lager = sneller antwoord, maar meer kans dat de assistent
 *                 iemand in de rede valt. Twilio's standaard is 0,8.
 *   speechTimeout de harde bovengrens: zoveel stilte en de beurt wordt
 *                 afgesloten, ongeacht hoe zeker het model is (600-5000ms).
 *
 * Beide zijn via de omgeving te zetten zodat tunen geen deploy vraagt. Een
 * waarde buiten bereik laat Twilio de TwiML afkeuren — daar loopt het gesprek
 * op stuk — dus alles wordt hier begrensd en teruggezet op de standaard.
 */
const EOT_THRESHOLD = clamp("STT_EOT_THRESHOLD", process.env.STT_EOT_THRESHOLD, 0.5, 0.9, 0.8);
const SPEECH_TIMEOUT = Math.round(
  clamp("STT_SPEECH_TIMEOUT_MS", process.env.STT_SPEECH_TIMEOUT_MS, 600, 5000, 800),
);

function clamp(name: string, raw: string | undefined, min: number, max: number, fallback: number) {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(`[twiml] ${name}="${raw}" valt buiten ${min}-${max}; ${fallback} gebruikt`);
    return fallback;
  }
  return value;
}
export async function POST(req: NextRequest) {
  const partnerId = req.nextUrl.searchParams.get("partner");
  const form = await req.formData();

  // Answering Machine Detection. Zonder deze check praat de assistent tegen
  // een voicemail en tellen we dat als een geslaagd gesprek.
  //
  // De detectie draait synchroon (machineDetection: "Enable" in worker.ts),
  // dus AnsweredBy staat al in deze POST. Onder "Enable" zijn de waarden
  // human, machine_start, fax en unknown; onder het eerdere DetectMessageEnd
  // waren dat machine_end_beep, machine_end_silence en machine_end_other.
  // De prefix-check dekt beide reeksen, dus die kon blijven staan.
  //
  // unknown = detectie kwam er niet uit binnen machineDetectionTimeout. Die
  // behandelen we bewust als mens: hooguit praten we tegen een voicemail,
  // in plaats van iemand die opneemt meteen weg te drukken.
  const answeredBy = String(form.get("AnsweredBy") ?? "");
  console.log(`[twiml] partner=${partnerId} AnsweredBy=${answeredBy || "(leeg)"}`);
  if (answeredBy.startsWith("machine") || answeredBy === "fax") {
    return xml(`<Response><Hangup/></Response>`);
  }

  return xml(`<Response>
  <Connect>
    <ConversationRelay
      url="${process.env.RELAY_WS_URL}"
      language="nl-NL"
      ttsProvider="Google"
      voice="nl-NL-Chirp3-HD-Kore"
      transcriptionProvider="Deepgram"
      speechModel="flux"
      eotThreshold="${EOT_THRESHOLD}"
      speechTimeout="${SPEECH_TIMEOUT}"
      interruptible="true"
      dtmfDetection="true"
      welcomeGreetingInterruptible="false">
      <Parameter name="partnerId" value="${partnerId}"/>
    </ConversationRelay>
  </Connect>
</Response>`);
}

function xml(body: string) {
  return new Response(body, { headers: { "Content-Type": "text/xml" } });
}
