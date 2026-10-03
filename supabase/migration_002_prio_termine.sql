-- just-review · Erweiterung 002
-- Priorität an den Leads, Termine, Löschrecht für alle Mitarbeiter.
-- Einmalig im Supabase SQL Editor ausführen. Wiederholbar.

-- ========================================================== Priorität

alter table public.leads
  add column if not exists prioritaet smallint;

do $$
begin
  alter table public.leads
    add constraint leads_prioritaet_bereich check (prioritaet between 1 and 3);
exception
  when duplicate_object then null;   -- schon vorhanden
end $$;

comment on column public.leads.prioritaet is
  '1 = hoch, 2 = mittel, 3 = niedrig, leer = nicht priorisiert. Für alle sichtbar.';

create index if not exists leads_prioritaet_idx
  on public.leads (prioritaet) where prioritaet is not null;

-- Die Sicht muss neu gebaut werden: "l.*" wird beim Anlegen ausgeschrieben,
-- eine neue Spalte taucht darin sonst nie auf.
drop view if exists public.leads_ansicht;
create view public.leads_ansicht
with (security_invoker = true) as
select
  l.*,
  (l.wiedervorlage_am - current_date) as faellig_in_tagen,
  p.name as bearbeiter_name
from public.leads l
left join public.profiles p on p.id = l.bearbeiter;

-- Priorität soll im Verlauf mitgeschrieben werden wie die anderen Felder.
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
    'angebotswert','abschluss_wahrsch','notizen','bearbeiter','place_id','bewertungslink',
    'prioritaet'
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

-- ============================================================= Termine

create table if not exists public.termine (
  id          uuid primary key default gen_random_uuid(),
  titel       text not null default '',
  beginn      timestamptz not null,
  dauer_min   integer not null default 60,
  ort         text not null default '',
  notiz       text not null default '',
  -- Optional: ein Termin kann an einem Betrieb hängen oder frei stehen.
  -- Wird der Lead gelöscht, bleibt der Termin bestehen.
  lead_id     uuid references public.leads(id) on delete set null,
  benutzer    uuid not null references public.profiles(id) on delete cascade,
  erstellt_am timestamptz not null default now(),
  geaendert_am timestamptz not null default now()
);

comment on table public.termine is
  'Termine des Teams. Alle sehen alles, ändern darf jeder nur seine eigenen.';

create index if not exists termine_beginn_idx   on public.termine (beginn);
create index if not exists termine_benutzer_idx on public.termine (benutzer);
create index if not exists termine_lead_idx     on public.termine (lead_id);

alter table public.termine enable row level security;

drop policy if exists termine_select on public.termine;
create policy termine_select on public.termine
  for select using (public.ist_mitarbeiter());

drop policy if exists termine_insert on public.termine;
create policy termine_insert on public.termine
  for insert with check (public.ist_mitarbeiter() and benutzer = auth.uid());

drop policy if exists termine_update on public.termine;
create policy termine_update on public.termine
  for update using (benutzer = auth.uid() or public.ist_admin())
  with check (benutzer = auth.uid() or public.ist_admin());

drop policy if exists termine_delete on public.termine;
create policy termine_delete on public.termine
  for delete using (benutzer = auth.uid() or public.ist_admin());

create or replace function public.termin_geaendert()
returns trigger language plpgsql as $$
begin
  new.geaendert_am := now();
  return new;
end $$;

drop trigger if exists termine_geaendert on public.termine;
create trigger termine_geaendert
  before update on public.termine
  for each row execute function public.termin_geaendert();

-- Sicht mit dem Namen des Betriebs, damit die Liste ihn ohne zweite Abfrage hat.
drop view if exists public.termine_ansicht;
create view public.termine_ansicht
with (security_invoker = true) as
select
  t.*,
  l.firmenname as lead_name,
  l.strasse    as lead_strasse,
  l.ort        as lead_ort,
  l.telefon    as lead_telefon,
  p.name       as benutzer_name
from public.termine t
left join public.leads l    on l.id = t.lead_id
left join public.profiles p on p.id = t.benutzer;

-- ============================================== Löschen für alle Mitarbeiter

-- Vorher nur Admins. Achtung: Ein gelöschter Lead nimmt seinen Verlauf mit
-- (aktivitaet haengt per ON DELETE CASCADE daran).
drop policy if exists leads_delete on public.leads;
create policy leads_delete on public.leads
  for delete using (public.ist_mitarbeiter());

-- ================================================== Status und Echtzeit

insert into public.listen (kategorie, wert, sortierung) values
  ('status', 'Nicht relevant', 10)
on conflict (kategorie, wert) do nothing;

do $$
begin
  alter publication supabase_realtime add table public.termine;
exception
  when duplicate_object then null;   -- schon in der Publikation
end $$;

alter table public.termine replica identity full;
