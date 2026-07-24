# Partner-enquête via AI-telefoongesprek

Belt honderd partnerbedrijven met een AI-assistent om hun personeelsaantal op te
halen. De jaarlijkse bijdrage is op dat aantal gebaseerd, dus de cijfers moeten
kloppen — daarom bevestigt elke partner het opgehaalde aantal nog per mail, en
telt pas een *bevestigd* antwoord mee. Iedereen krijgt vooraf een
aankondigingsmail met een persoonlijke link om het ook zelf te kunnen invullen.

De assistent zegt aan het begin van élk gesprek dat hij een AI is (verplicht
onder artikel 50 van de AI Act, vanaf 2 augustus 2026 ook expliciet voor
telefonie).

---

## Gesplitste deploy

Dit systeem draait op **twee** plekken. Netlify kan niet alles: Netlify Functions
zijn kortlevend en accepteren geen inkomende WebSocket, terwijl Twilio
ConversationRelay per gesprek één tot drie minuten een WebSocket openhoudt. De
belplanner is bovendien een proces dat continu draait.

| Onderdeel | Waar | Waarom |
|---|---|---|
| Next.js-app: dashboard, `/s/[token]`-formulier, API-routes | **Netlify** (bouwt vanuit de root) | gewoon web |
| Worker: belplanner + ConversationRelay-WebSocket | **Railway of Fly.io**, regio Amsterdam/Frankfurt | moet blijven draaien |
| Postgres | **Neon of Supabase**, EU-regio | gespreksdata van NL-bedrijven, AVG |

Eén repo, twee deploy-targets. Beide lezen dezelfde `DATABASE_URL`.

```
                aankondigingsmail + persoonlijke link
                              │
   ┌─────────── Netlify ──────┴───────────┐        ┌──── Railway / Fly.io ────┐
   │  Next.js-app                         │        │  worker  (npm run        │
   │  • /dashboard  (Basic Auth, noindex) │        │   worker:start)          │
   │  • /s/[token]  partnerformulier      │        │  • belplanner (tick 15s) │
   │  • /api/twiml, /api/twilio-status,   │◀──────▶│  • ConversationRelay-ws  │
   │    /api/campaign, /api/confirm       │  DB    │    op poort 8081         │
   └──────────────────┬───────────────────┘        └────────────┬─────────────┘
                      │                                          │
                      └──────────── Postgres (EU) ───────────────┘
                                       ▲
                                   Twilio belt uit, opent WebSocket naar de worker
```

### Netlify (de app)

- Build vanuit de root: `npm run build` (staat al in `netlify.toml`).
- Zet alle variabelen uit `.env.example` behalve dat `RELAY_PORT` alleen de
  worker nodig heeft.
- `PUBLIC_BASE_URL` = het Netlify-adres van de app.
- `RELAY_WS_URL` = het `wss://`-adres van de worker (zie hieronder).

### Worker (belplanner + WebSocket)

Draai `npm run worker:start`. Twee manieren:

- **Docker** (aanbevolen): de meegeleverde `Dockerfile` compileert de worker
  (`tsconfig.worker.json` → `dist/`) en start hem. Railway en Fly.io pakken die
  automatisch op. De worker luistert op poort **8081**.
- **Buildpack**: de `Procfile` doet hetzelfde zonder container.

Wijs `RELAY_WS_URL` (in de Netlify-omgeving) naar het publieke `wss://`-adres van
deze worker, zodat `/api/twiml` Twilio naar de juiste WebSocket stuurt.

---

## In gebruik nemen — volgorde

1. **Database opzetten.** Maak een EU-Postgres (Neon Frankfurt of Supabase
   eu-central-1) en zet `DATABASE_URL`. Draai het schema:
   ```bash
   npm run db:push        # psql $DATABASE_URL -f db/schema.sql
   ```
   Dit maakt ook de campagne-rij aan met status `draft`.

2. **Partners importeren** uit Excel (kolommen hoofdletterongevoelig:
   naam/bedrijf, contactpersoon, email, telefoon, medewerkers):
   ```bash
   npm run import -- partners.xlsx
   ```
   Aan het eind zie je welke rijen zijn overgeslagen (geen bruikbaar nummer of
   e-mailadres) — die met de hand nalopen.

