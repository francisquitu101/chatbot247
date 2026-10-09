create or replace function public.get_public_finviz_news(p_ticker text)
returns table (
  id uuid,
  ticker text,
  title text,
  author text,
  url text,
  published_at timestamptz,
  scraped_at timestamptz,
  metadata jsonb,
  item_type text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    items.id,
    items.ticker,
    items.title,
    items.author,
    items.url,
    items.published_at,
    items.scraped_at,
    items.metadata,
    items.item_type
  from public.scraped_items as items
  where items.ticker = upper(btrim(p_ticker))
    and items.item_type = 'news'
    and items.metadata->>'extractor' in (
      'finviz-news-table',
      'yahoo_finance_rss',
      'bing_news_rss',
      'google_news_rss'
    )
    and exists (
      select 1
      from public.analysts
      where analysts.ticker = items.ticker
        and analysts.is_public = true
    )
  order by items.published_at desc nulls last, items.scraped_at desc
  limit 50;
$$;

revoke all on function public.get_public_finviz_news(text) from public;
grant execute on function public.get_public_finviz_news(text) to anon, authenticated;
