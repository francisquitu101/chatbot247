alter table public.analyst_runs
  add column if not exists input_tokens integer,
  add column if not exists output_tokens integer,
  add column if not exists response_id text,
  add column if not exists latency_ms integer;
