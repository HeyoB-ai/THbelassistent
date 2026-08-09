/**
 * Warmhoud-route voor de Netlify-function.
 *
 * De meting was duidelijk: de eerste aanroep van /api/twiml kostte 3150ms,
 * daaropvolgende 20-500ms. Die drie seconden waren pure stilte voor iemand die
 * net had opgenomen, want Twilio haalt de TwiML op vóór het gesprek begint.
 *
 * De worker op Railway draait continu en pingt deze route elke paar minuten,
 * zodat de function nooit koud staat als er echt gebeld wordt.
 *
 * @netlify/plugin-nextjs bundelt alle server-routes in één function, dus het
 * warmhouden van deze route houdt ook /api/twiml warm. Daarom mag het hier zo
 * goedkoop mogelijk: geen database, geen imports, niets dat kan falen.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return new Response("ok", {
    headers: {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
      // Zou een cache of CDN dit beantwoorden, dan blijft de function juist
      // koud en meten we onszelf rijk.
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
