-- 20261027000200_jobs.sql
-- Purpose: The background job queue (see notes/AGENT_RUNTIME.md). A job is a row in
-- public.jobs; running it is a short call to the jobs-run Edge Function.
--   * private.enqueue_job queues work, merging repeats through dedupe_key.
--   * Inserting a due job dispatches it to jobs-run through pg_net (after commit). The
--     function URL and shared secret come from Vault ('sunny_functions_url',
--     'sunny_jobs_secret'); without them dispatch is skipped and only the sweep runs.
--   * jobs-run claims with claim_job (skip locked, leased), saves progress with
--     checkpoint_job, and finishes with complete_job, defer_job (checkpoint + wake
--     time) or fail_job (backoff retry; lease expiry in the sweep counts the same way).
--   * jobs_sweep (pg_cron, every minute) expires leases, wakes waiting jobs and
--     re-dispatches due ones. households.background_paused stops all claims.
--   * request_agent_chat lets a caregiver queue a message to the agent; caregivers who can
--     edit read the reply from their household's jobs rows.
--   * A job returning to the queue never collides with a newer queued job for the same
--     dedupe key: it is marked superseded instead (the newer one re-reads current data).
--     Jobs sharing a dedupe key never run at the same time.
--   * The private helpers here are backend-only and not executable by API roles.

create extension if not exists pg_net with schema extensions;

create type public.job_kind as enum ('agent_chat', 'calendar_sync_event');
create type public.job_status as enum (
  'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'
);

-- Caregiver "stop": no background job for the household is claimed while true.
alter table public.households add column background_paused boolean not null default false;

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  kind public.job_kind not null,
  payload jsonb not null default '{}',
  status public.job_status not null default 'queued',
  run_after timestamptz not null default now(),
  -- Failed attempts so far (lease expiry counts as one); claims do not count.
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  lease_until timestamptz,
  -- At most one queued job per key, e.g. one pending push per event and calendar.
  dedupe_key text,
  requested_by uuid references auth.users (id) on delete set null,
  -- Executor state needed to resume without a live process (e.g. the agent session id).
  checkpoint jsonb not null default '{}',
  result jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create unique index jobs_dedupe_idx on public.jobs (dedupe_key) where status = 'queued';
create index jobs_due_idx on public.jobs (run_after) where status in ('queued', 'waiting');
create index jobs_running_idx on public.jobs (lease_until) where status = 'running';
create index jobs_household_idx on public.jobs (household_id, created_at desc);
create index jobs_requested_by_idx on public.jobs (requested_by);

create trigger jobs_updated_at before update on public.jobs
  for each row execute function private.set_updated_at();

alter table public.jobs enable row level security;

-- Caregivers who can edit read their household's jobs (how a client reads an agent
-- reply; viewers cannot message the agent). Only the backend writes.
create policy jobs_select_editor on public.jobs for select to authenticated
  using (private.can_edit(household_id));

-- ---------------------------------------------------------------------------
-- Dispatch
-- ---------------------------------------------------------------------------

-- Raise unless the caller is the backend (service role, pg_cron, migrations, tests).
create or replace function private.assert_backend()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not private.is_backend() then
    raise exception 'Backend only' using errcode = '42501';
  end if;
end;
$$;

