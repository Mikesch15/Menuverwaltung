-- Wochenende / unter der Woche pro Gericht, Zutatenliste pro Gericht und gemeinsamer Warenkorb.

alter table public.menu_gerichte
  add column wann text not null default 'immer'
  check (wann in ('immer', 'woche', 'wochenende'));

create table public.menu_zutaten (
  id uuid primary key default gen_random_uuid(),
  haushalt_id uuid not null references public.menu_haushalte(id) on delete cascade,
  gericht_id uuid not null references public.menu_gerichte(id) on delete cascade,
  name text not null,
  menge text,
  sortierung int not null default 0,
  erstellt_am timestamptz not null default now()
);
create index menu_zutaten_haushalt_idx on public.menu_zutaten(haushalt_id);
create index menu_zutaten_gericht_idx on public.menu_zutaten(gericht_id);

create table public.menu_einkauf (
  id uuid primary key default gen_random_uuid(),
  haushalt_id uuid not null references public.menu_haushalte(id) on delete cascade,
  name text not null,
  menge text,
  plan_id uuid references public.menu_plan(id) on delete set null,
  quelle text,
  erledigt boolean not null default false,
  erstellt_am timestamptz not null default now()
);
create index menu_einkauf_haushalt_idx on public.menu_einkauf(haushalt_id);
create index menu_einkauf_plan_idx on public.menu_einkauf(plan_id);

alter table public.menu_zutaten enable row level security;
alter table public.menu_einkauf enable row level security;

create policy menu_zutaten_alle on public.menu_zutaten
  for all to authenticated
  using (public.menu_ist_mitglied(haushalt_id)) with check (public.menu_ist_mitglied(haushalt_id));
create policy menu_einkauf_alle on public.menu_einkauf
  for all to authenticated
  using (public.menu_ist_mitglied(haushalt_id)) with check (public.menu_ist_mitglied(haushalt_id));

alter publication supabase_realtime add table public.menu_zutaten, public.menu_einkauf;
