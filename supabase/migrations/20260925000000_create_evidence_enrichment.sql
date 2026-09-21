create table public.evidence_enrichment (
  id uuid primary key default gen_random_uuid(),
  evidence_id uuid not null references public.evidence_items(id) on delete cascade,
  extraction_version text not null,
  content_status text not null default 'pending' check (content_status in ('pending', 'processing', 'completed', 'partial', 'failed')),
  normalized_summary text,
  sections jsonb not null default '[]'::jsonb,
  structured_facts jsonb not null default '[]'::jsonb,
  source_document_hash text,
  retrieval_ms integer,
  document_bytes integer,
  sections_count integer not null default 0,
  facts_count integer not null default 0,
  extracted_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (evidence_id, extraction_version)
);

create index evidence_enrichment_evidence_idx
  on public.evidence_enrichment (evidence_id, created_at desc);

alter table public.evidence_enrichment enable row level security;

create policy evidence_enrichment_owner_read on public.evidence_enrichment
  for select using (exists (
    select 1
    from public.analyst_evidence ae
    join public.analysts a on a.id = ae.analyst_id
    where ae.evidence_id = evidence_enrichment.evidence_id
      and (a.user_id = auth.uid() or a.is_public = true)
  ));