-- A Vault secret by name, or null when it is not set.
create or replace function private.vault_secret(p_name text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1
$$;

-- Ask jobs-run to run each job (fire and forget through pg_net, sent after commit).
-- Returns how many requests were queued; 0 when dispatch is not configured.
create or replace function private.dispatch_jobs(p_job_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := private.vault_secret('sunny_functions_url');
  v_secret text := private.vault_secret('sunny_jobs_secret');
  v_id uuid;
  v_count integer := 0;
begin
  if v_url is null or v_secret is null then
    return 0;
  end if;
  foreach v_id in array coalesce(p_job_ids, '{}') loop
    perform net.http_post(
      url := rtrim(v_url, '/') || '/jobs-run',
      body := jsonb_build_object('job_id', v_id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sunny-jobs-secret', v_secret
      )
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Dispatch the due jobs an INSERT statement created, in one pass. At most 20 go out at
-- once (connecting a calendar queues a push per event); the sweep sends the rest.
create or replace function private.dispatch_new_jobs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.dispatch_jobs(array(
    select id from new_jobs where status = 'queued' and run_after <= now() order by run_after limit 20
  ));
  return null;
end;
$$;

create trigger jobs_dispatch_new after insert on public.jobs
  referencing new table as new_jobs
  for each statement execute function private.dispatch_new_jobs();

-- Queue a job. With a dedupe key that already has a queued job, that job is reused: it
-- takes the new payload and the earlier run time. Returns the job id.
create or replace function private.enqueue_job(
  p_household_id uuid,
  p_kind public.job_kind,
  p_payload jsonb default '{}',
  p_dedupe_key text default null,
  p_run_after timestamptz default now(),
  p_requested_by uuid default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into public.jobs (household_id, kind, payload, dedupe_key, run_after, requested_by)
  values (p_household_id, p_kind, p_payload, p_dedupe_key, p_run_after, p_requested_by)
  on conflict (dedupe_key) where status = 'queued'
  do update set payload = excluded.payload,
                run_after = least(public.jobs.run_after, excluded.run_after)
  returning id
$$;

-- ---------------------------------------------------------------------------
-- Worker RPCs (backend only)
-- ---------------------------------------------------------------------------

-- Claim one due queued job (the given one, or the oldest due) for p_lease_seconds.
-- Returns no row when there is nothing to claim: already taken, not due, the household
-- paused background work, or another job with the same dedupe key is still running (it
-- is claimed on a later dispatch, after that one finishes).
create or replace function public.claim_job(
  p_job_id uuid default null,
  p_lease_seconds integer default 300,
  p_now timestamptz default now()
)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_backend();
  return query
  update public.jobs j
  set status = 'running', lease_until = p_now + make_interval(secs => p_lease_seconds)
  where j.id = (
    select c.id
    from public.jobs c
    join public.households h on h.id = c.household_id
    where (p_job_id is null or c.id = p_job_id)
      and c.status = 'queued'
      and c.run_after <= p_now
      and not h.background_paused
      and not (c.dedupe_key is not null and exists (
        select 1 from public.jobs r where r.dedupe_key = c.dedupe_key and r.status = 'running'
      ))
    order by c.run_after
    limit 1
    for update of c skip locked
  )
  returning j.*;
end;
$$;

-- Lock a running job for its finishing call, or raise.
create or replace function private.running_job(p_job_id uuid)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs;
begin
  perform private.assert_backend();
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or v_job.status <> 'running' then
    raise exception 'Job % is not running', p_job_id using errcode = 'P0002';
  end if;
  return v_job;
end;
$$;

-- Save a running job's progress (merged into its checkpoint) and extend its lease, so a
-- resume after a crash continues from here. Raises if the job is no longer running.
create or replace function public.checkpoint_job(
  p_job_id uuid,
  p_checkpoint jsonb,
  p_lease_seconds integer default 300,
  p_now timestamptz default now()
)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs := private.running_job(p_job_id);
begin
  update public.jobs
  set checkpoint = checkpoint || coalesce(p_checkpoint, '{}'),
      lease_until = p_now + make_interval(secs => p_lease_seconds)
  where id = v_job.id
  returning * into v_job;
  return v_job;
end;
$$;

-- Finish a job successfully.
create or replace function public.complete_job(
  p_job_id uuid,
  p_result jsonb default null,
  p_now timestamptz default now()
)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs := private.running_job(p_job_id);
begin
  update public.jobs
  set status = 'succeeded', result = p_result, lease_until = null, last_error = null,
      finished_at = p_now
  where id = v_job.id
  returning * into v_job;
  return v_job;
end;
$$;

-- Put a job back to p_status ('queued' or 'waiting') at p_run_after. If it would be
-- queued while a newer job with the same dedupe key is already queued, it is cancelled
-- as superseded instead: the newer job does the same work with current data, and the
-- unique dedupe index allows only one queued job per key.
create or replace function private.requeue_job(
  p_job public.jobs,
  p_status public.job_status,
  p_run_after timestamptz
)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs;
begin
  if p_status = 'queued' and p_job.dedupe_key is not null and exists (
    select 1 from public.jobs
    where dedupe_key = p_job.dedupe_key and status = 'queued' and id <> p_job.id
  ) then
    update public.jobs
    set status = 'cancelled', lease_until = null, finished_at = now(),
        last_error = 'superseded by a newer job'
    where id = p_job.id
    returning * into v_job;
  else
    update public.jobs
    set status = p_status, run_after = p_run_after, lease_until = null
    where id = p_job.id
    returning * into v_job;
  end if;
  return v_job;
end;
$$;

-- Pause a job until p_resume_at, keeping a checkpoint (merged into the old one).
-- p_waiting marks a wait on something outside the system (a reply, a time) rather than
-- a plain continuation; both are woken by the sweep when p_resume_at passes.
create or replace function public.defer_job(
  p_job_id uuid,
  p_checkpoint jsonb,
  p_resume_at timestamptz,
  p_waiting boolean default false
)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs := private.running_job(p_job_id);
begin
  update public.jobs
  set checkpoint = checkpoint || coalesce(p_checkpoint, '{}')
  where id = v_job.id
  returning * into v_job;
  return private.requeue_job(
    v_job, case when p_waiting then 'waiting' else 'queued' end::public.job_status, p_resume_at
  );
end;
$$;

-- Record a failed attempt of a running job (also used for an expired lease). Retries
-- with exponential backoff (30 s doubling, at most an hour) until max_attempts, unless
-- p_retry is false; then the job fails for good. A retry superseded by a newer queued
-- job of the same key is cancelled (see requeue_job).
create or replace function private.record_failure(
  p_job public.jobs,
  p_error text,
  p_retry boolean,
  p_now timestamptz
)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer := p_job.attempts + 1;
  v_final boolean := not p_retry or v_attempts >= p_job.max_attempts;
  v_job public.jobs;
begin
  update public.jobs
  set attempts = v_attempts,
      last_error = left(p_error, 2000),
      lease_until = null,
      status = case when v_final then 'failed' else status end,
      finished_at = case when v_final then p_now end
  where id = p_job.id
  returning * into v_job;
  if v_final then
    return v_job;
  end if;
  return private.requeue_job(
    v_job, 'queued', p_now + make_interval(secs => least(3600, 30 * 2 ^ (v_attempts - 1)))
  );
end;
$$;

-- Record a failed attempt (see private.record_failure).
create or replace function public.fail_job(
  p_job_id uuid,
  p_error text,
  p_retry boolean default true,
  p_now timestamptz default now()
)
returns public.jobs
language sql
security definer
set search_path = ''
as $$
  select private.record_failure(private.running_job(p_job_id), p_error, p_retry, p_now)
$$;

-- One sweep at p_now: expired leases count as a failed attempt (same backoff as
-- fail_job), waiting jobs whose time came go back to queued, and every due queued job
-- is dispatched again (claims make duplicates harmless). A job that cannot be handled
-- is logged and skipped so it never stops the sweep for everyone. Returns counts.
create or replace function public.jobs_sweep(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs;
  v_expired integer := 0;
  v_woken integer := 0;
  v_dispatched integer;
begin
  perform private.assert_backend();

  for v_job in
    select * from public.jobs where status = 'running' and lease_until < p_now for update skip locked
  loop
    begin
      perform private.record_failure(v_job, 'lease expired', true, p_now);
      v_expired := v_expired + 1;
    exception when others then
      raise warning 'jobs_sweep: could not expire job %: %', v_job.id, sqlerrm;
    end;
  end loop;

  for v_job in
    select * from public.jobs where status = 'waiting' and run_after <= p_now for update skip locked
  loop
    begin
      perform private.requeue_job(v_job, 'queued', p_now);
      v_woken := v_woken + 1;
    exception when others then
      raise warning 'jobs_sweep: could not wake job %: %', v_job.id, sqlerrm;
    end;
  end loop;

  v_dispatched := private.dispatch_jobs(array(
    select j.id
    from public.jobs j
    join public.households h on h.id = j.household_id
    where j.status = 'queued' and j.run_after <= p_now and not h.background_paused
    order by j.run_after
    limit 100
  ));

  return jsonb_build_object('expired', v_expired, 'woken', v_woken, 'dispatched', v_dispatched);
end;
$$;

-- ---------------------------------------------------------------------------
-- Caregiver entry point
-- ---------------------------------------------------------------------------

-- Queue a message from a caregiver to the household agent. p_continue_job_id continues
-- the conversation of an earlier agent_chat job of the household (the agent runtime
-- resolves what that means, e.g. the same Managed Agents session). Returns the job id;
-- the reply appears in jobs.result.reply when the job succeeds.
create or replace function public.request_agent_chat(
  p_household_id uuid,
  p_message text,
  p_continue_job_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.can_edit(p_household_id) then
    raise exception 'Only caregivers who can edit may message the agent' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_message, ''))) = 0 or length(p_message) > 4000 then
    raise exception 'Message must be 1 to 4000 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.jobs
      where household_id = p_household_id and kind = 'agent_chat'
        and status in ('queued', 'running', 'waiting')) >= 5 then
    raise exception 'Too many agent requests in progress' using errcode = '54000';
  end if;
  if p_continue_job_id is not null and not exists (
    select 1 from public.jobs
    where id = p_continue_job_id and household_id = p_household_id and kind = 'agent_chat'
      and status = 'succeeded'
  ) then
    raise exception 'Nothing to continue (the earlier request must have finished)' using errcode = 'P0002';
  end if;
  return private.enqueue_job(
    p_household_id,
    'agent_chat',
    jsonb_strip_nulls(jsonb_build_object('message', trim(p_message), 'continue_job_id', p_continue_job_id)),
    null,
    now(),
    (select auth.uid())
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants and schedule
-- ---------------------------------------------------------------------------

revoke execute on function public.claim_job(uuid, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.checkpoint_job(uuid, jsonb, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.complete_job(uuid, jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function public.defer_job(uuid, jsonb, timestamptz, boolean) from public, anon, authenticated;
revoke execute on function public.fail_job(uuid, text, boolean, timestamptz) from public, anon, authenticated;
revoke execute on function public.jobs_sweep(timestamptz) from public, anon, authenticated;
revoke execute on function public.request_agent_chat(uuid, text, uuid) from public, anon;
grant execute on function public.claim_job(uuid, integer, timestamptz) to service_role;
grant execute on function public.checkpoint_job(uuid, jsonb, integer, timestamptz) to service_role;
grant execute on function public.complete_job(uuid, jsonb, timestamptz) to service_role;
grant execute on function public.defer_job(uuid, jsonb, timestamptz, boolean) to service_role;
grant execute on function public.fail_job(uuid, text, boolean, timestamptz) to service_role;
grant execute on function public.jobs_sweep(timestamptz) to service_role;
grant execute on function public.request_agent_chat(uuid, text, uuid) to authenticated;

select cron.schedule('sunny-jobs-sweep', '* * * * *', 'select public.jobs_sweep()');

-- Finished jobs are kept for 30 days.
select cron.schedule(
  'sunny-jobs-cleanup', '23 3 * * *',
  $$delete from public.jobs where finished_at < now() - interval '30 days'$$
);
