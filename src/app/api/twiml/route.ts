import { NextRequest } from "next/server";

/**
 * TwiML voor een uitgaand gesprek.
 *
 * Twilio haalt dit op zodra er wordt opgenomen. We geven ConversationRelay
 * terug, met de partner-id als parameter zodat de websocket weet wie hij belt.
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
      ttsProvider="ElevenLabs"
      voice="${process.env.TTS_VOICE_ID}"
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
