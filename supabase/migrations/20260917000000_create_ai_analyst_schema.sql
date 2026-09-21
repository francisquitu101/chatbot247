create extension if not exists "pgcrypto";

create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.analysts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  ticker text not null,
  company_name text,
  is_public boolean not null default false,
  status text not null default 'live',
  current_thesis text,
  current_fair_value numeric(12,4),
  previous_fair_value numeric(12,4),
  confidence integer not null default 0,
  last_processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, ticker)
);

create table if not exists public.analyst_tickers (
  id uuid primary key default gen_random_uuid(),
  analyst_id uuid not null references public.analysts(id) on delete cascade,
  ticker text not null,
  company_name text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (analyst_id, ticker)
);

create table if not exists public.analyst_state (
  id uuid primary key default gen_random_uuid(),
  analyst_id uuid not null references public.analysts(id) on delete cascade,
  status text not null default 'live',
  confidence integer not null default 0,
  current_thesis text,
  current_fair_value numeric(12,4),
  previous_fair_value numeric(12,4),
  last_processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.thesis_versions (
  id uuid primary key default gen_random_uuid(),
  analyst_id uuid not null references public.analysts(id) on delete cascade,
  version integer not null,
  summary text not null,
  bull_case text,
  base_case text,
  bear_case text,
  catalysts jsonb not null default '[]'::jsonb,
  risks jsonb not null default '[]'::jsonb,
  assumptions jsonb not null default '[]'::jsonb,
  confidence integer not null default 0,
  created_at timestamptz not null default now(),
  unique (analyst_id, version)
);

create table if not exists public.valuation_versions (
  id uuid primary key default gen_random_uuid(),
  analyst_id uuid not null references public.analysts(id) on delete cascade,
  date timestamptz not null default now(),
  reason text not null,
  evidence text,
  old_value numeric(12,4),
  new_value numeric(12,4),
  affected_assumptions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.decision_events (
  id uuid primary key default gen_random_uuid(),
  analyst_id uuid not null references public.analysts(id) on delete cascade,
  event text not null,
  evidence text,
  impact text,
  reasoning_summary text,
  affected_assumptions jsonb not null default '[]'::jsonb,
  old_value text,
  new_value text,
  source text,
  source_type text,
  timestamp timestamptz not null default now(),
  confidence integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.evidence_items (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  source_type text not null,
  source_url text,
  title text not null,
  published_at timestamptz,
  external_id text,
  raw_metadata jsonb not null default '{}'::jsonb,
  content_hash text,
  summary text,
  created_at timestamptz not null default now()
);

create table if not exists public.analyst_evidence (
  id uuid primary key default gen_random_uuid(),
  analyst_id uuid not null references public.analysts(id) on delete cascade,
  evidence_id uuid not null references public.evidence_items(id) on delete cascade,
  classification text,
  relevance_score integer default 0,
  created_at timestamptz not null default now(),
  unique (analyst_id, evidence_id)
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  analyst_id uuid not null references public.analysts(id) on delete cascade,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (user_id, analyst_id)
);

create table if not exists public.analyst_slots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_name text not null default 'free',
  allocated_slots integer not null default 1,
  used_slots integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_analysts_user_id on public.analysts(user_id);
create index if not exists idx_analysts_public on public.analysts(is_public);
create index if not exists idx_analyst_state_analyst_id on public.analyst_state(analyst_id);
create index if not exists idx_decision_events_analyst_timestamp on public.decision_events(analyst_id, timestamp desc);
create index if not exists idx_evidence_items_ticker on public.evidence_items(ticker);
create index if not exists idx_analyst_evidence_analyst_id on public.analyst_evidence(analyst_id);

alter table public.profiles enable row level security;
alter table public.analysts enable row level security;
alter table public.analyst_tickers enable row level security;
alter table public.analyst_state enable row level security;
alter table public.thesis_versions enable row level security;
alter table public.valuation_versions enable row level security;
alter table public.decision_events enable row level security;
alter table public.evidence_items enable row level security;
alter table public.analyst_evidence enable row level security;
alter table public.subscriptions enable row level security;
alter table public.analyst_slots enable row level security;

create policy "profiles_own_read_write" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "public_analysts_readable" on public.analysts
  for select using (is_public = true or auth.uid() = user_id);

create policy "analysts_own_manage" on public.analysts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "analyst_related_own_read" on public.analyst_tickers
  for select using (exists (select 1 from public.analysts a where a.id = analyst_id and (a.is_public = true or a.user_id = auth.uid())));

create policy "analyst_related_own_write" on public.analyst_tickers
  for all using (exists (select 1 from public.analysts a where a.id = analyst_id and a.user_id = auth.uid())) with check (exists (select 1 from public.analysts a where a.id = analyst_id and a.user_id = auth.uid()));

create policy "public_analyst_state_read" on public.analyst_state
  for select using (exists (select 1 from public.analysts a where a.id = analyst_id and (a.is_public = true or a.user_id = auth.uid())));

create policy "analyst_state_own_manage" on public.analyst_state
  for all using (exists (select 1 from public.analysts a where a.id = analyst_id and a.user_id = auth.uid())) with check (exists (select 1 from public.analysts a where a.id = analyst_id and a.user_id = auth.uid()));

create policy "public_thesis_versions_read" on public.thesis_versions
  for select using (exists (select 1 from public.analysts a where a.id = analyst_id and (a.is_public = true or a.user_id = auth.uid())));

create policy "thesis_versions_own_manage" on public.thesis_versions
  for all using (exists (select 1 from public.analysts a where a.id = analyst_id and a.user_id = auth.uid())) with check (exists (select 1 from public.analysts a where a.id = analyst_id and a.user_id = auth.uid()));

create policy "public_valuation_versions_read" on public.valuation_versions
  for select using (exists (select 1 from public.analysts a where a.id = analyst_id and (a.is_public = true or a.user_id = auth.uid())));

create policy "valuation_versions_own_manage" on public.valuation_versions
  for all using (exists (select 1 from public.analysts a where a.id = analyst_id and a.user_id = auth.uid())) with check (exists (select 1 from public.analysts a where a.id = analyst_id and a.user_id = auth.uid()));

create policy "public_decision_events_read" on public.decision_events
  for select using (exists (select 1 from public.analysts a where a.id = analyst_id and (a.is_public = true or a.user_id = auth.uid())));

create policy "decision_events_own_manage" on public.decision_events
  for all using (exists (select 1 from public.analysts a where a.id = analyst_id and a.user_id = auth.uid())) with check (exists (select 1 from public.analysts a where a.id = analyst_id and a.user_id = auth.uid()));

create policy "public_evidence_read" on public.evidence_items
  for select using (true);

create policy "evidence_manage" on public.evidence_items
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy "analyst_evidence_public_read" on public.analyst_evidence
  for select using (exists (select 1 from public.analysts a where a.id = analyst_id and (a.is_public = true or a.user_id = auth.uid())));

create policy "analyst_evidence_own_manage" on public.analyst_evidence
  for all using (exists (select 1 from public.analysts a where a.id = analyst_id and a.user_id = auth.uid())) with check (exists (select 1 from public.analysts a where a.id = analyst_id and a.user_id = auth.uid()));

create policy "subscriptions_own_read_write" on public.subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "slots_own_read_write" on public.analyst_slots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger set_public_profiles_updated_at
before update on public.profiles
for each row execute procedure public.update_updated_at_column();

create trigger set_public_analysts_updated_at
before update on public.analysts
for each row execute procedure public.update_updated_at_column();

create trigger set_public_analyst_state_updated_at
before update on public.analyst_state
for each row execute procedure public.update_updated_at_column();

create trigger set_public_analyst_slots_updated_at
before update on public.analyst_slots
for each row execute procedure public.update_updated_at_column();
