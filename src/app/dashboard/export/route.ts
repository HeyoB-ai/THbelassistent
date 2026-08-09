import * as XLSX from "xlsx";
import { q } from "@/lib/db";
import { QUESTIONS, answerLabel } from "@/survey";
import { statusLabel, sourceLabel } from "@/lib/status";

/**
 * Excel-export van de belronde.
 *
 * Staat bewust onder /dashboard: de middleware zet Basic Auth op
 * /dashboard/:path*, en dit bestand bevat dezelfde partnergegevens als het
 * dashboard. Als /api/export zou dit publiek zijn.
 *
 * De antwoordkolommen komen uit src/survey.ts. Voeg je daar een vraag toe,
 * dan staat hij hier vanzelf in — zonder dat iemand deze lijst bijwerkt.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs"; // xlsx schrijft een Buffer

type Row = {
  name: string;
  phone: string;
  status: string;
  attempts: number;
  known_headcount: number | null;
  response_source: string | null;
  confidence: string | null;
  confirmed_at: string | null;
  last_attempt_at: string | null;
  answers: Record<string, unknown> | null;
};

export async function GET() {
  const rows = await q<Row>(`select * from partner_board order by name`);

  const header = [
    "Bedrijfsnaam",
    "Telefoon",
    "Ons bekende aantal",
    ...QUESTIONS.map((question) => question.label),
    "Status",
    "Pogingen",
    "Bron",
    "Vertrouwen",
    "Bevestigd op",
    "Laatste poging",
  ];

  const body = rows.map((r) => [
    r.name,
    r.phone,
    r.known_headcount ?? "",
    ...QUESTIONS.map((question) => cell(question.key, question.input, r.answers)),
    statusLabel(r.status),
    r.attempts,
    sourceLabel(r.response_source),
    confidenceLabel(r.confidence),
    dutchDateTime(r.confirmed_at),
    dutchDateTime(r.last_attempt_at),
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([header, ...body]);
  sheet["!cols"] = header.map((title) => ({ wch: Math.max(14, Math.min(40, title.length + 2)) }));

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Belronde");
  const buffer: Buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="belronde-${today}.xlsx"`,
      // Bevat partnergegevens: nergens laten cachen.
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Eén antwoordcel. Een aantal blijft een getal, zodat je in Excel kunt sorteren
 * en optellen; al het andere wordt de leesbare tekst achter de opgeslagen waarde.
 */
function cell(key: string, input: string, answers: Record<string, unknown> | null) {
  const value = answers?.[key];
  if (input === "number" && typeof value === "number") return value;
  return answerLabel(key, value);
}

function confidenceLabel(confidence: string | null) {
  if (!confidence) return "";
  return { high: "hoog", low: "laag" }[confidence] ?? confidence;
}

function dutchDateTime(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("nl-NL", {
    timeZone: "Europe/Amsterdam",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
