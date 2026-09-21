insert into public.analyst_evidence (analyst_id, evidence_id, classification, relevance_score)
select a.id, e.id, 'sec_ingestion', 50
from public.analysts a
join public.evidence_items e on e.ticker = a.ticker and e.source_type = 'SEC'
where a.status <> 'inactive'
on conflict (analyst_id, evidence_id) do nothing;
