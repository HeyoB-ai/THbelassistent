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
 * De transcriptie draait op Deepgram nova-3.
 *
 * Deepgram Flux stond hier even: dat doet transcriptie en turn-detection in
 * één model en scheelt volgens Twilio 200-600ms per beurt. Maar met flux kwam
 * er geen websocket-verbinding meer tot stand — de TwiML werd wél opgehaald
 * (te zien aan de AnsweredBy-regel hieronder), maar Twilio struikelde over het
 * uitvoeren van <ConversationRelay>. Waarschijnlijk is flux niet beschikbaar
 * voor dit account of voor nl-NL. Niet opnieuw proberen zonder eerst in de
 * Twilio Console te bevestigen dat flux voor nl-NL beschikbaar is.
 */

/**
 * Turn-detection: hoe lang Twilio na spraak wacht voor hij de beurt afsluit.
 *
 * 600-5000ms; Twilio's eigen standaard is `auto`. Korter = sneller antwoord,
 * meer kans dat de assistent iemand in de rede valt.
 *
 * Via de omgeving te zetten zodat tunen geen deploy vraagt. Een waarde buiten
 * bereik laat Twilio de TwiML afkeuren — en dan loopt het gesprek stuk — dus
 * hij wordt hier begrensd en teruggezet op de standaard. Met `off` gaat het
 * attribuut er helemaal uit en valt Twilio terug op `auto`; dat is de knop om
 * aan te draaien als het gesprek onverhoopt tóch niet doorkomt, zonder deploy.
 *
 * eotThreshold stond hier ook, maar dat geldt volgens Twilio's referentie
 * alleen bij speechModel="flux" en is met nova-3 dus zinloos.
 */
const SPEECH_TIMEOUT =
  process.env.STT_SPEECH_TIMEOUT_MS?.trim().toLowerCase() === "off"
    ? null
    : Math.round(clamp("STT_SPEECH_TIMEOUT_MS", process.env.STT_SPEECH_TIMEOUT_MS, 600, 5000, 800));

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
  // LET OP: de detectie staat standaard UIT (zie AMD in src/worker.ts). Dan
  // stuurt Twilio geen AnsweredBy mee, valt deze check op een lege string, en
  // gaat het gesprek gewoon door — precies de bedoeling.
  //
  // Staat AMD_ENABLED=true, dan draait de detectie synchroon en staat AnsweredBy
  // al in deze POST. Onder "Enable" zijn de waarden human, machine_start, fax en
  // unknown; onder het eerdere DetectMessageEnd waren dat machine_end_beep,
  // machine_end_silence en machine_end_other. De prefix-check dekt beide reeksen.
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
      speechModel="nova-3"${SPEECH_TIMEOUT === null ? "" : `
      speechTimeout="${SPEECH_TIMEOUT}"`}
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
