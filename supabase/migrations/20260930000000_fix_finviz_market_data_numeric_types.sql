alter table public.finviz_market_data
  alter column volume type numeric using volume::numeric,
  alter column avg_volume type numeric using avg_volume::numeric,
  alter column market_cap type numeric using market_cap::numeric;
