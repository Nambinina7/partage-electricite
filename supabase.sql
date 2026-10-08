-- À exécuter une fois dans Supabase → SQL Editor → New query → Run

create table if not exists public.mois (
  id          text primary key,              -- ex. "2026-09"
  data        jsonb not null,                -- relevés, facture, ajustements, paiements
  updated_at  timestamptz not null default now()
);

-- Sécurité : accès lecture/écriture pour l'application (clé publique "anon")
alter table public.mois enable row level security;

drop policy if exists "app partage electricite" on public.mois;
create policy "app partage electricite" on public.mois
  for all to anon, authenticated
  using (true) with check (true);

-- Mises à jour en direct entre les utilisateurs
alter publication supabase_realtime add table public.mois;
