"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { q, one, logEvent } from "@/lib/db";
import { AnswerSchema } from "@/survey";

/** Partner vult het formulier zelf in. Dit is een volwaardig resultaat. */
export async function submitSelfReport(token: string, form: FormData) {
  const p = await one<{ id: string }>(`select id from partners where token = $1`, [token]);
  if (!p) return { error: "Deze link is niet meer geldig." };

  const aiInterest = String(form.get("ai_interest") ?? "");
  const raw = {
    headcount: Number(form.get("headcount")),
    contact_for_billing: String(form.get("contact_for_billing") ?? "") || undefined,
    ai_interest: aiInterest === "yes" || aiInterest === "no" ? aiInterest : undefined,
    ai_contact: String(form.get("ai_contact") ?? "") || undefined,
  };

  const parsed = AnswerSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: "Vul in elk geval het aantal medewerkers in." };
  }

  await q(
    `insert into responses (partner_id, source, answers, confidence, confirm_token, confirmed_at)
     values ($1,'web',$2,'high',$3, now())
     on conflict (partner_id) do update
       set source='web', answers=excluded.answers, confidence='high',
           confirmed_at=now(), updated_at=now()`,
    [p.id, JSON.stringify(parsed.data), randomUUID()],
  );

  // Zelf ingevuld telt als bevestigd: ze hebben het met eigen ogen gezien.
  await q(
    `update partners set status='self_reported', do_not_call=true, updated_at=now() where id=$1`,
    [p.id],
  );
  await logEvent("self_reported", { headcount: parsed.data.headcount }, p.id);

  revalidatePath(`/s/${token}`);
  return { ok: true };
}

/** "Liever niet gebeld worden" uit de aankondigingsmail. */
export async function optOut(token: string) {
  await q(
    `update partners set do_not_call = true, status = 'excluded', updated_at = now()
      where token = $1`,
    [token],
  );
  await logEvent("opt_out", { via: "link" });
  revalidatePath(`/s/${token}`);
}
