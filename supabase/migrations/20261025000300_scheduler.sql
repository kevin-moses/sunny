-- 20261025000300_scheduler.sql
-- Purpose: The SQL scheduler. Expands tasks into daily instances in each household's
-- local timezone (DST-safe), opens and closes confirmation windows, fires escalation
-- steps exactly once, and queues every resulting notification in notification_outbox.
-- pg_cron runs scheduler_tick() once a minute. Every function takes p_now so tests can
-- drive the clock. Editing a task's schedule re-expands its future instances right away.
-- Realtime is enabled on task_instances and notification_outbox so surfaces update
-- within seconds. See notes/SCHEMA.md.

create extension if not exists pg_cron with schema pg_catalog;

-- ---------------------------------------------------------------------------
-- Notification outbox
-- ---------------------------------------------------------------------------

create type public.notification_kind as enum ('senior_prompt', 'caregiver_alert');

create table public.notification_outbox (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  kind public.notification_kind not null,
  task_instance_id uuid references public.task_instances (id) on delete cascade,
  -- Exactly one recipient: a caregiver (user) or a senior device.
  recipient_user_id uuid references auth.users (id) on delete cascade,
  recipient_device_id uuid references public.devices (id) on delete cascade,
  title text not null,
  body text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  -- Set by the push sender (not built yet) once delivered.
  sent_at timestamptz,
  check (num_nonnulls(recipient_user_id, recipient_device_id) = 1)
);

create index notification_outbox_unsent_idx on public.notification_outbox (created_at)
  where sent_at is null;
create index notification_outbox_user_idx on public.notification_outbox (recipient_user_id, created_at desc);
create index notification_outbox_device_idx on public.notification_outbox (recipient_device_id, created_at desc);
create index notification_outbox_instance_idx on public.notification_outbox (task_instance_id);

alter table public.notification_outbox enable row level security;

create policy outbox_select_own on public.notification_outbox for select to authenticated
  using (
    recipient_user_id = (select auth.uid())
    or recipient_device_id = (select (private.my_device()).id)
  );

-- ---------------------------------------------------------------------------
-- Formatting helpers
-- ---------------------------------------------------------------------------

-- "8:00 AM" style time for notification text.
create or replace function private.format_time(p_time time)
returns text
language sql
immutable
set search_path = ''
as $$
  select to_char(date '2000-01-01' + p_time, 'FMHH12:MI AM')
$$;

-- ---------------------------------------------------------------------------
-- Expansion
-- ---------------------------------------------------------------------------

-- Create instances for today and tomorrow (household-local) for every active scheduled
-- task, or for one task when p_task_id is given. Idempotent. Window start is the local
-- date and time interpreted in the household timezone, so a daily 8:00 stays 8:00 local
-- across DST. A window that has already closed is only created if the schedule existed
-- when it opened, so new or edited tasks never back-fill past windows as missed.
-- Returns the number of instances created.
create or replace function public.expand_task_instances(
  p_now timestamptz default now(),
  p_task_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created integer;
begin
  insert into public.task_instances (
    task_id, household_id, local_date, scheduled_time, window_start, window_end
  )
  select t.id, t.household_id, d.local_date, tm.at, w.window_start,
         w.window_start + make_interval(mins => t.window_minutes)
  from public.tasks t
  join public.households h on h.id = t.household_id
  cross join lateral (
    select ((p_now at time zone h.timezone)::date + g)::date as local_date
    from generate_series(0, 1) as g
  ) d
  cross join lateral unnest(t.times) as tm(at)
  cross join lateral (
    select (d.local_date + tm.at) at time zone h.timezone as window_start
  ) w
  where t.active
    and (p_task_id is null or t.id = p_task_id)
    and (t.starts_on is null or d.local_date >= t.starts_on)
    and (t.ends_on is null or d.local_date <= t.ends_on)
    and case
          when t.once_on is not null then d.local_date = t.once_on
          else t.days_of_week is null
               or extract(isodow from d.local_date)::smallint = any (t.days_of_week)
        end
    and (
      w.window_start + make_interval(mins => t.window_minutes) > p_now
      or w.window_start >= t.schedule_changed_at
    )
  on conflict (task_id, local_date, scheduled_time) do nothing;

  get diagnostics v_created = row_count;
  return v_created;
end;
$$;

-- True when an update changed any field that affects which instances exist.
create or replace function private.task_schedule_changed(p_old public.tasks, p_new public.tasks)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_new.times, p_new.days_of_week, p_new.once_on, p_new.starts_on, p_new.ends_on,
          p_new.window_minutes, p_new.active)
         is distinct from
         (p_old.times, p_old.days_of_week, p_old.once_on, p_old.starts_on, p_old.ends_on,
          p_old.window_minutes, p_old.active)
