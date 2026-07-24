import type { Metadata } from "next";

// Deze pagina niet indexeren — het is geen publieke landingspagina.
export const metadata: Metadata = {
  title: "Partnergegevens",
  robots: { index: false, follow: false },
};

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL ?? "partners@jouwdomein.nl";

/**
 * De root. Partners belanden hier als ze het token uit hun link knippen of het
 * domein uit de mail overtypen. Geen redirect naar het dashboard — die moeten
 * iets nuttigs zien, geen inlogscherm.
 */
export default function Home() {
  const mailto =
    `mailto:${SUPPORT_EMAIL}` +
    `?subject=${encodeURIComponent("Mijn persoonlijke link kwijt")}`;

  return (
    <main className="wrap">
      <p className="eyebrow">{process.env.ORG_NAME} · partnergegevens</p>
      <h1 style={{ margin: "8px 0 20px" }}>Uw persoonlijke link</h1>

      <div className="card">
        <p style={{ marginTop: 0 }}>
          Om uw personeelsaantal door te geven heeft u uw <strong>persoonlijke
          link</strong> nodig. Die is uniek voor uw organisatie en staat in de
          aankondigingsmail die u van ons heeft ontvangen.
        </p>
        <p>
          Zoek in uw mail op het onderwerp met “personeelsaantal” en klik op de
          knop <em>Gegevens doorgeven</em>. De link ziet er ongeveer zo uit:
          {" "}
          <code style={{ fontFamily: "var(--mono)", fontSize: 14 }}>
            /s/uw-persoonlijke-code
          </code>
          .
        </p>
        <p style={{ marginBottom: 0 }}>
          Link kwijt of geen mail ontvangen?{" "}
          <a href={mailto}>Mail ons</a> en we sturen u een nieuwe.
        </p>
      </div>

      <p style={{ fontSize: 14, color: "var(--mute)", marginTop: 24 }}>
        Liever telefonisch? Dan bellen we u op werkdagen tussen 09:30 en 16:30 —
        dat gesprek voert een AI-assistent.
      </p>
    </main>
  );
}
