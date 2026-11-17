-- BE1 / trusted DB administrator: DEVELOPMENT first, after reviewing and applying
-- migrations through 20261117040000. This file is NOT automatically deployed.
-- Requires Supabase pg_cron. Never expose cron or service_role credentials to FE.
begin;
do $$begin
 if not exists(select 1 from pg_extension where extname='pg_cron')then
  raise exception 'Enable pg_cron in the Supabase dashboard first';end if;
end;$$;
-- Remove only this exact HANDE-owned job name; reruns must not duplicate jobs.
select cron.unschedule(jobid)from cron.job where jobname='hande-close-due-votes';
select cron.schedule('hande-close-due-votes','* * * * *','select public.close_due_votes(100);');
commit;