$$;

-- Track schedule edits on tasks.
create or replace function private.touch_task_schedule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.task_schedule_changed(old, new) then
    new.schedule_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger tasks_touch_schedule before update on public.tasks
  for each row execute function private.touch_task_schedule();

-- After a task is created or its schedule changes, drop its future upcoming instances
-- and expand again so every surface sees the new schedule immediately. Deactivating a
-- task (e.g. the senior cancels a reminder) also removes its open instances, so nothing
-- keeps prompting for it.
create or replace function private.resync_task_instances()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if not private.task_schedule_changed(old, new) then
      return null;
    end if;
    if not new.active then
      delete from public.task_instances
      where task_id = new.id and state in ('upcoming', 'due', 'escalated');
      return null;
    end if;
    delete from public.task_instances
    where task_id = new.id and state = 'upcoming' and window_start > now();
  end if;
  perform public.expand_task_instances(now(), new.id);
  return null;
end;
$$;

create trigger tasks_resync_instances after insert or update on public.tasks
  for each row execute function private.resync_task_instances();

-- A household timezone change moves every future window: drop upcoming instances and
-- expand again in the new zone.
create or replace function private.resync_household_timezone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.task_instances
  where household_id = new.id and state = 'upcoming' and window_start > now();
  perform public.expand_task_instances(now());
  return null;
end;
$$;

create trigger households_resync_timezone after update of timezone on public.households
  for each row when (new.timezone is distinct from old.timezone)
  execute function private.resync_household_timezone();

-- ---------------------------------------------------------------------------
-- Tick
-- ---------------------------------------------------------------------------

