-- seed.sql
-- Purpose: Local development settings, loaded by `supabase db reset` (never on the remote).
-- Lets the job queue dispatch to the locally served Edge Functions: the database
-- container reaches the host's API gateway through host.docker.internal. The jobs secret
-- must match SUNNY_JOBS_SECRET in supabase/functions/.env.

select vault.create_secret('http://host.docker.internal:54321/functions/v1', 'sunny_functions_url');
select vault.create_secret('local-dev-jobs-secret', 'sunny_jobs_secret');
