-- just-review Lead-Dashboard · Datenbankschema
-- Einmalig im Supabase SQL Editor ausführen.
--
-- Aufbau:
--   profiles   Mitarbeiter. Wer hier keinen Eintrag hat, sieht nichts.
--   listen     Quelle aller Dropdowns, entspricht dem Tab "Listen".
--   leads      Die Arbeitsfläche, entspricht dem Tab "Leads".
--   aktivitaet Änderungsprotokoll: wer hat wann was geändert.

-- ============================================================ profiles

create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  name        text not null default '',
  email       text not null default '',
  rolle       text not null default 'mitarbeiter'
              check (rolle in ('mitarbeiter', 'admin')),
  staedte     text[] not null default '{}',
  aktiv       boolean not null default true,
  erstellt_am timestamptz not null default now()
);

comment on table public.profiles is
  'Mitarbeiter. Zugang bekommt nur, wer hier steht - siehe Tabelle einladungen.';

-- Wer sich anmelden darf. Vorher per INSERT mit der E-Mail befüllen,
-- sonst kommt der Account zwar durch Google, sieht aber keine Daten.
create table if not exists public.einladungen (
  email       text primary key,
  name        text not null default '',
  rolle       text not null default 'mitarbeiter'
              check (rolle in ('mitarbeiter', 'admin')),
  eingeloest  boolean not null default false,
  erstellt_am timestamptz not null default now()
);

-- Beim ersten Login automatisch ein Profil anlegen, aber nur fuer Eingeladene.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  einladung public.einladungen%rowtype;
begin
  select * into einladung
  from public.einladungen
  where lower(email) = lower(new.email);

  if not found then
    -- Nicht eingeladen: kein Profil, damit greift keine einzige RLS-Policy.
    return new;
  end if;

  insert into public.profiles (id, name, email, rolle)
  values (
    new.id,
    coalesce(nullif(einladung.name, ''), new.raw_user_meta_data->>'full_name', new.email),
    new.email,
    einladung.rolle
  )
  on conflict (id) do nothing;

  update public.einladungen
  set eingeloest = true
  where lower(email) = lower(new.email);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================== listen

create table if not exists public.listen (
  id         bigint generated always as identity primary key,
  kategorie  text not null,
  wert       text not null,
  sortierung int  not null default 0,
  unique (kategorie, wert)
);

comment on table public.listen is
  'Dropdown-Werte. Kategorien: branche, status, kontaktkanal, produktinteresse, land.';

insert into public.listen (kategorie, wert, sortierung) values
  ('status', 'Neu', 1),
  ('status', 'Recherchiert', 2),
  ('status', 'Kontaktiert', 3),
  ('status', 'Follow-up', 4),
  ('status', 'Termin vereinbart', 5),
  ('status', 'Angebot gesendet', 6),
  ('status', 'Verhandlung', 7),
  ('status', 'Gewonnen', 8),
  ('status', 'Verloren / kein Interesse', 9),
  ('kontaktkanal', 'E-Mail', 1),
  ('kontaktkanal', 'Telefon', 2),
  ('kontaktkanal', 'WhatsApp', 3),
  ('kontaktkanal', 'Instagram DM', 4),
  ('kontaktkanal', 'LinkedIn', 5),
  ('kontaktkanal', 'Kontaktformular', 6),
  ('kontaktkanal', 'Persönlich vor Ort', 7),
  ('kontaktkanal', 'Messe / Event', 8),
  ('produktinteresse', 'NFC Bewertungsaufsteller', 1),
  ('produktinteresse', 'NFC Visitenkarte', 2),
  ('produktinteresse', 'NFC Handysticker', 3),
  ('produktinteresse', 'Kombi-Paket', 4),
  ('produktinteresse', 'Individuelles Design', 5),
  ('produktinteresse', 'Großbestellung / Mengenrabatt', 6),
  ('produktinteresse', 'Noch unklar', 7),
  ('produktinteresse', 'Nein', 8),
  ('land', 'Deutschland', 1),
  ('land', 'Österreich', 2),
  ('land', 'Schweiz', 3),
  ('land', 'Sonstiges', 4)
