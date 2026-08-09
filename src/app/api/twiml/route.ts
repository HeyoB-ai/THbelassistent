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
 */
export async function POST(req: NextRequest) {
  const partnerId = req.nextUrl.searchParams.get("partner");
  const form = await req.formData();

  // Answering Machine Detection. Zonder deze check praat de assistent tegen
  // een voicemail en tellen we dat als een geslaagd gesprek.
  const answeredBy = String(form.get("AnsweredBy") ?? "");
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
      speechModel="nova-3"
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
