-- Menüverwaltung: gemeinsamer Menüplan und Gerichte-Sammlung für einen Haushalt.
-- Alle Objekte tragen das Präfix "menu_", damit sie sich nicht mit anderen
-- Tabellen im selben Supabase-Projekt vermischen.

create table public.menu_haushalte (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Unser Haushalt',
  beitrittscode text not null unique default upper(substr(md5(random()::text), 1, 6)),
  erstellt_am timestamptz not null default now()
);

create table public.menu_mitglieder (
  haushalt_id uuid not null references public.menu_haushalte(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  beigetreten_am timestamptz not null default now(),
  primary key (haushalt_id, user_id)
);
create index menu_mitglieder_user_idx on public.menu_mitglieder(user_id);

create table public.menu_kategorien (
  id uuid primary key default gen_random_uuid(),
  haushalt_id uuid not null references public.menu_haushalte(id) on delete cascade,
  name text not null,
  farbe text not null default '#888888',
  sortierung int not null default 0
);
create index menu_kategorien_haushalt_idx on public.menu_kategorien(haushalt_id);

create table public.menu_gerichte (
  id uuid primary key default gen_random_uuid(),
  haushalt_id uuid not null references public.menu_haushalte(id) on delete cascade,
  kategorie_id uuid references public.menu_kategorien(id) on delete set null,
  name text not null,
  notiz text,
  favorit boolean not null default false,
  erstellt_am timestamptz not null default now()
);
create index menu_gerichte_haushalt_idx on public.menu_gerichte(haushalt_id);
create index menu_gerichte_kategorie_idx on public.menu_gerichte(kategorie_id);

create table public.menu_plan (
  id uuid primary key default gen_random_uuid(),
  haushalt_id uuid not null references public.menu_haushalte(id) on delete cascade,
  datum date not null,
  gericht_id uuid references public.menu_gerichte(id) on delete set null,
  titel text not null,
  notiz text,
  erledigt boolean not null default false,
  erstellt_am timestamptz not null default now()
);
create index menu_plan_haushalt_datum_idx on public.menu_plan(haushalt_id, datum);
create index menu_plan_gericht_idx on public.menu_plan(gericht_id);

-- Hilfsfunktion für RLS
create or replace function public.menu_ist_mitglied(p_haushalt uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.menu_mitglieder m
    where m.haushalt_id = p_haushalt and m.user_id = (select auth.uid())
  );
$$;

alter table public.menu_haushalte enable row level security;
alter table public.menu_mitglieder enable row level security;
alter table public.menu_kategorien enable row level security;
alter table public.menu_gerichte enable row level security;
alter table public.menu_plan enable row level security;

create policy menu_haushalte_lesen on public.menu_haushalte
  for select to authenticated using (public.menu_ist_mitglied(id));
create policy menu_haushalte_aendern on public.menu_haushalte
  for update to authenticated using (public.menu_ist_mitglied(id)) with check (public.menu_ist_mitglied(id));

create policy menu_mitglieder_lesen on public.menu_mitglieder
  for select to authenticated using (public.menu_ist_mitglied(haushalt_id));
create policy menu_mitglieder_austreten on public.menu_mitglieder
  for delete to authenticated using (user_id = (select auth.uid()));

create policy menu_kategorien_alle on public.menu_kategorien
  for all to authenticated
  using (public.menu_ist_mitglied(haushalt_id)) with check (public.menu_ist_mitglied(haushalt_id));
create policy menu_gerichte_alle on public.menu_gerichte
  for all to authenticated
  using (public.menu_ist_mitglied(haushalt_id)) with check (public.menu_ist_mitglied(haushalt_id));
create policy menu_plan_alle on public.menu_plan
  for all to authenticated
  using (public.menu_ist_mitglied(haushalt_id)) with check (public.menu_ist_mitglied(haushalt_id));

-- Haushalt anlegen (optional mit den Einträgen aus den bisherigen Notizen)
create or replace function public.menu_haushalt_erstellen(p_name text, p_mit_startdaten boolean default true)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_hid uuid;
  v_kat uuid;
  v_gericht text;
  v_eintrag record;
  v_kategorien jsonb := '[
    {"name":"Teigwarengerichte","farbe":"#E0A800","gerichte":["Teigwarensalat (Pesto, Cherrytomaten, Mozzarella, Gurken)","Teigwarensalat (Essiggurken, Käse)","Spaghetti Carbonara","Spaghetti mit Crevetten","Spaghetti mit Crevetten (Pesto rosso + Mascarpone)","Lasagne","Hörnli mit Gehacktem","Chinakohlteigwaren (Speck, Frühlingszwiebeln)","Älplermakkronen","Onepot-Lasagne","Poulet-Champignons-Zucchetti Sauce"]},
    {"name":"Kartoffelgerichte","farbe":"#5CB85C","gerichte":["Kartoffelgratin","Kartoffel-Bohnen-Speck-Pfanne","Gemüsesuppe","Kartoffel-Tomaten-Hack-Gratin","Kartoffelsalat","Kartoffelstock","Kartoffeln überbacken mit Raclettkäse","Griechisches Omelett","Gemüse mit Hünchen (Kartoffeln, Lauch, Rüebli, Brokkoli, Zwiebeln)","Hackfleisch-Lauch-Pfanne mit Kartoffeln","Schweinsfilet mit Kohlrabi und Kartoffeln"]},
    {"name":"Reisgerichte","farbe":"#3A8FD9","gerichte":["Tomatenrisotto","Hack-Spinat-Risotto","Brokkoli-Schinken-Sauce","Curryreis","Paella","Gefüllte Zucchetti/Tomate","Mascarpone-Risotto mit Schinken"]},
    {"name":"Weitere","farbe":"#8E44D9","gerichte":["Spätzligratin","Thonsalat","Wienerli im Teig","Flammkuchen","Cervelatsalat","Hamburger","Hotdog","Fajitas","Partyfilet","Gnocchi-Spinat-Auflauf","Gnocchi-Brokkoli-Speckpfanne","Poulet-Geschnetzeltes mit Pilzen und Spätzli","Wraps"]},
    {"name":"Desserts","farbe":"#E04848","gerichte":["Schokoladenmousse","Heidelbeeren-Schoko-Muffin","Himbeerentiramisu"]}
  ]';
  v_k jsonb;
  v_i int := 0;