on conflict (kategorie, wert) do nothing;

-- =============================================================== leads

create table if not exists public.leads (
  id                      uuid primary key default gen_random_uuid(),
  -- Laufende Nummer, stabil. Ersetzt die kaputte Nr.-Spalte der Tabelle.
  nr                      bigint generated always as identity,

  -- Firma und Kontakt
  firmenname              text not null default '',
  branche                 text not null default '',
  ansprechpartner         text not null default '',
  position                text not null default '',
  email                   text not null default '',
  telefon                 text not null default '',
  website                 text not null default '',

  -- Adresse. Eine Strassenspalte, nicht zwei.
  strasse                 text not null default '',
  plz                     text not null default '',
  ort                     text not null default '',
  land                    text not null default 'Deutschland',

  -- Google-Profil
  google_profil_link      text not null default '',
  google_maps_link        text not null default '',
  google_bewertung        numeric(2,1),
  google_bewertungen      integer,
  google_profil_vorhanden boolean,
  zuletzt_geprueft        date,

  -- Vertriebsprozess
  status                  text not null default 'Neu',
  kontaktiert_am          date,
  kontaktkanal            text not null default '',
  letzter_kontakt_am      date,
  anzahl_kontakte         integer not null default 0,
  wiedervorlage_am        date,
  produktinteresse        text not null default '',
  angebot_gesendet_am     date,
  angebotswert            numeric(10,2),
  abschluss_wahrsch       numeric(3,2)
                          check (abschluss_wahrsch between 0 and 1),
  -- Automatisch, nie von Hand pflegen.
  gewichteter_wert        numeric(12,2)
                          generated always as
                          (round(coalesce(angebotswert,0) * coalesce(abschluss_wahrsch,0), 2))
                          stored,

  -- NFC-Linkverwaltung
  lead_quelle             text not null default '',
  place_id                text not null default '',
  bewertungslink          text not null default '',
  kurzlink                text not null default '',
  link_herkunft           text not null default '',
  linktest                text not null default '',
  getestet_am             date,

  notizen                 text not null default '',

  -- Die Spalte, die eurer Tabelle fehlt.
  bearbeiter              uuid references public.profiles(id) on delete set null,

  erstellt_am             timestamptz not null default now(),
  erstellt_von            uuid references public.profiles(id) on delete set null,
  geaendert_am            timestamptz not null default now(),
  geaendert_von           uuid references public.profiles(id) on delete set null,

  -- Herkunft aus dem Sheet, damit der Import wiederholbar bleibt.
  import_schluessel       text unique
);

comment on column public.leads.import_schluessel is
  'Firmenname|Strasse|Ort aus dem Google Sheet. Verhindert Dubletten beim erneuten Import.';

create index if not exists leads_ort_idx         on public.leads (ort);
create index if not exists leads_status_idx      on public.leads (status);
create index if not exists leads_bearbeiter_idx  on public.leads (bearbeiter);
create index if not exists leads_wiedervorlage_idx on public.leads (wiedervorlage_am)
  where wiedervorlage_am is not null;
create index if not exists leads_suche_idx on public.leads
  using gin (to_tsvector('german', firmenname || ' ' || branche || ' ' || strasse || ' ' || ort));

-- ========================================================== aktivitaet

create table if not exists public.aktivitaet (
  id        bigint generated always as identity primary key,
  lead_id   uuid not null references public.leads(id) on delete cascade,
  benutzer  uuid references public.profiles(id) on delete set null,
  feld      text not null,
  alt       text,
  neu       text,
  zeit      timestamptz not null default now()
);

create index if not exists aktivitaet_lead_idx on public.aktivitaet (lead_id, zeit desc);
create index if not exists aktivitaet_zeit_idx on public.aktivitaet (zeit desc);

