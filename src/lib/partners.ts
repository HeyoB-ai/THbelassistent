import { q, one, logEvent, type Campaign } from "./db.js";
import { nextAttemptAt } from "./callWindow.js";

/**
 * Zet een partner terug in de wachtrij na een mislukte poging, of parkeer 'm
 * als het maximum aantal pogingen bereikt is.
 *
 * Staat hier en niet in de worker, omdat zowel de worker (bellen mislukt) als
 * de relay (gesprek voortijdig geëindigd) dit aanroept.
 */
export async function releasePartner(
  partnerId: string,
  outcome: "no_answer" | "voicemail" | "failed" | "gatekeeper" | "no_time",
  campaign: Pick<Campaign, "max_attempts" | "window_start" | "window_end">,
) {
  const p = await one<{ attempts: number }>(
    `select attempts from partners where id = $1`,
    [partnerId],
  );
  if (!p) return;

  const w = { start: campaign.window_start, end: campaign.window_end };
  const exhausted = p.attempts >= campaign.max_attempts;

  await q(
    `update partners
        set status = 'no_answer',
            scheduled_for = $2,
            updated_at = now()
      where id = $1`,
    [partnerId, exhausted ? null : nextAttemptAt(p.attempts, w)],
  );

  await logEvent(exhausted ? "attempts_exhausted" : "requeued", { outcome, attempts: p.attempts }, partnerId);
}
