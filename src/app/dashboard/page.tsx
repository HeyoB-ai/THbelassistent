import { q, getCampaign } from "@/lib/db";
import { whyNotCallable } from "@/lib/callWindow";
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
};

const DONE = ["verified", "self_reported"];

export default async function Dashboard() {
  const campaign = await getCampaign();
  const rows = await q<Row>(
    `select * from partner_board order by last_attempt_at desc nulls last, name`,
  );

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
              <tr><th>Partner</th><th>Opgegeven</th><th>Bij ons</th><th>Reden</th></tr>
            </thead>
            <tbody>
              {flagged.map((r) => (
                <tr key={r.id} id={`p-${r.id}`}>
                  <td>{r.name}</td>
                  <td className="num">{r.reported_headcount}</td>
                  <td className="num" style={{ color: "var(--mute)" }}>{r.known_headcount ?? "—"}</td>
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
        <h2>Alle partners</h2>
        <table className="log">
          <thead>
            <tr>
              <th>Partner</th><th>Status</th><th>Pogingen</th>
              <th>Aantal</th><th>Laatste poging</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} id={`p-${r.id}`}>
                <td>{r.name}</td>
                <td style={{ color: statusColor(r.status) }}>{statusLabel(r.status)}</td>
                <td className="num">{r.attempts || "—"}</td>
                <td className="num">{r.reported_headcount ?? "—"}</td>
                <td className="num" style={{ color: "var(--mute)" }}>
                  {r.last_attempt_at
                    ? new Date(r.last_attempt_at).toLocaleString("nl-NL", {
                        timeZone: "Europe/Amsterdam",
                        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
                      })
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function statusLabel(s: string) {
  return {
    pending: "nog niet aangekondigd",
    announced: "mail verstuurd",
    scheduled: "belafspraak",
    calling: "in gesprek",
    completed: "wacht op akkoord",
    verified: "bevestigd",
    self_reported: "zelf ingevuld",
    no_answer: "niet opgenomen",
    refused: "wil niet meedoen",
    invalid: "nummer klopt niet",
    excluded: "niet bellen",
  }[s] ?? s;
}

function statusColor(s: string) {
  if (DONE.includes(s)) return "var(--signal)";
  if (s === "calling") return "var(--live)";
  if (["refused", "invalid", "excluded"].includes(s)) return "var(--halt)";
  return "inherit";
}