3. **Aankondigen.** Stuur iedereen op `pending` de aankondigingsmail:
   ```bash
   npm run announce
   ```
   Deze mail is wat dit onderscheidt van koud bellen: hij bevat het nummer
   waarvandaan we bellen, het tijdvak, de vermelding dat het een AI is, de
   persoonlijke link en een opt-out.

4. **Drie dagen wachten.** Geef mensen de kans het zelf in te vullen of zich af
   te melden vóór er gebeld wordt.

5. **Campagne starten.** Ga naar `/dashboard` en klik **Bellen starten**, of:
   ```bash
   curl -XPOST $PUBLIC_BASE_URL/api/campaign \
     -H 'content-type: application/json' -d '{"action":"start"}'
   ```
   De worker leest `campaign.status` vóór elke ronde en belt alleen op werkdagen
   binnen het venster (standaard 09:30–16:30, `Europe/Amsterdam`).

---

## Stoppen

Op het dashboard, of via `/api/campaign`:

- **Pauzeren** (`{"action":"pause"}`) — geen nieuwe gesprekken meer starten,
  lopende gesprekken netjes afmaken.
- **Alles stoppen** (`{"action":"stop"}`) — ook lopende gesprekken afbreken. De
  worker hangt bij de eerstvolgende tick (binnen 15 seconden) alle lopende calls
  op via de Twilio-API en zet die partners terug in de wachtrij.
- **Hervatten** (`{"action":"resume"}`) — weer op `running`.

De campagnestatus is de noodrem: staat hij op iets anders dan `running`, dan
start de worker geen enkel gesprek.

---

## De staten

Een partner doorloopt: `pending` → `announced` → (`scheduled`) → `calling` →
`completed` → **`verified`**. Alleen `verified` (per mail bevestigd) en
`self_reported` (zelf via het formulier ingevuld) tellen mee voor de bijdrage.
`completed` staat bewust apart: een geslaagd gesprek levert nog géén definitief
getal — pas na de klik op "Ja, dit klopt" in de bevestigingsmail.

Het dashboard heeft een sectie **"Even nakijken"** voor gevallen met laag
vertrouwen (`confidence: low`) of een aantal dat meer dan 25% afwijkt van wat we
al hadden staan.

---

## Ontwikkelen

```bash
npm install
cp .env.example .env      # vul in
npm run dev               # Next.js-app op http://localhost:3000
npm run worker            # worker + relay (los proces, tsx)
```

- `npm run build` — Next.js-productiebuild (wat Netlify draait).
- `npm run worker:build` — compileert de worker naar `dist/` (wat de Dockerfile
  draait).

Het `/dashboard` zit achter Basic Auth (`DASHBOARD_USER` / `DASHBOARD_PASS`) en
krijgt `X-Robots-Tag: noindex`.

---

## Eerst testen, vóór de eerste echte call

Zet één testrij in `partners` met je eigen nummer en `status='announced'`, campagne
op `running`, en loop deze vijf gevallen na:

1. **Neem op, zeg meteen "nee bedankt".** → gesprek sluit direct af,
   partner op `refused`.
2. **Laat overgaan naar voicemail.** → assistent spreekt niets in, partner komt
   terug in de wachtrij (`no_answer`), poging opnieuw ingepland.
3. **Zeg een getal onduidelijk.** → assistent vraagt door en zet
   `confidence: low`; de partner verschijnt onder "Even nakijken".
4. **Druk midden in het gesprek op "Alles stoppen".** → verbinding binnen 15
   seconden verbroken.
5. **Rond een gesprek netjes af.** → je krijgt de bevestigingsmail; pas na de
   klik op "Ja, dit klopt" gaat de status naar `verified`.

---

## Privacy / AVG

- Gespreksopnames staan standaard **uit** (`RECORD_CALLS=false`). Transcripten
  zijn genoeg en opnames brengen extra AVG-verplichtingen mee.
- Twilio- en Anthropic-sleutels staan alleen server-side (worker + API-routes),
  nooit in client-code.
- Postgres in een EU-regio, `.env` staat in `.gitignore`.
