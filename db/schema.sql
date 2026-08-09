-- Partner-enquête: datamodel
-- Eén bron van waarheid. De worker leest hier zijn werk uit, het dashboard leest hier de stand uit.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Campagne: precies één rij. Dit is de noodrem.
-- ---------------------------------------------------------------------------
create table if not exists campaign (
  id            int primary key default 1,
  status        text not null default 'draft'
                  check (status in ('draft','running','paused','stopped')),
  -- 'paused'  = geen nieuwe gesprekken starten, lopende afmaken
  -- 'stopped' = ook lopende gesprekken afbreken
  max_concurrent int not null default 3,
  max_attempts   int not null default 4,
  window_start   time not null default '09:30',
  window_end     time not null default '16:30',
  updated_at     timestamptz not null default now(),
  constraint campaign_singleton check (id = 1)
);

insert into campaign (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Partners: geïmporteerd uit Excel
-- ---------------------------------------------------------------------------
create table if not exists partners (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  contact_name    text,
  email           text not null,
  phone           text not null,              -- E.164, bv. +31201234567
  token           text not null unique,       -- voor de persoonlijke link in de mail
  known_headcount int,                        -- wat wij nu in de administratie hebben

  status text not null default 'pending'
    check (status in (
      'pending',      -- nog niets mee gedaan
      'announced',    -- aankondigingsmail verstuurd
      'scheduled',    -- partner koos zelf een belmoment
      'calling',      -- er loopt nu een gesprek
      'completed',    -- antwoorden binnen, nog niet bevestigd
      'verified',     -- partner heeft de antwoorden per mail bevestigd
      'self_reported',-- partner vulde het webformulier in
      'no_answer',    -- niet opgenomen, komt terug in de wachtrij
      'refused',      -- wil niet meedoen
      'invalid',      -- nummer klopt niet
      'excluded'      -- handmatig uitgezet
    )),

  attempts        int not null default 0,
  scheduled_for   timestamptz,                -- gekozen belmoment, of volgende poging
  do_not_call     boolean not null default false,
  announced_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists partners_queue_idx
  on partners (status, scheduled_for)
  where do_not_call = false;

-- ---------------------------------------------------------------------------
-- Belpogingen: elke poging apart, ook de mislukte
-- ---------------------------------------------------------------------------
create table if not exists call_attempts (
  id            uuid primary key default gen_random_uuid(),
  partner_id    uuid not null references partners(id) on delete cascade,
  twilio_sid    text unique,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  duration_sec  int,

  outcome text
    check (outcome in ('completed','partial','refused','no_answer',
                       'voicemail','gatekeeper','failed','aborted','no_time')),

  answered_by   text,        -- Twilio AMD: human / machine_start / fax / unknown
  transcript    jsonb,       -- [{role, text, at}]
  recording_url text,
  error         text
);

create index if not exists call_attempts_partner_idx on call_attempts (partner_id, started_at desc);

-- 'no_time' is later toegevoegd: de gebelde nam op maar had geen tijd. Dat is
-- iets anders dan weigeren — hij blijft in de bellijst. Op een bestaande
-- database wordt het 'create table' hierboven overgeslagen, dus de check moet
-- apart bijgewerkt worden. Deze twee regels kun je zo vaak draaien als je wilt.
alter table call_attempts drop constraint if exists call_attempts_outcome_check;
alter table call_attempts add constraint call_attempts_outcome_check
  check (outcome in ('completed','partial','refused','no_answer',
                     'voicemail','gatekeeper','failed','aborted','no_time'));

-- ---------------------------------------------------------------------------
-- Antwoorden: één rij per partner, laatste versie wint
-- ---------------------------------------------------------------------------
create table if not exists responses (
  partner_id    uuid primary key references partners(id) on delete cascade,
  source        text not null check (source in ('call','web','manual')),
  answers       jsonb not null,          -- gevalideerd tegen src/survey.ts
  confidence    text check (confidence in ('high','low')),
  attempt_id    uuid references call_attempts(id) on delete set null,

  confirmed_at  timestamptz,             -- partner klikte akkoord in de bevestigingsmail
  confirm_token text unique,
  reviewed_by   text,                    -- of een collega keurde het handmatig goed
  reviewed_at   timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Auditlog: wie zette de campagne stil, wanneer, waarom
-- ---------------------------------------------------------------------------
create table if not exists events (
  id         bigserial primary key,
  partner_id uuid references partners(id) on delete cascade,
  kind       text not null,
  detail     jsonb,
  at         timestamptz not null default now()
);

create index if not exists events_at_idx on events (at desc);

-- ---------------------------------------------------------------------------
-- Handige view voor het dashboard
-- ---------------------------------------------------------------------------
create or replace view partner_board as
select
  p.id, p.name, p.phone, p.status, p.attempts, p.scheduled_for,
  p.known_headcount,
  r.source        as response_source,
  r.answers ->> 'headcount' as reported_headcount,
  r.confidence,
  r.confirmed_at,
  (select max(started_at) from call_attempts ca where ca.partner_id = p.id) as last_attempt_at,
  -- Alle antwoorden, niet alleen het personeelsaantal: het dashboard en de
  -- Excel-export leiden hun kolommen af uit src/survey.ts en hebben de hele
  -- jsonb nodig. Nieuwe kolommen horen hierónder, want 'create or replace
  -- view' staat alleen toe dat je achteraan uitbreidt.
  r.answers
from partners p
left join responses r on r.partner_id = p.id;
