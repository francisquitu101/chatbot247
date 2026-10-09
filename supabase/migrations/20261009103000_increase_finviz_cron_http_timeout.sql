select cron.alter_job(
  job_id := jobid,
  command := case
    when command like '%timeout_milliseconds := 60000%' then command
    else replace(
      command,
      'body := ''{}''::jsonb',
      'body := ''{}''::jsonb, timeout_milliseconds := 60000'
    )
  end
)
from cron.job
where jobname = 'finviz-watchlist-every-10-minutes';
