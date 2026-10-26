-- 20261025000200_tasks.sql
-- Purpose: Tasks and their daily instances, the core of the confirm/escalate loop.
-- Creates escalation policies and ordered steps (seeded per household with the SPEC
-- defaults and a stable system_key), tasks (schedule rule, confirmation window,
-- senior-facing wording that always has a spoken prompt, pill description, as-needed
-- limits, checklist items), task instances (one per scheduled time per local date, with
-- the upcoming/due/escalated/confirmed/missed/resolved state machine), fired escalation
-- steps, self-reported doses, and the audit log written by triggers.
-- Exposes the RPCs every surface shares: confirm, snooze and claim one instance;
-- get_today and confirm_due_task (which task "Done" means, plus the already-done guard);
-- create and cancel senior-created reminders.
-- Expansion and the scheduler tick live in the scheduler migration. See notes/SCHEMA.md.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.task_type as enum ('medication', 'appointment', 'routine', 'checklist', 'reminder');
create type public.task_creator as enum ('caregiver', 'senior');
create type public.instance_state as enum (
  'upcoming', 'due', 'escalated', 'confirmed', 'missed', 'resolved'
);
create type public.confirm_via as enum (
  'button', 'widget', 'live_activity', 'phone_app', 'voice', 'caregiver'
);
create type public.escalation_action as enum (
  'prompt_senior', 'alert_on_call', 'alert_all_caregivers'
);
create type public.actor_kind as enum ('caregiver', 'senior_device', 'agent', 'system');

-- Who is calling: 'agent' (service role), 'senior_device' (a paired device),
-- 'caregiver' (any other signed-in user) or 'system' (pg_cron, migrations, tests).
-- Consistent with private.is_backend(): agent and system are the backend.
create or replace function private.caller_kind()
returns public.actor_kind
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when coalesce((select auth.jwt()) ->> 'role', '') = 'service_role' then 'agent'::public.actor_kind
    when exists (select 1 from public.devices where user_id = (select auth.uid()))
      then 'senior_device'::public.actor_kind
    when (select auth.uid()) is not null then 'caregiver'::public.actor_kind
    else 'system'::public.actor_kind
  end
$$;

-- ---------------------------------------------------------------------------
-- Escalation policies
-- ---------------------------------------------------------------------------

create table public.escalation_policies (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  -- Stable key for the seeded defaults, so code never depends on the editable name.
  system_key text check (system_key in ('medication', 'prompt_only')),
  created_at timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, name),
  unique (household_id, system_key)
);

create table public.escalation_steps (
  policy_id uuid not null references public.escalation_policies (id) on delete cascade,
  position smallint not null check (position >= 0),
  offset_minutes integer not null check (offset_minutes >= 0),
  action public.escalation_action not null,
  -- When true the step is skipped once a caregiver has claimed the instance.
  skip_if_claimed boolean not null default false,
  primary key (policy_id, position)
);

-- Seed the SPEC default policies for a new household.
create or replace function private.seed_default_policies()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_medication uuid;
  v_prompt_only uuid;
begin
  insert into public.escalation_policies (household_id, name, system_key)
  values (new.id, 'Medication', 'medication') returning id into v_medication;
  insert into public.escalation_steps (policy_id, position, offset_minutes, action, skip_if_claimed)
  values
    (v_medication, 0, 0, 'prompt_senior', false),
    (v_medication, 1, 15, 'prompt_senior', false),
    (v_medication, 2, 30, 'alert_on_call', false),
    (v_medication, 3, 45, 'alert_all_caregivers', true);

  insert into public.escalation_policies (household_id, name, system_key)
  values (new.id, 'Prompt only', 'prompt_only') returning id into v_prompt_only;
  insert into public.escalation_steps (policy_id, position, offset_minutes, action)
  values (v_prompt_only, 0, 0, 'prompt_senior');

  return new;
end;
$$;

create trigger households_seed_policies after insert on public.households
  for each row execute function private.seed_default_policies();