-- Protokolliert jede Aenderung an den Feldern, die im Dashboard bearbeitbar sind.
create or replace function public.log_lead_aenderung()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  f text;
  alt_wert text;
  neu_wert text;
  felder text[] := array[
    'firmenname','branche','ansprechpartner','position','email','telefon','website',
    'strasse','plz','ort','status','kontaktkanal','kontaktiert_am','letzter_kontakt_am',
    'anzahl_kontakte','wiedervorlage_am','produktinteresse','angebot_gesendet_am',
    'angebotswert','abschluss_wahrsch','notizen','bearbeiter','place_id','bewertungslink'
  ];
begin
  new.geaendert_am := now();

  foreach f in array felder loop
    execute format('select ($1).%I::text, ($2).%I::text', f, f)
      into alt_wert, neu_wert
      using old, new;

    if alt_wert is distinct from neu_wert then
      insert into public.aktivitaet (lead_id, benutzer, feld, alt, neu)
      values (new.id, new.geaendert_von, f, alt_wert, neu_wert);
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists leads_aenderung on public.leads;
create trigger leads_aenderung
  before update on public.leads
  for each row execute function public.log_lead_aenderung();

-- ================================================================= RLS

alter table public.profiles   enable row level security;
alter table public.einladungen enable row level security;
alter table public.listen     enable row level security;
alter table public.leads      enable row level security;
alter table public.aktivitaet enable row level security;

-- Zentrale Prüfung: ist der Anfragende ein aktiver Mitarbeiter?
create or replace function public.ist_mitarbeiter()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and aktiv
  );
$$;

create or replace function public.ist_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and aktiv and rolle = 'admin'
  );
$$;

-- profiles: jeder Mitarbeiter sieht das Team, aendern darf nur der Admin
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (public.ist_mitarbeiter());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_admin on public.profiles;
create policy profiles_admin on public.profiles
  for all using (public.ist_admin()) with check (public.ist_admin());

-- einladungen: nur Admins
drop policy if exists einladungen_admin on public.einladungen;
create policy einladungen_admin on public.einladungen
  for all using (public.ist_admin()) with check (public.ist_admin());

-- listen: alle lesen, Admin pflegt
drop policy if exists listen_select on public.listen;
create policy listen_select on public.listen
  for select using (public.ist_mitarbeiter());

drop policy if exists listen_admin on public.listen;
create policy listen_admin on public.listen
  for all using (public.ist_admin()) with check (public.ist_admin());

-- leads: jeder Mitarbeiter sieht und bearbeitet alles, loeschen nur Admin
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads
  for select using (public.ist_mitarbeiter());

drop policy if exists leads_insert on public.leads;
create policy leads_insert on public.leads
  for insert with check (public.ist_mitarbeiter());

drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads
  for update using (public.ist_mitarbeiter()) with check (public.ist_mitarbeiter());

drop policy if exists leads_delete on public.leads;
create policy leads_delete on public.leads
  for delete using (public.ist_admin());

-- aktivitaet: lesen ja, schreiben nur der Trigger
drop policy if exists aktivitaet_select on public.aktivitaet;
create policy aktivitaet_select on public.aktivitaet
  for select using (public.ist_mitarbeiter());

-- ============================================================ Realtime

-- Sorgt dafuer, dass Aenderungen sofort an alle offenen Browser gehen.
alter publication supabase_realtime add table public.leads;
alter table public.leads replica identity full;

-- ========================================================== Hilfssicht

-- "Faellig in (Tagen)" war im Sheet eine Formel. Hier als Sicht, weil der
-- Wert vom heutigen Datum abhaengt und deshalb nicht gespeichert werden darf.
create or replace view public.leads_ansicht as
select
  l.*,
  (l.wiedervorlage_am - current_date) as faellig_in_tagen,
  p.name as bearbeiter_name
from public.leads l
left join public.profiles p on p.id = l.bearbeiter;
