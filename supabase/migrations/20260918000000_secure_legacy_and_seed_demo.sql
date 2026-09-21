revoke all on table public.sources from anon, authenticated;
revoke all on table public.tracked_stocks from anon, authenticated;
revoke all on table public.scraped_items from anon, authenticated;

alter table public.sources enable row level security;
alter table public.tracked_stocks enable row level security;
alter table public.scraped_items enable row level security;

create unique index if not exists analyst_state_analyst_id_key
  on public.analyst_state (analyst_id);

drop policy if exists public_evidence_read on public.evidence_items;
create policy public_evidence_read
  on public.evidence_items
  for select
  using (exists (
    select 1
    from public.analyst_evidence ae
    join public.analysts a on a.id = ae.analyst_id
    where ae.evidence_id = evidence_items.id
      and (a.is_public = true or a.user_id = auth.uid())
  ));

do $$
declare
  demo_analyst_id uuid := '00000000-0000-4000-8000-000000000001';
  evidence_ids uuid[] := array[
    '00000000-0000-4000-8000-000000000101'::uuid,
    '00000000-0000-4000-8000-000000000102'::uuid,
    '00000000-0000-4000-8000-000000000103'::uuid,
    '00000000-0000-4000-8000-000000000104'::uuid,
    '00000000-0000-4000-8000-000000000105'::uuid
  ];