-- Seeded policies may be renamed and their steps tuned, but not deleted or re-keyed,
-- because senior reminders and defaults find them by system_key. Household deletion
-- (which cascades) is still allowed.
create or replace function private.protect_seeded_policies()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.system_key is not null
     and (tg_op = 'DELETE' or new.system_key is distinct from old.system_key)
     and exists (select 1 from public.households where id = old.household_id) then
    raise exception 'Default escalation policies cannot be deleted' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger escalation_policies_protect_seeded before update or delete on public.escalation_policies
  for each row execute function private.protect_seeded_policies();

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  type public.task_type not null,
  -- Caregiver-facing name, e.g. "Morning pills (lisinopril, metformin)".
  title text not null check (length(trim(title)) > 0),
  -- Short label the display and widget show, e.g. "Morning pills".
  display_label text not null check (length(trim(display_label)) > 0),
  -- Exact sentence every surface speaks or shows for the prompt; defaulted from the
  -- label when a caregiver leaves it blank so all surfaces use the same words.
  spoken_prompt text not null,
  pill_description text,
  checklist_items text[] not null default '{}',
  -- Schedule rule, in the household's local time. Empty times = unscheduled
  -- (as-needed medication that is only logged when taken).
  times time[] not null default '{}' check (array_position(times, null) is null),
  -- ISO weekdays, 1 = Monday ... 7 = Sunday. Null = every day.
  days_of_week smallint[] check (days_of_week <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  -- One-off task on a single local date (e.g. "remind me tomorrow").
  once_on date,
  starts_on date,
  ends_on date,
  window_minutes integer not null default 60 check (window_minutes between 1 and 720),
  escalation_policy_id uuid,
  -- As-needed limits copied from the label by a caregiver.
  as_needed_max_per_day smallint check (as_needed_max_per_day > 0),
  as_needed_min_hours numeric(4, 1) check (as_needed_min_hours > 0),
  created_by_kind public.task_creator not null default 'caregiver',
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  active boolean not null default true,
  -- Last change to any schedule field; expansion never back-fills windows that opened
  -- before the schedule existed (maintained by the scheduler migration's trigger).
  schedule_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, escalation_policy_id)
    references public.escalation_policies (household_id, id)
    on delete set null (escalation_policy_id),
  check (once_on is null or days_of_week is null),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

create index tasks_household_idx on public.tasks (household_id) where active;

create trigger tasks_updated_at before update on public.tasks
  for each row execute function private.set_updated_at();

-- Fill a blank spoken prompt from the display label.
create or replace function private.default_spoken_prompt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.spoken_prompt is null or length(trim(new.spoken_prompt)) = 0 then
    new.spoken_prompt := 'Time for ' || new.display_label || '.';
  end if;
  return new;
end;
$$;

create trigger tasks_default_spoken_prompt before insert or update on public.tasks
  for each row execute function private.default_spoken_prompt();

-- ---------------------------------------------------------------------------
-- Task instances
-- ---------------------------------------------------------------------------

create table public.task_instances (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  household_id uuid not null,
  local_date date not null,
  scheduled_time time not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  state public.instance_state not null default 'upcoming',
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users (id) on delete set null,
  confirmed_via public.confirm_via,
  resolution_note text,
  snoozed_until timestamptz,
  claimed_by uuid references auth.users (id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (household_id, task_id) references public.tasks (household_id, id) on delete cascade,
  unique (task_id, local_date, scheduled_time),
  check (window_end > window_start),
  check ((state in ('confirmed', 'resolved')) = (confirmed_at is not null))
);

create index task_instances_open_idx on public.task_instances (window_start)
  where state in ('upcoming', 'due', 'escalated');
create index task_instances_household_date_idx on public.task_instances (household_id, local_date);

create trigger task_instances_updated_at before update on public.task_instances
  for each row execute function private.set_updated_at();

-- Escalation steps already handled for an instance; the primary key prevents double
-- firing. action is a snapshot of the step as fired, so later policy edits don't rewrite
-- history. notified is false for a step that came due in the same tick as a later step of
-- the same kind (after a snooze or downtime) and was superseded rather than sent.
create table public.instance_escalations (
  task_instance_id uuid not null references public.task_instances (id) on delete cascade,
  step_position smallint not null,
  action public.escalation_action not null,
  fired_at timestamptz not null,
  notified boolean not null default true,
  primary key (task_instance_id, step_position)
);

-- Lock one instance for update, or raise not-found.
create or replace function private.lock_instance(p_instance_id uuid)
returns public.task_instances
language plpgsql
set search_path = ''
as $$
declare
  v_instance public.task_instances;
begin
  select * into v_instance from public.task_instances where id = p_instance_id for update;
  if not found then
    raise exception 'Task instance not found' using errcode = 'P0002';
  end if;
  return v_instance;
end;
$$;

-- ---------------------------------------------------------------------------
-- Self-reported doses (as-needed medication taken outside a scheduled instance)
-- ---------------------------------------------------------------------------

create table public.dose_log (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  task_id uuid not null,
  taken_at timestamptz not null default now(),
  reported_via public.confirm_via not null,
  reported_by uuid default auth.uid() references auth.users (id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  foreign key (household_id, task_id) references public.tasks (household_id, id) on delete cascade
);

create index dose_log_household_idx on public.dose_log (household_id, taken_at desc);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  actor_user_id uuid,
  actor_kind public.actor_kind not null,
  action text not null,
  entity text not null,
  entity_id uuid,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index audit_log_household_idx on public.audit_log (household_id, created_at desc);

-- Record instance state, claim and snooze changes.
create or replace function private.audit_task_instance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state is distinct from old.state
     or new.claimed_by is distinct from old.claimed_by
     or new.snoozed_until is distinct from old.snoozed_until then
    insert into public.audit_log (household_id, actor_user_id, actor_kind, action, entity, entity_id, detail)
    values (
      new.household_id,
      (select auth.uid()),
      private.caller_kind(),
      case
        when new.state is distinct from old.state then 'state_change'
        when new.claimed_by is distinct from old.claimed_by then 'claim'
        else 'snooze'
      end,
      'task_instance',
      new.id,
      jsonb_strip_nulls(jsonb_build_object(
        'from', old.state,
        'to', new.state,
        'via', new.confirmed_via,
        'claimed_by', new.claimed_by,
        'snoozed_until', new.snoozed_until
      ))
    );
  end if;
  return new;
end;
$$;

create trigger task_instances_audit after update on public.task_instances
  for each row execute function private.audit_task_instance();

-- Record task creation, edits and deletion.
create or replace function private.audit_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.tasks := coalesce(new, old);
begin
  -- Deleting a household cascades to its tasks; there is nothing left to audit into.
  if tg_op = 'DELETE' and not exists (select 1 from public.households where id = v_row.household_id) then
    return v_row;
  end if;
  insert into public.audit_log (household_id, actor_user_id, actor_kind, action, entity, entity_id, detail)
  values (
    v_row.household_id,
    (select auth.uid()),
    private.caller_kind(),
    lower(tg_op),
    'task',
    v_row.id,
    jsonb_build_object('display_label', v_row.display_label, 'created_by_kind', v_row.created_by_kind)
  );
  return v_row;
end;
$$;

create trigger tasks_audit after insert or update or delete on public.tasks
  for each row execute function private.audit_task();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.escalation_policies enable row level security;
alter table public.escalation_steps enable row level security;
alter table public.tasks enable row level security;
alter table public.task_instances enable row level security;
alter table public.instance_escalations enable row level security;
alter table public.dose_log enable row level security;
alter table public.audit_log enable row level security;

create policy policies_select on public.escalation_policies for select to authenticated
  using (household_id in (select private.my_household_ids()));
create policy policies_write on public.escalation_policies for all to authenticated
  using (private.can_edit(household_id)) with check (private.can_edit(household_id));

create policy steps_select on public.escalation_steps for select to authenticated
  using (exists (
    select 1 from public.escalation_policies p
    where p.id = policy_id and p.household_id in (select private.my_household_ids())
  ));
create policy steps_write on public.escalation_steps for all to authenticated
  using (exists (
    select 1 from public.escalation_policies p where p.id = policy_id and private.can_edit(p.household_id)
  ))
  with check (exists (
    select 1 from public.escalation_policies p where p.id = policy_id and private.can_edit(p.household_id)
  ));

create policy tasks_select on public.tasks for select to authenticated
  using (household_id in (select private.my_household_ids()));
create policy tasks_write on public.tasks for all to authenticated
  using (private.can_edit(household_id)) with check (private.can_edit(household_id));

-- Instances are read by everyone in the household; writes go through the RPCs below.
create policy instances_select on public.task_instances for select to authenticated
  using (household_id in (select private.my_household_ids()));

create policy escalations_select on public.instance_escalations for select to authenticated
  using (exists (
    select 1 from public.task_instances i
    where i.id = task_instance_id and i.household_id in (select private.my_household_ids())
  ));

create policy dose_log_select on public.dose_log for select to authenticated
  using (household_id in (select private.my_household_ids()));
create policy dose_log_insert on public.dose_log for insert to authenticated
  with check (
    reported_by = (select auth.uid())
    and taken_at <= now() + interval '5 minutes'
    and (private.can_edit(household_id)
         or household_id = (select (private.my_device()).household_id))
  );

create policy audit_select on public.audit_log for select to authenticated
  using (private.is_caregiver(household_id));

-- ---------------------------------------------------------------------------
-- Instance RPCs
-- ---------------------------------------------------------------------------

-- Confirm a task instance from any surface. A paired senior device or the agent
-- produces 'confirmed'; a caregiver produces 'resolved' recorded under their name with
-- confirmed_via = 'caregiver'. Upcoming instances can be confirmed up to 60 minutes
-- early; missed instances can still be confirmed late. Confirming an instance that is
-- already confirmed or resolved changes nothing and returns it, so callers can read
-- confirmed_at for the already-done guard. p_now is honored only for backend callers.
create or replace function public.confirm_task_instance(
  p_instance_id uuid,
  p_via public.confirm_via,
  p_note text default null,
  p_now timestamptz default now()
)
returns public.task_instances
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.clock(p_now);
  v_kind public.actor_kind := private.caller_kind();
  v_instance public.task_instances := private.lock_instance(p_instance_id);
  v_as_caregiver boolean;
begin
  if v_kind in ('system', 'agent')
     or (v_kind = 'senior_device' and (private.my_device()).household_id = v_instance.household_id) then
    v_as_caregiver := false;
  elsif v_kind = 'caregiver' and private.can_edit(v_instance.household_id) then
    v_as_caregiver := true;
  else
    raise exception 'Not allowed to confirm this task' using errcode = '42501';
  end if;

  if v_instance.state in ('confirmed', 'resolved') then
    return v_instance;
  end if;

  if v_instance.state = 'upcoming' and v_instance.window_start - v_now > interval '60 minutes' then
    raise exception 'This task is not due yet' using errcode = '22023';
  end if;

  update public.task_instances
  set state = case when v_as_caregiver then 'resolved' else 'confirmed' end::public.instance_state,
      confirmed_at = v_now,
      confirmed_by = (select auth.uid()),
      confirmed_via = case when v_as_caregiver then 'caregiver' else p_via end,
      resolution_note = p_note,
      snoozed_until = null
  where id = p_instance_id
  returning * into v_instance;

  return v_instance;
end;
$$;

-- Snooze senior prompts for an open instance ("not yet"). Caregiver alerts are not delayed.
create or replace function public.snooze_task_instance(
  p_instance_id uuid,
  p_minutes integer default 15,
  p_now timestamptz default now()
)
returns public.task_instances
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.clock(p_now);
  v_instance public.task_instances := private.lock_instance(p_instance_id);
begin
  perform private.assert_senior_access(v_instance.household_id);
  if p_minutes is null or p_minutes not between 1 and 120 then
    raise exception 'Snooze must be between 1 and 120 minutes' using errcode = '22023';
  end if;
  if v_instance.state not in ('due', 'escalated') then
    return v_instance;
  end if;

  update public.task_instances
  set snoozed_until = v_now + make_interval(mins => p_minutes)
  where id = p_instance_id
  returning * into v_instance;
  return v_instance;
end;
$$;

-- Claim an open instance ("I'm on it") as a caregiver. First claim wins.
create or replace function public.claim_task_instance(p_instance_id uuid)
returns public.task_instances
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_instance public.task_instances := private.lock_instance(p_instance_id);
begin
  if not private.can_edit(v_instance.household_id) then
    raise exception 'Not allowed to claim this task' using errcode = '42501';
  end if;
  if v_instance.claimed_by is not null or v_instance.state not in ('due', 'escalated', 'missed') then
    return v_instance;
  end if;

  update public.task_instances
  set claimed_by = (select auth.uid()), claimed_at = now()
  where id = p_instance_id
  returning * into v_instance;
  return v_instance;
end;
$$;

-- ---------------------------------------------------------------------------
-- Today and the senior's own actions
-- ---------------------------------------------------------------------------

-- Today's instances (household-local date at p_now) in schedule order, as JSON.
create or replace function private.today_json(p_household_id uuid, p_now timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'instance_id', i.id,
    'task_id', t.id,
    'type', t.type,
    'display_label', t.display_label,
    'spoken_prompt', t.spoken_prompt,
    'pill_description', t.pill_description,
    'checklist_items', t.checklist_items,
    'scheduled_time', i.scheduled_time,
    'state', i.state,
    'confirmed_at', i.confirmed_at,
    'confirmed_via', i.confirmed_via
  ) order by i.window_start), '[]'::jsonb)
  from public.households h
  join public.task_instances i
    on i.household_id = h.id and i.local_date = (p_now at time zone h.timezone)::date
  join public.tasks t on t.id = i.task_id
  where h.id = p_household_id
$$;

-- Today's schedule for anyone in the household (or the backend).
create or replace function public.get_today(p_household_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (private.is_backend() or p_household_id in (select private.my_household_ids())) then
    raise exception 'Not allowed to read this household' using errcode = '42501';
  end if;
  return private.today_json(p_household_id, private.clock(p_now));
end;
$$;

-- Confirm "the task" the senior means, the single rule for the Done button, the widget
-- and voice. With no label: the earliest due or escalated task today ("top one if two").
-- With a label: today's task whose display label contains it, preferring tasks that are
-- due now over ones later or earlier in the day. Returns
-- { status, instance_id?, display_label?, scheduled_time?, confirmed_at?, options? } where
-- status is confirmed | already_done | nothing_due | not_found | ambiguous | not_due_yet.
-- already_done carries the original confirmed_at, guarding against double doses.
create or replace function public.confirm_due_task(
  p_household_id uuid,
  p_via public.confirm_via,
  p_label text default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.clock(p_now);
  v_label text := nullif(lower(trim(coalesce(p_label, ''))), '');
  v_today jsonb;
  v_matches jsonb;
  v_open jsonb;
  v_target jsonb;
  v_row public.task_instances;
begin
  perform private.assert_senior_access(p_household_id);
  v_today := private.today_json(p_household_id, v_now);

  if v_label is null then
    select e into v_target
    from jsonb_array_elements(v_today) e
    where e ->> 'state' in ('due', 'escalated')
    limit 1;
    if v_target is null then
      return jsonb_build_object('status', 'nothing_due');
    end if;
  else
    select coalesce(jsonb_agg(e), '[]'::jsonb) into v_matches
    from jsonb_array_elements(v_today) e
    where position(v_label in lower(e ->> 'display_label')) > 0;
    if jsonb_array_length(v_matches) = 0 then
      return jsonb_build_object('status', 'not_found');
    end if;

    -- Prefer what is due now; otherwise any match that is still open.
    select coalesce(jsonb_agg(e), '[]'::jsonb) into v_open
    from jsonb_array_elements(v_matches) e
    where e ->> 'state' in ('due', 'escalated');
    if jsonb_array_length(v_open) = 0 then
      select coalesce(jsonb_agg(e), '[]'::jsonb) into v_open
      from jsonb_array_elements(v_matches) e
      where e ->> 'state' not in ('confirmed', 'resolved');
    end if;
    if jsonb_array_length(v_open) = 0 then
      select e || jsonb_build_object('status', 'already_done') into v_target
      from jsonb_array_elements(v_matches) e
      order by e ->> 'confirmed_at' desc
      limit 1;
      return v_target;
    end if;
    if jsonb_array_length(v_open) > 1 then
      return jsonb_build_object('status', 'ambiguous', 'options', v_open);
    end if;
    v_target := v_open -> 0;
  end if;

  begin
    v_row := public.confirm_task_instance((v_target ->> 'instance_id')::uuid, p_via, null, p_now);
  exception when sqlstate '22023' then
    return v_target || jsonb_build_object('status', 'not_due_yet');
  end;

  -- Another surface may have confirmed it between our read and the row lock; then this
  -- press did nothing and must say so, with the original time.
  return v_target || jsonb_build_object(
    'status', case when v_row.confirmed_at = v_now then 'confirmed' else 'already_done' end,
    'state', v_row.state,
    'confirmed_at', v_row.confirmed_at
  );
end;
$$;

-- Create a reminder the senior asked for ("remind me to call the plumber tomorrow at 10").
-- Stored as a senior-created task on the household's prompt-only policy, so it prompts
-- the senior and caregivers can see it. One-off when p_on_date is given (today or later
-- in the household's timezone), otherwise recurring on p_days (ISO weekdays; null or all
-- seven = every day).
create or replace function public.create_senior_reminder(
  p_household_id uuid,
  p_title text,
  p_time time,
  p_on_date date default null,
  p_days smallint[] default null
)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text := trim(p_title);
  v_task public.tasks;
begin
  perform private.assert_senior_access(p_household_id);
  if v_title is null or v_title = '' or p_time is null then
    raise exception 'A reminder needs a title and a time' using errcode = '22023';
  end if;
  if p_on_date < (select (now() at time zone timezone)::date from public.households where id = p_household_id) then
    raise exception 'That date has already passed' using errcode = '22023';
  end if;

  insert into public.tasks (
    household_id, type, title, display_label, spoken_prompt, times, once_on, days_of_week,
    window_minutes, created_by_kind, escalation_policy_id
  )
  values (
    p_household_id,
    'reminder',
    v_title,
    upper(left(v_title, 1)) || substr(v_title, 2),
    'Reminder: ' || v_title || '.',
    array[p_time],
    p_on_date,
    case when p_on_date is null and cardinality(p_days) between 1 and 6 then p_days end,
    30,
    'senior',
    (select id from public.escalation_policies
     where household_id = p_household_id and system_key = 'prompt_only')
  )
  returning * into v_task;
  return v_task;
end;
$$;

-- Cancel a reminder the senior created, by case-insensitive title match. Caregiver
-- tasks are never matched; a blank query matches nothing. Returns
-- { status: cancelled | not_found | ambiguous, titles }.
create or replace function public.cancel_senior_reminder(p_household_id uuid, p_query text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_titles text[];
begin
  perform private.assert_senior_access(p_household_id);

  select array_agg(id order by created_at), array_agg(title order by created_at)
    into v_ids, v_titles
  from public.tasks
  where household_id = p_household_id
    and created_by_kind = 'senior'
    and active
    and length(trim(coalesce(p_query, ''))) > 0
    and position(lower(trim(p_query)) in lower(title)) > 0;

  if v_ids is null then
    return jsonb_build_object('status', 'not_found', 'titles', '[]'::jsonb);
  end if;
  if cardinality(v_ids) > 1 then
    return jsonb_build_object('status', 'ambiguous', 'titles', to_jsonb(v_titles));
  end if;

  update public.tasks set active = false where id = v_ids[1];
  return jsonb_build_object('status', 'cancelled', 'titles', to_jsonb(v_titles));
end;
$$;

revoke execute on function public.confirm_task_instance(uuid, public.confirm_via, text, timestamptz) from public, anon;
revoke execute on function public.snooze_task_instance(uuid, integer, timestamptz) from public, anon;
revoke execute on function public.claim_task_instance(uuid) from public, anon;
revoke execute on function public.get_today(uuid, timestamptz) from public, anon;
revoke execute on function public.confirm_due_task(uuid, public.confirm_via, text, timestamptz) from public, anon;
revoke execute on function public.create_senior_reminder(uuid, text, time, date, smallint[]) from public, anon;
revoke execute on function public.cancel_senior_reminder(uuid, text) from public, anon;
grant execute on function public.confirm_task_instance(uuid, public.confirm_via, text, timestamptz) to authenticated, service_role;
grant execute on function public.snooze_task_instance(uuid, integer, timestamptz) to authenticated, service_role;
grant execute on function public.claim_task_instance(uuid) to authenticated;
grant execute on function public.get_today(uuid, timestamptz) to authenticated, service_role;
grant execute on function public.confirm_due_task(uuid, public.confirm_via, text, timestamptz) to authenticated, service_role;
grant execute on function public.create_senior_reminder(uuid, text, time, date, smallint[]) to authenticated, service_role;
grant execute on function public.cancel_senior_reminder(uuid, text) to authenticated, service_role;
