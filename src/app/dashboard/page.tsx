import { Fragment, type ReactNode } from "react";
import { q, getCampaign, type Campaign } from "@/lib/db";
import { whyNotCallable } from "@/lib/callWindow";
import { QUESTIONS, answerLabel } from "@/survey";
import { statusLabel } from "@/lib/status";
import { Controls } from "./Controls";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Row = {
  id: string;
  name: string;
  status: string;
  attempts: number;
  known_headcount: number | null;
  reported_headcount: string | null;
  confidence: string | null;
  confirmed_at: string | null;
  last_attempt_at: string | null;
  /** Alle enquête-antwoorden zoals opgeslagen; null als er nog niets binnen is. */
  answers: Record<string, unknown> | null;
};

const DONE = ["verified", "self_reported"];

/** De contactpersoon is de enige vraag die een eigen kolom krijgt. */
const CONTACT_KEY = "contact_for_billing";

/**
 * De overige antwoorden, in de volgorde van de vragenlijst. Personeelsaantal
 * en contactpersoon staan al in hun eigen kolom, dus die slaan we over.
 * Wordt er een vraag toegevoegd in survey.ts, dan verschijnt hij hier vanzelf.
 */
function otherAnswers(answers: Record<string, unknown> | null) {
  if (!answers) return [];
  return QUESTIONS.filter((question) => question.key !== "headcount" && question.key !== CONTACT_KEY)
    .map((question) => ({
      key: question.key,
      label: question.label,
      value: answerLabel(question.key, answers[question.key]),
    }))
    .filter((entry) => entry.value !== "");
}

