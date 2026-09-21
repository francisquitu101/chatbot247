BEGIN;

UPDATE public.analyst_state AS s
SET processing_status = 'idle',
    updated_at = NOW()
WHERE s.analyst_id = (
    SELECT a.id
    FROM public.analysts AS a
    WHERE a.ticker = 'NVDA'
    LIMIT 1
)
AND s.processing_status = 'analyzing'
AND NOT EXISTS (
    SELECT 1
    FROM public.analyst_runs AS r
    WHERE r.analyst_id = s.analyst_id
      AND r.status = 'started'
)
AND NOT EXISTS (
    SELECT 1
    FROM public.analyst_jobs AS j
    WHERE j.analyst_id = s.analyst_id
      AND j.status = 'processing'
);

DO $$
DECLARE
  demo_analyst_id uuid;
  demo_evidence_ids uuid[];
BEGIN
  SELECT a.id INTO demo_analyst_id
  FROM public.analysts AS a
  WHERE a.ticker = 'NVDA'
  LIMIT 1;

  SELECT array_agg(e.id) INTO demo_evidence_ids
  FROM public.evidence_items AS e
  WHERE e.ticker = 'NVDA'
    AND e.source_type = 'demo_seed';

  IF demo_analyst_id IS NOT NULL AND demo_evidence_ids IS NOT NULL AND array_length(demo_evidence_ids, 1) > 0 THEN
    DELETE FROM public.analyst_jobs
    WHERE analyst_id = demo_analyst_id
      AND evidence_id = ANY(demo_evidence_ids);

    DELETE FROM public.analyst_runs
    WHERE analyst_id = demo_analyst_id
      AND evidence_id = ANY(demo_evidence_ids);

    DELETE FROM public.analyst_evidence
    WHERE analyst_id = demo_analyst_id
      AND evidence_id = ANY(demo_evidence_ids);

    DELETE FROM public.decision_events
    WHERE analyst_id = demo_analyst_id
      AND event LIKE '%[DEMO SEEDED]%';

    DELETE FROM public.thesis_versions
    WHERE analyst_id = demo_analyst_id
      AND summary LIKE '%[DEMO SEEDED]%';

    DELETE FROM public.valuation_versions
    WHERE analyst_id = demo_analyst_id
      AND reason LIKE '%[DEMO SEEDED]%';

    DELETE FROM public.evidence_items
    WHERE ticker = 'NVDA'
      AND source_type = 'demo_seed'
      AND id = ANY(demo_evidence_ids);
  END IF;
END $$;

COMMIT;
