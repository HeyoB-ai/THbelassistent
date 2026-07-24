import { NextRequest } from "next/server";
import { q, getCampaign, logEvent } from "@/lib/db";
import { releasePartner } from "@/lib/partners";

/**
 * Statuscallback van Twilio. Vangt alles wat níet tot een gesprek leidde:
 * niet opgenomen, in gesprek, voicemail, verkeerd nummer.
 */
export async function POST(req: NextRequest) {
  const f = await req.formData();
  const sid = String(f.get("CallSid"));
  const status = String(f.get("CallStatus"));
  const answeredBy = String(f.get("AnsweredBy") ?? "");

  const rows = await q<{ partner_id: string; outcome: string | null }>(
    `select partner_id, outcome from call_attempts where twilio_sid = $1`,
    [sid],
  );
  const attempt = rows[0];
  if (!attempt) return new Response("ok");

  await q(`update call_attempts set answered_by = $2 where twilio_sid = $1`, [
    sid,
    answeredBy || null,
  ]);

  if (status !== "completed" || answeredBy.startsWith("machine")) {
    // De relay heeft dit gesprek nooit gezien; alleen dan grijpen we hier in.
    if (!attempt.outcome) {
      const outcome =
        answeredBy.startsWith("machine") ? "voicemail"
        : status === "failed" ? "failed"
        : "no_answer";

      await q(
        `update call_attempts set outcome = $2, ended_at = now() where twilio_sid = $1`,
        [sid, outcome],
      );

      if (status === "failed" || status === "canceled") {
        await q(`update partners set status='invalid', do_not_call=true where id=$1`, [
          attempt.partner_id,
        ]);
        await logEvent("number_invalid", { sid, status }, attempt.partner_id);
      } else {
        await releasePartner(attempt.partner_id, outcome as any, await getCampaign());
      }
    }
  }

  return new Response("ok");
}
