import nodemailer from "nodemailer";
import { q, one, logEvent } from "./db.js";
import { QUESTIONS, LABELS, type Answers } from "../survey.js";

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_PORT === "465",
  auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
});

const ORG = process.env.ORG_NAME ?? "Wij";
const BASE = process.env.PUBLIC_BASE_URL!;

function shell(body: string) {
  return `<!doctype html><html lang="nl"><body style="margin:0;padding:32px 16px;background:#F2F4F3;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#101A24">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #C9D1D0;border-radius:4px;padding:32px">${body}</div>
<p style="max-width:520px;margin:16px auto 0;font-size:13px;color:#5A6B6A">${ORG}</p>
</body></html>`;
}

const button = (href: string, label: string) =>
  `<p style="margin:28px 0"><a href="${href}" style="display:inline-block;background:#0E6E5C;color:#fff;text-decoration:none;padding:12px 20px;border-radius:3px;font-weight:600">${label}</a></p>`;

// ---------------------------------------------------------------------------
// 1. Aankondiging — gaat naar iedereen vóór er één keer gebeld wordt
// ---------------------------------------------------------------------------
export async function sendAnnouncement(partnerId: string) {
  const p = await one<any>(
    `select id, name, contact_name, email, token from partners where id = $1`,
    [partnerId],
  );
  if (!p) return;

  const link = `${BASE}/s/${p.token}`;
  const from = process.env.TWILIO_FROM_NUMBER;

  const html = shell(`
<p>Beste ${p.contact_name ?? p.name},</p>

<p>We actualiseren de personeelsaantallen van onze partners, omdat de jaarlijkse
bijdrage daarop gebaseerd is. Dat kost u ongeveer twee minuten.</p>

<p><strong>U kunt het nu meteen zelf invullen:</strong></p>
${button(link, "Gegevens doorgeven")}

<p>Doet u dat niet, dan bellen we u de komende twee weken op werkdagen tussen
09:30 en 16:30. <strong>Dat gesprek voert een AI-assistent</strong> — dezelfde
techniek die u zelf voor uw telefonie zou kunnen inzetten. We bellen vanaf
${from}.</p>

<p>Wat u doorgeeft krijgt u daarna per mail ter bevestiging. Pas als u die
bevestigt, verwerken we het.</p>

<p style="font-size:14px;color:#5A6B6A">Liever niet gebeld worden?
<a href="${BASE}/s/${p.token}?opt-out=1" style="color:#5A6B6A">Zeg het hier</a>
en we bellen u niet.</p>`);

  await transport.sendMail({
    from: process.env.MAIL_FROM!,
    to: p.email,
    subject: `Even uw personeelsaantal bevestigen — ${ORG}`,
    html,
  });

  await q(
    `update partners set status='announced', announced_at=now(), updated_at=now()
      where id=$1 and status='pending'`,
    [p.id],
  );
  await logEvent("announcement_sent", { to: p.email }, p.id);
}

// ---------------------------------------------------------------------------
// 2. Bevestiging — na het gesprek. Dit is de rem op verkeerd verstane getallen.
// ---------------------------------------------------------------------------
export async function sendConfirmation(partnerId: string, confirmToken: string) {
  const p = await one<any>(
    `select p.name, p.contact_name, p.email, r.answers, r.confidence
       from partners p join responses r on r.partner_id = p.id
      where p.id = $1`,
    [partnerId],
  );
  if (!p) return;

  const answers = p.answers as Answers;
  const rows = QUESTIONS.filter((qq) => answers[qq.key as keyof Answers] != null)
    .map((qq) => {
      const raw = String(answers[qq.key as keyof Answers]);
      const value = LABELS[`${qq.key}:${raw}`] ?? raw;
      return `<tr>
        <td style="padding:8px 0;color:#5A6B6A;vertical-align:top">${qq.label}</td>
        <td style="padding:8px 0;font-weight:600;text-align:right">${value}</td>
      </tr>`;
    })
    .join("");

  const html = shell(`
<p>Beste ${p.contact_name ?? p.name},</p>

<p>Bedankt voor het gesprek. Dit hebben we genoteerd:</p>

<table style="width:100%;border-collapse:collapse;border-top:1px solid #C9D1D0;border-bottom:1px solid #C9D1D0;margin:20px 0">${rows}</table>

${p.confidence === "low" ? `<p style="background:#FBF3E4;border-left:3px solid #B87A2B;padding:12px 16px;font-size:14px">De verbinding was op één punt niet helemaal duidelijk. Controleert u het aantal medewerkers extra goed?</p>` : ""}

<p>Klopt dit? Dan hoeven we verder niets van u.</p>
${button(`${BASE}/api/confirm?t=${confirmToken}`, "Ja, dit klopt")}

<p style="font-size:14px">Klopt er iets niet?
<a href="${BASE}/api/confirm?t=${confirmToken}&edit=1" style="color:#0E6E5C">Pas het hier aan</a>.
We verwerken niets tot u bevestigt.</p>`);

  await transport.sendMail({
    from: process.env.MAIL_FROM!,
    to: p.email,
    subject: `Klopt dit? — ${ORG}`,
    html,
  });

  await logEvent("confirmation_sent", { to: p.email }, partnerId);
}