begin
  insert into public.analysts (
    id, user_id, name, ticker, company_name, is_public, status,
    current_thesis, current_fair_value, previous_fair_value, confidence, last_processed_at
  ) values (
    demo_analyst_id, null, 'Demo Research Analyst', 'NVDA', 'NVIDIA Corporation', true, 'live',
    'Demo seeded thesis: durable AI infrastructure demand supports continued earnings growth, with valuation sensitivity as the primary risk.',
    184.00, 171.50, 78, '2026-09-17T16:00:00Z'
  )
  on conflict (id) do update set
    name = excluded.name,
    ticker = excluded.ticker,
    company_name = excluded.company_name,
    is_public = excluded.is_public,
    status = excluded.status,
    current_thesis = excluded.current_thesis,
    current_fair_value = excluded.current_fair_value,
    previous_fair_value = excluded.previous_fair_value,
    confidence = excluded.confidence,
    last_processed_at = excluded.last_processed_at;

  insert into public.analyst_tickers (analyst_id, ticker, company_name, is_primary)
  values (demo_analyst_id, 'NVDA', 'NVIDIA Corporation', true)
  on conflict (analyst_id, ticker) do update set
    company_name = excluded.company_name,
    is_primary = excluded.is_primary;

  insert into public.analyst_state (
    analyst_id, status, confidence, current_thesis, current_fair_value, previous_fair_value, last_processed_at
  ) values (
    demo_analyst_id, 'live', 78,
    'Demo seeded thesis: durable AI infrastructure demand supports continued earnings growth, with valuation sensitivity as the primary risk.',
    184.00, 171.50, '2026-09-17T16:00:00Z'
  )
  on conflict (analyst_id) do update set
    status = excluded.status,
    confidence = excluded.confidence,
    current_thesis = excluded.current_thesis,
    current_fair_value = excluded.current_fair_value,
    previous_fair_value = excluded.previous_fair_value,
    last_processed_at = excluded.last_processed_at;

  insert into public.thesis_versions (
    analyst_id, version, summary, bull_case, base_case, bear_case, catalysts, risks, assumptions, confidence, created_at
  ) values
    (demo_analyst_id, 1, '[DEMO SEEDED] Initial infrastructure thesis.', 'AI compute demand compounds above expectations.', 'Demand remains strong while supply normalizes.', 'Cloud spending slows and competition compresses margins.', '["[DEMO SEEDED] Data center demand"]', '["[DEMO SEEDED] Valuation premium"]', '["[DEMO SEEDED] Continued hyperscaler investment"]', 68, '2026-08-20T12:00:00Z'),
    (demo_analyst_id, 2, '[DEMO SEEDED] Evidence strengthened the growth case.', 'Accelerating platform adoption expands the opportunity.', 'Execution remains on plan with measured margin expansion.', 'Product cycle timing or export limits reduce growth.', '["[DEMO SEEDED] Platform adoption", "[DEMO SEEDED] Software attach"]', '["[DEMO SEEDED] Concentrated customer base"]', '["[DEMO SEEDED] Stable gross margin"]', 73, '2026-09-03T12:00:00Z'),
    (demo_analyst_id, 3, '[DEMO SEEDED] Current thesis: growth remains durable, valuation is the key constraint.', 'Sustained demand supports upside to estimates.', 'Strong demand supports the current fair value.', 'Multiple compression limits upside despite execution.', '["[DEMO SEEDED] New product cycle", "[DEMO SEEDED] AI infrastructure backlog"]', '["[DEMO SEEDED] Valuation sensitivity", "[DEMO SEEDED] Geopolitical exposure"]', '["[DEMO SEEDED] Backlog converts on schedule"]', 78, '2026-09-17T16:00:00Z')
  on conflict (analyst_id, version) do update set
    summary = excluded.summary,
    bull_case = excluded.bull_case,
    base_case = excluded.base_case,
    bear_case = excluded.bear_case,
    catalysts = excluded.catalysts,
    risks = excluded.risks,
    assumptions = excluded.assumptions,
    confidence = excluded.confidence,
    created_at = excluded.created_at;

  insert into public.valuation_versions (
    analyst_id, date, reason, evidence, old_value, new_value, affected_assumptions, created_at
  ) values
    (demo_analyst_id, '2026-08-20T12:00:00Z', '[DEMO SEEDED] Initial scenario calibration.', '[DEMO SEEDED] Baseline scenario for the public demo.', null, 150.00, '["[DEMO SEEDED] Revenue growth"]', '2026-08-20T12:00:00Z'),
    (demo_analyst_id, '2026-09-03T12:00:00Z', '[DEMO SEEDED] Raised fair value after thesis update.', '[DEMO SEEDED] Platform adoption assumption improved.', 150.00, 171.50, '["[DEMO SEEDED] Platform adoption"]', '2026-09-03T12:00:00Z'),
    (demo_analyst_id, '2026-09-17T16:00:00Z', '[DEMO SEEDED] Updated fair value after evidence review.', '[DEMO SEEDED] Backlog and product-cycle assumptions remain supportive.', 171.50, 184.00, '["[DEMO SEEDED] Backlog conversion"]', '2026-09-17T16:00:00Z');

  insert into public.decision_events (
    analyst_id, event, evidence, impact, reasoning_summary, affected_assumptions,
    old_value, new_value, source, source_type, timestamp, confidence, created_at
  ) values
    (demo_analyst_id, '[DEMO SEEDED] Established initial thesis', '[DEMO SEEDED] Initial research baseline.', 'Positive', 'Created the initial public demo thesis and scenario set.', '["[DEMO SEEDED] Revenue growth"]', null, '150.00', 'Demo seed', 'demo_seed', '2026-08-20T12:00:00Z', 68, '2026-08-20T12:00:00Z'),
    (demo_analyst_id, '[DEMO SEEDED] Increased confidence in demand', '[DEMO SEEDED] Evidence item 1.', 'Positive', 'Demand indicators supported the platform adoption assumption.', '["[DEMO SEEDED] Platform adoption"]', '68', '73', 'Demo seed', 'demo_seed', '2026-08-27T12:00:00Z', 71, '2026-08-27T12:00:00Z'),
    (demo_analyst_id, '[DEMO SEEDED] Revised fair value upward', '[DEMO SEEDED] Evidence item 2.', 'Positive', 'Raised fair value after updating the growth scenario.', '["[DEMO SEEDED] Growth scenario"]', '150.00', '171.50', 'Demo seed', 'demo_seed', '2026-09-03T12:00:00Z', 73, '2026-09-03T12:00:00Z'),
    (demo_analyst_id, '[DEMO SEEDED] Added valuation risk', '[DEMO SEEDED] Evidence item 3.', 'Neutral', 'Kept the thesis intact while recording valuation sensitivity.', '["[DEMO SEEDED] Valuation premium"]', 'Positive', 'Neutral', 'Demo seed', 'demo_seed', '2026-09-10T12:00:00Z', 75, '2026-09-10T12:00:00Z'),
    (demo_analyst_id, '[DEMO SEEDED] Confirmed current thesis', '[DEMO SEEDED] Evidence item 4.', 'Positive', 'Maintained the thesis after reviewing backlog and product-cycle assumptions.', '["[DEMO SEEDED] Backlog conversion"]', '171.50', '184.00', 'Demo seed', 'demo_seed', '2026-09-17T16:00:00Z', 78, '2026-09-17T16:00:00Z');

  insert into public.evidence_items (
    id, ticker, source_type, source_url, title, published_at, external_id, raw_metadata, summary, content_hash, created_at
  ) values
    (evidence_ids[1], 'NVDA', 'demo_seed', 'https://example.com/demo/nvda-demand', '[DEMO SEEDED] AI infrastructure demand review', '2026-08-22T12:00:00Z', 'demo-nvda-001', '{"is_demo": true, "origin": "seeded_data"}', '[DEMO SEEDED] Baseline demand evidence for the public analyst demo.', 'demo-seed-nvda-001', '2026-08-22T12:00:00Z'),
    (evidence_ids[2], 'NVDA', 'demo_seed', 'https://example.com/demo/nvda-platform', '[DEMO SEEDED] Platform adoption review', '2026-08-29T12:00:00Z', 'demo-nvda-002', '{"is_demo": true, "origin": "seeded_data"}', '[DEMO SEEDED] Platform adoption evidence for the public analyst demo.', 'demo-seed-nvda-002', '2026-08-29T12:00:00Z'),
    (evidence_ids[3], 'NVDA', 'demo_seed', 'https://example.com/demo/nvda-valuation', '[DEMO SEEDED] Valuation sensitivity review', '2026-09-05T12:00:00Z', 'demo-nvda-003', '{"is_demo": true, "origin": "seeded_data"}', '[DEMO SEEDED] Valuation risk evidence for the public analyst demo.', 'demo-seed-nvda-003', '2026-09-05T12:00:00Z'),
    (evidence_ids[4], 'NVDA', 'demo_seed', 'https://example.com/demo/nvda-backlog', '[DEMO SEEDED] Backlog conversion review', '2026-09-12T12:00:00Z', 'demo-nvda-004', '{"is_demo": true, "origin": "seeded_data"}', '[DEMO SEEDED] Backlog evidence for the public analyst demo.', 'demo-seed-nvda-004', '2026-09-12T12:00:00Z'),
    (evidence_ids[5], 'NVDA', 'demo_seed', 'https://example.com/demo/nvda-thesis', '[DEMO SEEDED] Current thesis review', '2026-09-17T12:00:00Z', 'demo-nvda-005', '{"is_demo": true, "origin": "seeded_data"}', '[DEMO SEEDED] Current thesis evidence for the public analyst demo.', 'demo-seed-nvda-005', '2026-09-17T12:00:00Z')
  on conflict (id) do update set
    ticker = excluded.ticker,
    source_type = excluded.source_type,
    source_url = excluded.source_url,
    title = excluded.title,
    published_at = excluded.published_at,
    external_id = excluded.external_id,
    raw_metadata = excluded.raw_metadata,
    summary = excluded.summary,
    content_hash = excluded.content_hash,
    created_at = excluded.created_at;

  insert into public.analyst_evidence (analyst_id, evidence_id, classification, relevance_score)
  select demo_analyst_id, evidence_id, 'demo_seed', 90
  from unnest(evidence_ids) as evidence_id
  on conflict (analyst_id, evidence_id) do update set
    classification = excluded.classification,
    relevance_score = excluded.relevance_score;
end
$$;