export default async function Dashboard() {
  let campaign: Campaign;
  let rows: Row[];
  try {
    campaign = await getCampaign();
    rows = await q<Row>(
      `select * from partner_board order by last_attempt_at desc nulls last, name`,
    );
  } catch (err) {
    // De echte fout (met stack) hoort in de serverlogs, niet op het scherm.
    console.error("[dashboard] kon gegevens niet laden:", err);
    return <DashboardError err={err} />;
  }

  const total = rows.length;
  const verified = rows.filter((r) => DONE.includes(r.status)).length;
  const awaiting = rows.filter((r) => r.status === "completed").length;
  const live = rows.filter((r) => r.status === "calling").length;
  const closed = rows.filter((r) => ["refused", "invalid", "excluded"].includes(r.status)).length;

  const blocked = whyNotCallable(new Date(), {
    start: campaign.window_start,
    end: campaign.window_end,
  });

  // Regels die aandacht vragen: laag vertrouwen, of een aantal dat sterk
  // afwijkt van wat wij geregistreerd hadden.
  const flagged = rows.filter((r) => {
    if (!r.reported_headcount) return false;
    if (r.confidence === "low") return true;
    if (!r.known_headcount) return false;
    const reported = Number(r.reported_headcount);
    return Math.abs(reported - r.known_headcount) / r.known_headcount > 0.25;
  });

  return (
    <main className="wrap wrap--wide">
      <p className="eyebrow">{process.env.ORG_NAME} · belronde personeelsaantallen</p>
      <h1 style={{ margin: "8px 0 24px" }}>
        {verified} van {total} bevestigd
      </h1>

      <Controls status={campaign.status} />

      {campaign.status === "running" && blocked && (
        <p style={{ fontSize: 14, color: "var(--mute)", marginTop: 12 }}>
          Er wordt nu niet gebeld — {blocked}. De wachtrij loopt vanzelf weer
          door zodra het venster opent.
        </p>
      )}

      <div className="tally">
        <div><b style={{ color: "var(--signal)" }}>{verified}</b><span className="eyebrow">bevestigd</span></div>
        <div><b>{awaiting}</b><span className="eyebrow">wacht op akkoord</span></div>
        <div><b style={{ color: "var(--live)" }}>{live}</b><span className="eyebrow">in gesprek</span></div>
        <div><b style={{ color: "var(--halt)" }}>{closed}</b><span className="eyebrow">niet bereikbaar</span></div>
      </div>

      {/* Signatuur: het lijnenbord. Eén streep per partner, zoals op een
          telefooncentrale. Kleur is status, knipperen is een lopend gesprek. */}
      <section>
        <h2 style={{ marginBottom: 4 }}>Lijnen</h2>
        <div className="board">
          {rows.map((r, i) => (
            <a
              key={r.id}
              className="line"
              data-state={r.status}
              href={`#p-${r.id}`}
              title={`${r.name} — ${r.status}${r.attempts ? ` (${r.attempts}×)` : ""}`}
            >
              <span className="n">{String(i + 1).padStart(2, "0")}</span>
            </a>
          ))}
        </div>
        <div className="legend">
          <span><i style={{ background: "var(--signal)" }} /> bevestigd</span>
          <span><i style={{ background: "var(--signal)", opacity: 0.3 }} /> wacht op akkoord</span>
          <span><i style={{ background: "var(--live)" }} /> in gesprek</span>
          <span><i style={{ background: "var(--halt)" }} /> geweigerd of onbereikbaar</span>
          <span><i style={{ background: "var(--rule)" }} /> nog te doen</span>
        </div>
      </section>

      {flagged.length > 0 && (
        <section style={{ marginTop: 40 }}>
          <h2>Even nakijken</h2>
          <p style={{ fontSize: 15, color: "var(--mute)", marginTop: 4 }}>
            Slecht verstaan, of een aantal dat meer dan een kwart afwijkt van wat
            wij hadden staan. Deze gaan niet door naar de facturatie zonder dat
            iemand ernaar gekeken heeft.
          </p>
          <table className="log">
            <thead>
              <tr>
                <th>Partner</th><th>Opgegeven</th><th>Bij ons</th>
                <th>Contactpersoon</th><th>Reden</th>
              </tr>
            </thead>
            <tbody>
              {flagged.map((r) => (
                <tr key={r.id} id={`p-${r.id}`}>
                  <td>{r.name}</td>
                  <td className="num">{r.reported_headcount}</td>
                  <td className="num" style={{ color: "var(--mute)" }}>{r.known_headcount ?? "—"}</td>
                  {/* Wie je moet hebben als je hierover wilt terugbellen. */}
                  <td>{answerLabel(CONTACT_KEY, r.answers?.[CONTACT_KEY]) || "—"}</td>
                  <td style={{ color: "var(--mute)" }}>
                    {r.confidence === "low" ? "slecht verstaan" : "wijkt sterk af"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section style={{ marginTop: 40 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
          <h2>Alle partners</h2>
          <a href="/dashboard/export" style={{ fontSize: 14 }}>
            Download Excel
          </a>
        </div>
        <table className="log">
          <thead>
            <tr>
              <th>Partner</th><th>Status</th><th>Pogingen</th>
              <th>Aantal</th><th>Contactpersoon</th><th>Laatste poging</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const extras = otherAnswers(r.answers);
              return (
                <Fragment key={r.id}>
                  <tr id={`p-${r.id}`}>
                    <td>{r.name}</td>
                    <td style={{ color: statusColor(r.status) }}>{statusLabel(r.status)}</td>
                    <td className="num">{r.attempts || "—"}</td>
                    <td className="num">{r.reported_headcount ?? "—"}</td>
                    <td>{answerLabel(CONTACT_KEY, r.answers?.[CONTACT_KEY]) || "—"}</td>
                    <td className="num" style={{ color: "var(--mute)" }}>
                      {r.last_attempt_at
                        ? new Date(r.last_attempt_at).toLocaleString("nl-NL", {
                            timeZone: "Europe/Amsterdam",
                            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
                          })
                        : "—"}
                    </td>
                  </tr>

                  {/* De rest van wat de partner vertelde. Een opmerking kan lang
                      zijn en past niet in een kolom, dus die krijgt de volle
                      breedte onder de regel. Alleen tonen als er iets staat. */}
                  {extras.length > 0 && (
                    <tr>
                      <td colSpan={6} style={{ borderTop: 0, paddingTop: 0, color: "var(--mute)", fontSize: 13 }}>
                        {extras.map((entry) => (
                          <span key={entry.key} style={{ marginRight: 18 }}>
                            {entry.label}: <span style={{ color: "var(--ink)" }}>{entry.value}</span>
                          </span>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function statusColor(s: string) {
  if (DONE.includes(s)) return "var(--signal)";
  if (s === "calling") return "var(--live)";
  if (["refused", "invalid", "excluded"].includes(s)) return "var(--halt)";
  return "inherit";
}

// ---------------------------------------------------------------------------
// Nette foutpagina als de database niet bereikbaar is of het schema ontbreekt.
// Geen stack trace op het scherm — die staat in de serverlogs.
// ---------------------------------------------------------------------------
function diagnose(err: unknown): { title: string; body: ReactNode } {
  const e = err as { code?: string; message?: string } | null;
  const code = e?.code ?? "";
  const msg = e?.message ?? "";

  // Verbinding: server niet bereikbaar, DNS, timeout, TLS.
  const connErrors = [
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ECONNRESET",
    "3D000", // invalid_catalog_name: database bestaat niet
    "28P01", // ongeldig wachtwoord
  ];
  if (connErrors.includes(code) || /getaddrinfo|connect|timeout|password|ssl|econn/i.test(msg)) {
    return {
      title: "Database niet bereikbaar",
      body: (
        <>
          De verbinding met de database lukt niet. Controleer{" "}
          <code style={{ fontFamily: "var(--mono)", fontSize: 14 }}>DATABASE_URL</code>,
          of de EU-Postgres draait, en of het wachtwoord en de netwerkregels
          kloppen. De precieze fout staat in de serverlogs.
        </>
      ),
    };
  }

  // Tabellen of de campagne-rij ontbreken: schema nog niet gedraaid.
  if (
    code === "42P01" || // undefined_table: relation does not exist
    /relation .* does not exist|ontbreekt|schema\.sql|partner_board/i.test(msg)
  ) {
    return {
      title: "Databasetabellen ontbreken",
      body: (
        <>
          Het schema is nog niet ingeladen. Draai het eenmalig:{" "}
          <code style={{ fontFamily: "var(--mono)", fontSize: 14 }}>npm run db:push</code>{" "}
          (dat is{" "}
          <code style={{ fontFamily: "var(--mono)", fontSize: 14 }}>
            psql $DATABASE_URL -f db/schema.sql
          </code>
          ). Daarna maakt hij ook de campagne-rij aan.
        </>
      ),
    };
  }

  return {
    title: "De gegevens konden niet geladen worden",
    body: (
      <>
        Er ging iets mis bij het ophalen van de belronde. Kijk in de serverlogs
        voor de precieze fout en probeer de pagina daarna opnieuw.
      </>
    ),
  };
}

function DashboardError({ err }: { err: unknown }) {
  const { title, body } = diagnose(err);
  return (
    <main className="wrap">
      <p className="eyebrow">{process.env.ORG_NAME} · belronde personeelsaantallen</p>
      <h1 style={{ margin: "8px 0 20px" }}>{title}</h1>
      <div className="card">
        <p style={{ margin: 0 }}>{body}</p>
      </div>
    </main>
  );
}
