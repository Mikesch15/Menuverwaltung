-- Ausbau: Abteilungen/Vorrat, Kochzeit/Portionen/Rezept/Bild, Wer kocht, Reste, Bewertung,
-- Bilder-Speicher und Push-Erinnerungen.

-- Gerichte
alter table public.menu_gerichte
  add column kochzeit int check (kochzeit is null or kochzeit between 1 and 1440),
  add column portionen int not null default 2 check (portionen between 1 and 50),
  add column rezept text,
  add column quelle_url text,
  add column bild_pfad text,
  add column bild_url text;

-- Menüplan
alter table public.menu_plan
  add column koch_user uuid references auth.users(id) on delete set null,
  add column reste boolean not null default false,
  add column portionen int check (portionen is null or portionen between 1 and 50),
  add column bewertung smallint check (bewertung is null or bewertung in (-1, 1));
create index menu_plan_koch_idx on public.menu_plan(koch_user);

-- Anzeigename der Mitglieder (für «Wer kocht?»)
alter table public.menu_mitglieder add column anzeigename text;
create policy menu_mitglieder_name on public.menu_mitglieder
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Artikel-Katalog: gelernte Abteilung und «haben wir immer»-Vorrat pro Artikelname
create table public.menu_artikel (
  haushalt_id uuid not null references public.menu_haushalte(id) on delete cascade,
  name_norm text not null,
  name text not null,
  abteilung text,
  vorrat boolean not null default false,
  geaendert_am timestamptz not null default now(),
  primary key (haushalt_id, name_norm)
);
alter table public.menu_artikel enable row level security;
create policy menu_artikel_alle on public.menu_artikel
  for all to authenticated
  using (public.menu_ist_mitglied(haushalt_id)) with check (public.menu_ist_mitglied(haushalt_id));

alter publication supabase_realtime add table public.menu_artikel, public.menu_mitglieder;

-- Bilder der Gerichte: privater Bucket, Pfad «<haushalt_id>/<datei>»
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-bilder', 'menu-bilder', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create or replace function public.menu_bild_erlaubt(p_name text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  return public.menu_ist_mitglied(((storage.foldername(p_name))[1])::uuid);
exception when others then
  return false;
end;
$$;
revoke execute on function public.menu_bild_erlaubt(text) from public, anon;
grant execute on function public.menu_bild_erlaubt(text) to authenticated;

create policy menu_bilder_lesen on storage.objects for select to authenticated
  using (bucket_id = 'menu-bilder' and public.menu_bild_erlaubt(name));
create policy menu_bilder_hochladen on storage.objects for insert to authenticated
  with check (bucket_id = 'menu-bilder' and public.menu_bild_erlaubt(name));
create policy menu_bilder_aendern on storage.objects for update to authenticated
  using (bucket_id = 'menu-bilder' and public.menu_bild_erlaubt(name));
create policy menu_bilder_loeschen on storage.objects for delete to authenticated
  using (bucket_id = 'menu-bilder' and public.menu_bild_erlaubt(name));

-- Push-Erinnerungen
create table public.menu_push_abos (
  id uuid primary key default gen_random_uuid(),
  haushalt_id uuid not null references public.menu_haushalte(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  stunde int not null default 16 check (stunde between 0 and 23),
  taeglich boolean not null default true,
  wochenplan boolean not null default true,
  erstellt_am timestamptz not null default now()
);
create index menu_push_abos_haushalt_idx on public.menu_push_abos(haushalt_id);
create index menu_push_abos_user_idx on public.menu_push_abos(user_id);
alter table public.menu_push_abos enable row level security;
create policy menu_push_abos_eigene on public.menu_push_abos
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.menu_ist_mitglied(haushalt_id));

-- Schlüssel für Web-Push und Cron (nur für den Service-Role-Zugriff der Edge Function lesbar;
-- keine Policies => für angemeldete Nutzer unsichtbar). Die Edge Function «menu-erinnerung»
-- erzeugt die Schlüssel beim ersten Aufruf selbst, der private Schlüssel verlässt den Server nie.
create table public.menu_push_config (
  id int primary key default 1 check (id = 1),
  vapid_public text not null,
  vapid_private text not null,
  vapid_subject text not null,
  cron_secret text not null default gen_random_uuid()::text
);
alter table public.menu_push_config enable row level security;