begin
  if v_uid is null then
    raise exception 'Nicht angemeldet';
  end if;

  insert into public.menu_haushalte(name) values (coalesce(nullif(trim(p_name), ''), 'Unser Haushalt'))
  returning id into v_hid;
  insert into public.menu_mitglieder(haushalt_id, user_id) values (v_hid, v_uid);

  for v_k in select * from jsonb_array_elements(v_kategorien) loop
    v_i := v_i + 1;
    insert into public.menu_kategorien(haushalt_id, name, farbe, sortierung)
    values (v_hid, v_k->>'name', v_k->>'farbe', v_i)
    returning id into v_kat;
    if p_mit_startdaten then
      for v_gericht in select jsonb_array_elements_text(v_k->'gerichte') loop
        insert into public.menu_gerichte(haushalt_id, kategorie_id, name) values (v_hid, v_kat, v_gericht);
      end loop;
    end if;
  end loop;

  if p_mit_startdaten then
    for v_eintrag in
      select * from (values
        (date '2026-08-27', 'Kartoffelschnitze mit Fleischkäse-Cordon-bleu'),
        (date '2026-08-28', 'Couscous-Hüttenkäsesalat'),
        (date '2026-08-29', 'Tomaten-Mozzarella-Salat mit Bratwurst (Zucchetti)'),
        (date '2026-08-30', 'Tomatenrisotto mit Würstli'),
        (date '2026-08-31', 'Spaghetti Königsart'),
        (date '2026-09-01', 'Curryreis mit Rüebli'),
        (date '2026-09-04', 'Feta-Zucchetti mit Bratwurst'),
        (date '2026-09-05', 'Fajitas'),
        (date '2026-09-06', 'Griechisches Omelett'),
        (date '2026-09-07', 'Reis mit Ei und Erbsli'),
        (date '2026-09-30', 'Reis-Schinken-Brokkolipfanne'),
        (date '2026-10-02', 'Hack-Spinat-Risotto'),
        (date '2026-10-03', 'Hotdog'),
        (date '2026-10-04', 'Kartoffeln und Fleisch vom Grill'),
        (date '2026-10-05', 'Gnocchi-Bohnen-Speckpfanne')
      ) as t(datum, titel)
    loop
      insert into public.menu_plan(haushalt_id, datum, titel, gericht_id, erledigt)
      values (
        v_hid, v_eintrag.datum, v_eintrag.titel,
        (select g.id from public.menu_gerichte g
          where g.haushalt_id = v_hid and lower(g.name) = lower(v_eintrag.titel) limit 1),
        v_eintrag.datum < current_date
      );
    end loop;
  end if;

  return v_hid;
end;
$$;

-- Mit dem Beitrittscode einem bestehenden Haushalt beitreten
create or replace function public.menu_haushalt_beitreten(p_code text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_hid uuid;
begin
  if v_uid is null then
    raise exception 'Nicht angemeldet';
  end if;
  select id into v_hid from public.menu_haushalte where beitrittscode = upper(trim(p_code));
  if v_hid is null then
    raise exception 'Ungültiger Code';
  end if;
  insert into public.menu_mitglieder(haushalt_id, user_id) values (v_hid, v_uid)
  on conflict do nothing;
  return v_hid;
end;
$$;

revoke execute on function public.menu_ist_mitglied(uuid) from public, anon;
revoke execute on function public.menu_haushalt_erstellen(text, boolean) from public, anon;
revoke execute on function public.menu_haushalt_beitreten(text) from public, anon;
grant execute on function public.menu_ist_mitglied(uuid) to authenticated;
grant execute on function public.menu_haushalt_erstellen(text, boolean) to authenticated;
grant execute on function public.menu_haushalt_beitreten(text) to authenticated;

-- Live-Synchronisation zwischen den Geräten
alter publication supabase_realtime add table public.menu_kategorien, public.menu_gerichte, public.menu_plan;