-- One scheduler pass at p_now:
--   1. expand instances for today and tomorrow
--   2. open windows (upcoming -> due)
--   3. fire every escalation step whose offset has passed, once, queueing notifications.
--      Offsets count from the later of window start and when the instance was created,
--      so a task added mid-window starts its ladder then instead of paging at once.
--      Senior prompts wait while the instance is snoozed, skip_if_claimed steps are
--      skipped once claimed, inactive tasks never fire, and when several steps of the
--      same kind (prompt or caregiver alert) come due together only the latest is sent
--   4. mark instances with a fired caregiver alert as escalated
--   5. close windows (due/escalated -> missed)
-- Serialized with an advisory lock so overlapping cron runs cannot interleave.
-- Returns counts for logging.
create or replace function public.scheduler_tick(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created integer;
  v_opened integer;
  v_fired integer;
  v_escalated integer;
  v_missed integer;
begin
  perform pg_advisory_xact_lock(hashtext('sunny.scheduler_tick'));

  v_created := public.expand_task_instances(p_now);

  update public.task_instances
  set state = 'due'
  where state = 'upcoming' and window_start <= p_now;
  get diagnostics v_opened = row_count;

  with candidates as (
    select i.id as task_instance_id, s.position, s.action,
           row_number() over (
             partition by i.id, (s.action = 'prompt_senior')
             order by s.position desc
           ) = 1 as notify
    from public.task_instances i
    join public.tasks t on t.id = i.task_id
    join public.escalation_steps s on s.policy_id = t.escalation_policy_id
    where i.state in ('due', 'escalated')
      and t.active
      and i.window_end > p_now
      and p_now >= greatest(i.window_start, i.created_at) + make_interval(mins => s.offset_minutes)
      and not (s.action = 'prompt_senior' and i.snoozed_until is not null and p_now < i.snoozed_until)
      and not (s.skip_if_claimed and i.claimed_by is not null)
      and not exists (
        select 1 from public.instance_escalations e
        where e.task_instance_id = i.id and e.step_position = s.position
      )
  ),
  fired as (
    insert into public.instance_escalations (task_instance_id, step_position, action, fired_at, notified)
    select task_instance_id, position, action, p_now, notify from candidates
    on conflict do nothing
    returning task_instance_id, step_position, action, notified
  ),
  queued as (
    insert into public.notification_outbox (
      household_id, kind, task_instance_id, recipient_user_id, recipient_device_id,
      title, body, payload
    )
    select
      i.household_id,
      case when f.action = 'prompt_senior'
           then 'senior_prompt' else 'caregiver_alert' end::public.notification_kind,
      i.id,
      r.user_id,
      r.device_id,
      case when f.action = 'prompt_senior'
           then t.display_label
           else h.senior_preferred_name || ' hasn''t confirmed ' || t.display_label end,
      case
        when f.action = 'prompt_senior'
          then t.spoken_prompt
        when f.action = 'alert_on_call'
          then 'Due at ' || private.format_time(i.scheduled_time) || '. Tap to claim it.'
        else 'Due at ' || private.format_time(i.scheduled_time) || '. No one has claimed it yet.'
      end,
      jsonb_build_object(
        'task_id', t.id,
        'local_date', i.local_date,
        'step', f.step_position,
        'action', f.action
      )
    from fired f
    join public.task_instances i on i.id = f.task_instance_id
    join public.tasks t on t.id = i.task_id
    join public.households h on h.id = i.household_id
    cross join lateral (
      select null::uuid as user_id, d.id as device_id
      from public.devices d
      where f.action = 'prompt_senior' and d.household_id = i.household_id
      union all
      select m.user_id, null::uuid
      from public.household_members m
      where m.household_id = i.household_id
        and (
          f.action = 'alert_all_caregivers'
          or (f.action = 'alert_on_call'
              and (m.user_id = h.on_call_user_id
                   or (h.on_call_user_id is null and m.role = 'primary')))
        )
    ) r
    where f.notified
    returning 1
  )
  select count(*) filter (where notified) into v_fired from fired;

  update public.task_instances i
  set state = 'escalated'
  where i.state = 'due'
    and exists (
      select 1 from public.instance_escalations e
      where e.task_instance_id = i.id and e.action <> 'prompt_senior'
    );
  get diagnostics v_escalated = row_count;

  update public.task_instances
  set state = 'missed'
  where state in ('due', 'escalated') and window_end <= p_now;
  get diagnostics v_missed = row_count;

  return jsonb_build_object(
    'created', v_created,
    'opened', v_opened,
    'steps_fired', v_fired,
    'escalated', v_escalated,
    'missed', v_missed
  );
end;
$$;

revoke execute on function public.expand_task_instances(timestamptz, uuid) from public, anon, authenticated;
revoke execute on function public.scheduler_tick(timestamptz) from public, anon, authenticated;
grant execute on function public.expand_task_instances(timestamptz, uuid) to service_role;
grant execute on function public.scheduler_tick(timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Schedule and realtime
-- ---------------------------------------------------------------------------

select cron.schedule('sunny-scheduler-tick', '* * * * *', 'select public.scheduler_tick()');

-- pg_cron logs every run (1,440 a day for the tick); keep a week.
select cron.schedule(
  'sunny-cron-history-cleanup', '17 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$
);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.task_instances, public.notification_outbox;
  end if;
end;
$$;
