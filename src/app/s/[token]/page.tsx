import { notFound } from "next/navigation";
import { one } from "@/lib/db";
import { QUESTIONS } from "@/survey";
import { SurveyForm } from "./SurveyForm";
import { optOut } from "./actions";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

export default async function Page({ params, searchParams }: Props) {
  const { token } = await params;
  const sp = await searchParams;

  const partner = await one<any>(
    `select p.id, p.name, p.contact_name, p.status, p.do_not_call,
            r.answers, r.confirmed_at
       from partners p
       left join responses r on r.partner_id = p.id
      where p.token = $1`,
    [token],
  );
  if (!partner) notFound();

  if (sp["opt-out"] === "1" && !partner.do_not_call) {
    await optOut(token);
  }

  const done = partner.confirmed_at || partner.status === "self_reported";
  const opted = partner.do_not_call && !done;

  return (
    <main className="wrap">
      <p className="eyebrow">{process.env.ORG_NAME} · partnergegevens</p>
      <h1 style={{ margin: "8px 0 20px" }}>{partner.name}</h1>

      {opted && (
        <div className="notice">
          Genoteerd — we bellen u niet. U kunt het hieronder alsnog zelf invullen
          als u wilt.
        </div>
      )}

      {sp.bevestigd === "1" && (
        <div className="notice">
          Bevestigd. Dit is verwerkt in uw dossier, u hoeft verder niets te doen.
        </div>
      )}

      {done && !sp.bevestigd ? (
        <div className="card">
          <h2>Dit hebben we van u</h2>
          <p style={{ color: "var(--mute)", fontSize: 15 }}>
            U kunt het hieronder aanpassen zolang de bijdrage nog niet is
            vastgesteld.
          </p>
          <SurveyForm
            token={token}
            questions={QUESTIONS}
            initial={partner.answers ?? {}}
          />
        </div>
      ) : (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            Beste {partner.contact_name ?? "partner"}, dit duurt ongeveer twee
            minuten. De bijdrage die u betaalt hangt af van uw personeelsaantal,
            dus we willen dat één keer per jaar goed vastleggen.
          </p>
          <SurveyForm
            token={token}
            questions={QUESTIONS}
            initial={partner.answers ?? {}}
          />
        </div>
      )}

      <p style={{ fontSize: 14, color: "var(--mute)", marginTop: 24 }}>
        Belt u liever? Dan doen we dat op werkdagen tussen 09:30 en 16:30 — dat
        gesprek voert een AI-assistent. De vragen hierboven zijn letterlijk de
        vragen die hij stelt.
      </p>
    </main>
  );
}
