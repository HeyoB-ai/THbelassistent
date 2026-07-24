import "dotenv/config";
import { q, pool } from "../src/lib/db.js";
import { sendAnnouncement } from "../src/lib/mail.js";

/**
 * Stuurt de aankondigingsmail naar iedereen die er nog geen had.
 *   npx tsx scripts/send-announcements.ts
 *
 * Draai dit minstens een paar dagen voordat je de campagne op 'running' zet.
 * De mail is wat de belronde van koud bellen onderscheidt — zonder die
 * voorsprong is de opnamekans laag en de juridische basis dunner.
 */
async function main() {
  const rows = await q<{ id: string; name: string }>(
    `select id, name from partners
      where status = 'pending' and do_not_call = false
      order by name`,
  );

  console.log(`${rows.length} aankondigingen te versturen.`);
  for (const r of rows) {
    await sendAnnouncement(r.id);
    console.log("  ✓ " + r.name);
    await new Promise((res) => setTimeout(res, 250)); // rustig aan tegen rate limits
  }
  await pool.end();
}

void main();
