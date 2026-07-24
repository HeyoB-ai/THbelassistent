import "dotenv/config";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { q, pool } from "../src/lib/db.js";

/**
 * Excel importeren.
 *   npx tsx scripts/import-partners.ts partners.xlsx
 *
 * Verwachte kolommen (hoofdletterongevoelig):
 *   naam | contactpersoon | email | telefoon | medewerkers
 *
 * Nummers worden genormaliseerd naar E.164. Rijen zonder bruikbaar nummer
 * worden overgeslagen en aan het eind opgesomd — die wil je met de hand nalopen.
 */

function toE164(raw: string): string | null {
  const digits = String(raw).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("00")) return "+" + digits.slice(2);
  if (digits.startsWith("0")) return "+31" + digits.slice(1);
  if (digits.startsWith("31")) return "+" + digits;
  return null;
}

const pick = (row: any, ...keys: string[]) => {
  const norm = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.toLowerCase().trim(), v]),
  );
  for (const k of keys) if (norm[k] != null && norm[k] !== "") return norm[k];
  return undefined;
};

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Geef het pad naar het Excel-bestand mee.");

  const wb = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]]);

  const skipped: string[] = [];
  let inserted = 0;

  for (const row of rows) {
    const name = pick(row, "naam", "bedrijf", "partner", "name");
    const email = pick(row, "email", "e-mail", "mail");
    const phone = toE164(String(pick(row, "telefoon", "telefoonnummer", "phone") ?? ""));

    if (!name || !email || !phone) {
      skipped.push(`${name ?? "(zonder naam)"} — ${!phone ? "geen bruikbaar nummer" : "geen e-mailadres"}`);
      continue;
    }

    await q(
      `insert into partners (name, contact_name, email, phone, token, known_headcount)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (token) do nothing`,
      [
        name,
        pick(row, "contactpersoon", "contact") ?? null,
        email,
        phone,
        randomUUID().replace(/-/g, "").slice(0, 20),
        Number(pick(row, "medewerkers", "personeel", "headcount")) || null,
      ],
    );
    inserted++;
  }

  console.log(`${inserted} partners geïmporteerd.`);
  if (skipped.length) {
    console.log(`\n${skipped.length} overgeslagen — deze met de hand nalopen:`);
    skipped.forEach((s) => console.log("  · " + s));
  }
  await pool.end();
}

void main();
