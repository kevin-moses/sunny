-- 20261027000300_calendar.sql
-- Purpose: The shared calendar and day clock (see notes/SCHEMA.md "Calendar" and
-- notes/AGENT_RUNTIME.md "Google Calendar sync").
--   * events moves from instants to a household-local schedule (starts_on, start_time,
--     duration, optional weekly repeat) so 2 PM stays 2 PM across DST; occurrences are
--     computed by private.event_occurrences. Cancelling is a soft delete (deleted_at) so
--     it can sync; clients can no longer hard-delete events.
--   * One write path for agent, caregiver app and voice: add_event, update_event,
--     cancel_event, list_events. created_via records who made the event; backend
--     callers must name the household they act for when changing an event.
--   * get_day_view: the day clock every surface renders (part of day, today's tasks and
--     events, Next up, the coming week).
--   * Day-of notices: event_notice_tick (pg_cron) queues one 'event_notice' per caregiver
--     per occurrence at households.event_notice_time, or right away for an event added
--     later that day.
--   * Google sync: calendar_connections (one per caregiver; refresh token in Vault) and
--     calendar_event_links; every event change queues calendar_sync_event jobs, and
--     get_event_sync_payload gives jobs-run the event in Google's terms.
--   * Removing a caregiver from the household removes their Google connection, and
--     changes to the household's timezone, notice time or name re-push every event.
--   * get_agent_context reads events through the new occurrences.
--   * The new private helpers (here and in the jobs migration) are not executable by the
--     API roles.

-- ---------------------------------------------------------------------------
-- Events: local schedule, soft delete, provenance
-- ---------------------------------------------------------------------------

alter table public.households add column event_notice_time time not null default '08:00';

alter table public.events
  add column label text check (label is null or length(trim(label)) > 0),
  add column starts_on date,
  add column start_time time,
  add column duration_minutes integer check (duration_minutes between 1 and 1440),
  -- ISO weekdays, 1 = Monday ... 7 = Sunday. Null = a one-off event on starts_on.
  add column repeat_days smallint[] check (
    repeat_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[] and cardinality(repeat_days) > 0
  ),
  add column repeat_until date,
  add column created_via public.actor_kind not null default 'caregiver',
  add column deleted_at timestamptz;

update public.events e
set starts_on = (e.starts_at at time zone h.timezone)::date,
    start_time = (e.starts_at at time zone h.timezone)::time,
    duration_minutes = case when e.ends_at is not null
      then greatest(1, least(1440, ceil(extract(epoch from e.ends_at - e.starts_at) / 60)::integer)) end
from public.households h
where h.id = e.household_id;

alter table public.events
  alter column starts_on set not null,
  alter column start_time set not null,
  drop column starts_at,
  drop column ends_at,
  add constraint events_repeat_until_check
    check (repeat_until is null or (repeat_days is not null and repeat_until >= starts_on));

create index events_household_starts_on_idx on public.events (household_id, starts_on)
  where deleted_at is null;

-- Bounds on free text (the agent writes these too).
alter table public.events
  add constraint events_text_lengths check (
    length(title) <= 200 and length(coalesce(label, '')) <= 80
    and length(coalesce(place, '')) <= 300 and length(coalesce(visitor_name, '')) <= 120
    and length(coalesce(notes, '')) <= 2000
  );

-- Cancelling goes through cancel_event (soft delete) so it reaches Google.
drop policy events_delete on public.events;

-- Who made the event: the agent (service role), a caregiver, or a senior device.
create or replace function private.set_event_created_via()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.created_via := private.caller_kind();
  return new;
end;
$$;

create trigger events_set_created_via before insert on public.events
  for each row execute function private.set_event_created_via();

-- Record event creation, edits, cancellation and deletion.
create or replace function private.audit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.events := coalesce(new, old);
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.households where id = v_row.household_id) then
    return v_row;
  end if;
  insert into public.audit_log (household_id, actor_user_id, actor_kind, action, entity, entity_id, detail)
  values (
    v_row.household_id,
    (select auth.uid()),
    private.caller_kind(),
    case
      when tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null then 'cancel'
      else lower(tg_op)
    end,
    'event',
    v_row.id,
    jsonb_build_object('title', v_row.title, 'starts_on', v_row.starts_on,
                       'start_time', v_row.start_time, 'created_via', v_row.created_via)
  );
  return v_row;
end;
$$;

create trigger events_audit after insert or update or delete on public.events
  for each row execute function private.audit_event();

-- ---------------------------------------------------------------------------
-- Occurrences and JSON shapes
-- ---------------------------------------------------------------------------

-- Occurrences of a household's live events (or just p_event_id) between two local dates
-- (inclusive), unordered; callers order them.
create or replace function private.event_occurrences(
  p_household_id uuid,
  p_from date,
  p_to date,
  p_event_id uuid default null
)
returns table (event_id uuid, local_date date, starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id,
         d.day,
         (d.day + e.start_time) at time zone h.timezone,
         case when e.duration_minutes is not null
              then ((d.day + e.start_time) at time zone h.timezone)
                   + make_interval(mins => e.duration_minutes) end
  from public.events e
  join public.households h on h.id = e.household_id
  cross join lateral (
    select g::date as day
    from generate_series(
      greatest(p_from, e.starts_on),
      case when e.repeat_days is null then least(p_to, e.starts_on)
           else least(p_to, coalesce(e.repeat_until, p_to)) end,
      interval '1 day'
    ) g
  ) d
  where e.household_id = p_household_id
    and (p_event_id is null or e.id = p_event_id)
    and e.deleted_at is null
    and (e.repeat_days is null or extract(isodow from d.day)::smallint = any (e.repeat_days))
$$;

-- An event's definition as JSON (its next occurrence, if any, is added by callers).
create or replace function private.event_json(p_event public.events)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'event_id', p_event.id,
    'title', p_event.title,
    'label', coalesce(p_event.label, p_event.title),
    'starts_on', p_event.starts_on,
    'start_time', p_event.start_time,
    'duration_minutes', p_event.duration_minutes,
    'place', p_event.place,
    'visitor_name', p_event.visitor_name,
    'notes', p_event.notes,
    'repeat_days', p_event.repeat_days,
    'repeat_until', p_event.repeat_until,
    'created_via', p_event.created_via,
    'cancelled', p_event.deleted_at is not null
  )
$$;

-- One occurrence as JSON for the agent, the day view and the apps: the event's
-- definition plus the occurrence's local date and instants.
create or replace function private.occurrence_json(
  p_event public.events,
  p_local_date date,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.event_json(p_event)
    || jsonb_build_object('local_date', p_local_date, 'starts_at', p_starts_at, 'ends_at', p_ends_at)
$$;

-- Occurrences between two local dates as a JSON array, earliest first.
create or replace function private.occurrences_json(p_household_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(private.occurrence_json(e, o.local_date, o.starts_at, o.ends_at)
                            order by o.starts_at), '[]'::jsonb)
  from private.event_occurrences(p_household_id, p_from, p_to) o
  join public.events e on e.id = o.event_id
$$;

-- "morning" (5-12), "afternoon" (12-17), "evening" (17-21) or "night".
create or replace function private.part_of_day(p_time time)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_time >= '05:00' and p_time < '12:00' then 'morning'
    when p_time >= '12:00' and p_time < '17:00' then 'afternoon'
    when p_time >= '17:00' and p_time < '21:00' then 'evening'
    else 'night'
  end
$$;

-- ---------------------------------------------------------------------------
-- Calendar RPCs (one write path for agent, caregiver app and voice)
-- ---------------------------------------------------------------------------

-- Raise unless the caller is the backend or a caregiver who can edit the household.
create or replace function private.assert_calendar_editor(p_household_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (private.is_backend() or private.can_edit(p_household_id)) then
    raise exception 'Not allowed to change this household''s calendar' using errcode = '42501';
  end if;
end;
$$;

-- Raise unless the caller is the backend or belongs to the household (caregiver or
-- paired device).
create or replace function private.assert_household_reader(p_household_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (private.is_backend() or p_household_id in (select private.my_household_ids())) then
    raise exception 'Not allowed to read this household' using errcode = '42501';
  end if;
end;
$$;

-- Lock a live event for a change by an editor. The backend must name the household it
-- acts for, and the event must belong to it, so a service-role caller (the agent) can
-- never reach another household's events.
create or replace function private.lock_event(p_event_id uuid, p_household_id uuid)
returns public.events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.events;
begin
  if private.is_backend() and p_household_id is null then
    raise exception 'The backend must name the household' using errcode = '22023';
  end if;
  select * into v_event from public.events
  where id = p_event_id and deleted_at is null
    and (p_household_id is null or household_id = p_household_id)
  for update;
  if not found then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  perform private.assert_calendar_editor(v_event.household_id);
  return v_event;
end;
$$;

-- Raise when a one-off event would start in the past, when a repeat ends in the past, or
-- when a weekly repeat has no date at all (its first matching weekday is after
-- repeat_until). Times are household-local.
create or replace function private.assert_event_not_past(p_event public.events, p_now timestamptz)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text := (select timezone from public.households where id = p_event.household_id);
begin
  if p_event.repeat_days is null
     and ((p_event.starts_on + p_event.start_time) at time zone v_tz) < p_now then
    raise exception 'That time has already passed' using errcode = '22023';
  end if;
  if p_event.repeat_until is not null
     and p_event.repeat_until < (p_now at time zone v_tz)::date then
    raise exception 'The repeat end date has already passed' using errcode = '22023';
  end if;
  if p_event.repeat_days is not null and p_event.repeat_until is not null and not exists (
    select 1 from generate_series(p_event.starts_on, p_event.repeat_until, interval '1 day') d
    where extract(isodow from d)::smallint = any (p_event.repeat_days)
  ) then
    raise exception 'The repeat has no dates between its start and end' using errcode = '22023';
  end if;
end;
$$;

-- An event's JSON plus its next occurrence within 400 days (null when none).
create or replace function private.event_with_next(p_event public.events, p_now timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.event_json(p_event) || jsonb_build_object('next_occurrence', (
    select jsonb_build_object('local_date', o.local_date, 'starts_at', o.starts_at)
    from public.households h
    cross join lateral private.event_occurrences(
      h.id, (p_now at time zone h.timezone)::date, (p_now at time zone h.timezone)::date + 400, p_event.id
    ) o
    where h.id = p_event.household_id and o.starts_at >= p_now
    order by o.starts_at
    limit 1
  ))
$$;

-- Add an event. One-off on p_on_date, or weekly on p_repeat_days (ISO weekdays) from
-- p_on_date until p_repeat_until. Times are household-local. Returns the event as JSON
-- with its next occurrence.
create or replace function public.add_event(
  p_household_id uuid,
  p_title text,
  p_on_date date,
  p_start_time time,
  p_duration_minutes integer default null,
  p_place text default null,
  p_notes text default null,
  p_visitor_name text default null,
  p_label text default null,
  p_repeat_days smallint[] default null,
  p_repeat_until date default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.clock(p_now);
  v_event public.events;
begin
  perform private.assert_calendar_editor(p_household_id);
  v_event.household_id := p_household_id;
  v_event.title := trim(p_title);
  v_event.label := nullif(trim(p_label), '');
  v_event.place := nullif(trim(p_place), '');
  v_event.notes := nullif(trim(p_notes), '');
  v_event.visitor_name := nullif(trim(p_visitor_name), '');
  v_event.starts_on := p_on_date;
  v_event.start_time := p_start_time;
  v_event.duration_minutes := p_duration_minutes;
  v_event.repeat_days := (select array_agg(distinct d order by d) from unnest(p_repeat_days) d);
  v_event.repeat_until := p_repeat_until;
  perform private.assert_event_not_past(v_event, v_now);

  insert into public.events (
    household_id, title, place, visitor_name, notes, label,
    starts_on, start_time, duration_minutes, repeat_days, repeat_until
  )
  values (
    v_event.household_id, v_event.title, v_event.place, v_event.visitor_name, v_event.notes,
    v_event.label, v_event.starts_on, v_event.start_time, v_event.duration_minutes,
    v_event.repeat_days, v_event.repeat_until
  )
  returning * into v_event;
  return private.event_with_next(v_event, v_now);
end;
$$;

-- Change an event. p_changes may hold: title, label, on_date, start_time,
-- duration_minutes, place, notes, visitor_name, repeat_days (null makes it one-off),
-- repeat_until. Keys not given are unchanged; a key given as null clears the field.
-- Backend callers pass the household they act for (p_household_id).
create or replace function public.update_event(
  p_event_id uuid,
  p_changes jsonb,
  p_now timestamptz default now(),
  p_household_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.clock(p_now);
  v_event public.events;
  v_bad text;
begin
  v_event := private.lock_event(p_event_id, p_household_id);

  select string_agg(k, ', ') into v_bad
  from jsonb_object_keys(coalesce(p_changes, '{}')) k
  where k not in ('title', 'label', 'on_date', 'start_time', 'duration_minutes', 'place',
                  'notes', 'visitor_name', 'repeat_days', 'repeat_until');
  if v_bad is not null then
    raise exception 'Unknown event fields: %', v_bad using errcode = '22023';
  end if;

  if p_changes ? 'title' then v_event.title := trim(p_changes ->> 'title'); end if;
  if p_changes ? 'label' then v_event.label := nullif(trim(p_changes ->> 'label'), ''); end if;
  if p_changes ? 'on_date' then v_event.starts_on := (p_changes ->> 'on_date')::date; end if;
  if p_changes ? 'start_time' then v_event.start_time := (p_changes ->> 'start_time')::time; end if;
  if p_changes ? 'duration_minutes' then
    v_event.duration_minutes := (p_changes ->> 'duration_minutes')::integer;
  end if;
  if p_changes ? 'place' then v_event.place := nullif(trim(p_changes ->> 'place'), ''); end if;
  if p_changes ? 'notes' then v_event.notes := nullif(trim(p_changes ->> 'notes'), ''); end if;
  if p_changes ? 'visitor_name' then
    v_event.visitor_name := nullif(trim(p_changes ->> 'visitor_name'), '');
  end if;
  if p_changes ? 'repeat_days' then
    v_event.repeat_days := case when jsonb_typeof(p_changes -> 'repeat_days') = 'array' then (
      select array_agg(distinct d::smallint order by d::smallint)
      from jsonb_array_elements_text(p_changes -> 'repeat_days') d
    ) end;
  end if;
  if p_changes ? 'repeat_until' then v_event.repeat_until := (p_changes ->> 'repeat_until')::date; end if;

  if p_changes ?| array['on_date', 'start_time', 'repeat_days', 'repeat_until'] then
    perform private.assert_event_not_past(v_event, v_now);
  end if;

  update public.events
  set title = v_event.title, label = v_event.label, starts_on = v_event.starts_on,
      start_time = v_event.start_time, duration_minutes = v_event.duration_minutes,
      place = v_event.place, notes = v_event.notes, visitor_name = v_event.visitor_name,
      repeat_days = v_event.repeat_days, repeat_until = v_event.repeat_until
  where id = v_event.id
  returning * into v_event;
  return private.event_with_next(v_event, v_now);
end;
$$;

-- Cancel an event (soft delete, so the cancellation syncs to Google). Backend callers
-- pass the household they act for.
create or replace function public.cancel_event(p_event_id uuid, p_household_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.events := private.lock_event(p_event_id, p_household_id);
begin
  update public.events set deleted_at = now() where id = v_event.id returning * into v_event;
  return private.event_json(v_event);
end;
$$;

-- Occurrences between two local dates (inclusive, at most 92 days) for anyone in the
-- household or the backend.
create or replace function public.list_events(p_household_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_household_reader(p_household_id);
  if p_to < p_from or p_to - p_from > 92 then
    raise exception 'Date range must be 0 to 92 days' using errcode = '22023';
  end if;
  return private.occurrences_json(p_household_id, p_from, p_to);
end;
$$;

-- The day clock for every surface: local date and part of day, today's tasks and
-- events, Next up (the next event within 7 days that has not ended; events without a
-- duration count as 30 minutes), and the coming week. Occurrences are expanded once.
create or replace function public.get_day_view(p_household_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.clock(p_now);
  v_household public.households;
  v_local timestamp;
  v_today date;
  v_week jsonb;
begin
  perform private.assert_household_reader(p_household_id);
  select * into v_household from public.households where id = p_household_id;
  v_local := v_now at time zone v_household.timezone;
  v_today := v_local::date;

  select coalesce(jsonb_agg(private.occurrence_json(e, o.local_date, o.starts_at, o.ends_at)
                            || jsonb_build_object('_live', coalesce(o.ends_at, o.starts_at + interval '30 minutes') > v_now)
                            order by o.starts_at), '[]'::jsonb)
  into v_week
  from private.event_occurrences(p_household_id, v_today, v_today + 7) o
  join public.events e on e.id = o.event_id;

  return jsonb_build_object(
    'senior_preferred_name', v_household.senior_preferred_name,
    'timezone', v_household.timezone,
    'local_now', v_local,
    'local_date', v_today,
    'weekday', to_char(v_today, 'FMDay'),
    'date_label', to_char(v_today, 'FMMonth FMDD'),
    'header', to_char(v_today, 'FMDay') || ' ' || private.part_of_day(v_local::time),
    'tasks', private.today_json(p_household_id, v_now),
    'events_today', coalesce((
      select jsonb_agg(x - '_live') from jsonb_array_elements(v_week) x
      where (x ->> 'local_date')::date = v_today
    ), '[]'::jsonb),
    'next_up', (
      select x - '_live' from jsonb_array_elements(v_week) with ordinality w (x, n)
      where (x ->> '_live')::boolean
      order by n
      limit 1
    ),
    'upcoming', coalesce((
      select jsonb_agg(x - '_live') from jsonb_array_elements(v_week) x
      where (x ->> 'local_date')::date > v_today
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Day-of event notices
-- ---------------------------------------------------------------------------

alter table public.notification_outbox
  add column event_id uuid references public.events (id) on delete cascade;
create index notification_outbox_event_idx on public.notification_outbox (event_id);

-- Occurrences already announced (one notice per event per local date).
create table public.event_notices (
  event_id uuid not null references public.events (id) on delete cascade,
  local_date date not null,
  created_at timestamptz not null default now(),
  primary key (event_id, local_date)
);

alter table public.event_notices enable row level security;

-- Queue a day-of notice for every caregiver, once per occurrence, from the household's
-- event_notice_time until the event starts. An event added after that time the same day
-- is announced on the next tick. Returns the number of occurrences announced.
create or replace function public.event_notice_tick(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.assert_backend();
  perform pg_advisory_xact_lock(hashtext('sunny.event_notice_tick'));

  with due as (
    select h.id as household_id, h.senior_preferred_name, e.id as event_id, e.title, e.place,
           o.local_date, o.starts_at, e.start_time
    from public.households h
    cross join lateral private.event_occurrences(
      h.id, (p_now at time zone h.timezone)::date, (p_now at time zone h.timezone)::date
    ) o
    join public.events e on e.id = o.event_id
    where (p_now at time zone h.timezone)::time >= h.event_notice_time
      and o.starts_at > p_now
      -- Only households with a live event that could fall today are expanded.
      and exists (
        select 1 from public.events c
        where c.household_id = h.id and c.deleted_at is null
          and c.starts_on <= (p_now at time zone h.timezone)::date
          and (c.repeat_days is not null or c.starts_on = (p_now at time zone h.timezone)::date)
          and (c.repeat_until is null or c.repeat_until >= (p_now at time zone h.timezone)::date)
      )
      and not exists (
        select 1 from public.event_notices n where n.event_id = o.event_id and n.local_date = o.local_date
      )
  ),
  marked as (
    insert into public.event_notices (event_id, local_date)
    select event_id, local_date from due
    on conflict do nothing
    returning event_id, local_date
  ),
  queued as (
    insert into public.notification_outbox (
      household_id, kind, event_id, recipient_user_id, title, body, payload
    )
    select d.household_id, 'event_notice', d.event_id, m.user_id,
           'Today: ' || d.title || ' at ' || private.format_time(d.start_time),
           d.senior_preferred_name || ' has ' || d.title || ' at '
             || private.format_time(d.start_time) || ' today'
             || coalesce(' at ' || d.place, '') || '.',
           jsonb_build_object('event_id', d.event_id, 'local_date', d.local_date)
    from marked k
    join due d on d.event_id = k.event_id and d.local_date = k.local_date
    join public.household_members m on m.household_id = d.household_id
    returning 1
  )
  select count(*) into v_count from marked;
  return v_count;
end;
$$;

select cron.schedule('sunny-event-notices', '* * * * *', 'select public.event_notice_tick()');

-- ---------------------------------------------------------------------------
-- Google Calendar connections
-- ---------------------------------------------------------------------------

create type public.calendar_connection_status as enum ('active', 'revoked', 'error');

create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'google' check (provider = 'google'),
  account_email text,
  -- The Sunny-owned calendar created in the caregiver's account.
  external_calendar_id text not null,
  -- vault.secrets id of the OAuth refresh token; the token itself never leaves Vault
  -- except through get_calendar_credentials (backend only).
  refresh_token_secret_id uuid not null,
  status public.calendar_connection_status not null default 'active',
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, user_id, provider)
);

create index calendar_connections_user_idx on public.calendar_connections (user_id);

create trigger calendar_connections_updated_at before update on public.calendar_connections
  for each row execute function private.set_updated_at();

-- Our event to the Google event, per connection.
create table public.calendar_event_links (
  event_id uuid not null references public.events (id) on delete cascade,
  connection_id uuid not null references public.calendar_connections (id) on delete cascade,
  external_event_id text not null,
  etag text,
  synced_at timestamptz not null default now(),
  primary key (event_id, connection_id)
);

create index calendar_event_links_connection_idx on public.calendar_event_links (connection_id);

alter table public.calendar_connections enable row level security;
alter table public.calendar_event_links enable row level security;

-- Caregivers see and remove their own connections; links are backend only.
create policy calendar_connections_select_own on public.calendar_connections for select to authenticated
  using (user_id = (select auth.uid()));
create policy calendar_connections_delete_own on public.calendar_connections for delete to authenticated
  using (user_id = (select auth.uid()));

-- Removing a connection removes its refresh token from Vault.
create or replace function private.delete_connection_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.refresh_token_secret_id;
  return old;
end;
$$;

create trigger calendar_connections_delete_secret after delete on public.calendar_connections
  for each row execute function private.delete_connection_secret();

-- Queue a push of one event to one connection; repeats merge while queued.
create or replace function private.queue_calendar_sync(
  p_household_id uuid,
  p_event_id uuid,
  p_connection_id uuid
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select private.enqueue_job(
    p_household_id,
    'calendar_sync_event',
    jsonb_build_object('event_id', p_event_id, 'connection_id', p_connection_id),
    'calendar_sync_event:' || p_event_id || ':' || p_connection_id
  )
$$;

-- Queue a push of a changed event to every active connection of its household. Updates
-- that change nothing but updated_at are skipped.
create or replace function private.queue_event_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and to_jsonb(old) - 'updated_at' = to_jsonb(new) - 'updated_at' then
    return new;
  end if;
  perform private.queue_calendar_sync(new.household_id, new.id, c.id)
  from public.calendar_connections c
  where c.household_id = new.household_id and c.status = 'active';
  return new;
end;
$$;

create trigger events_queue_sync after insert or update on public.events
  for each row execute function private.queue_event_sync();

-- Save a caregiver's Google connection after OAuth (backend only): stores the refresh
-- token in Vault, (re)activates the connection and queues a push of every live event
-- (and of cancelled events still linked to it).
-- Returns the connection id.
create or replace function public.save_calendar_connection(
  p_household_id uuid,
  p_user_id uuid,
  p_account_email text,
  p_external_calendar_id text,
  p_refresh_token text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection public.calendar_connections;
  v_secret_id uuid;
begin
  perform private.assert_backend();
  if not exists (
    select 1 from public.household_members where household_id = p_household_id and user_id = p_user_id
  ) then
    raise exception 'Not a caregiver in this household' using errcode = '42501';
  end if;

  select * into v_connection from public.calendar_connections
  where household_id = p_household_id and user_id = p_user_id and provider = 'google'
  for update;

  if found then
    perform vault.update_secret(v_connection.refresh_token_secret_id, p_refresh_token);
    -- A different calendar means the old links point nowhere.
    if v_connection.external_calendar_id is distinct from p_external_calendar_id then
      delete from public.calendar_event_links where connection_id = v_connection.id;
    end if;
    update public.calendar_connections
    set account_email = p_account_email, external_calendar_id = p_external_calendar_id,
        status = 'active', last_error = null
    where id = v_connection.id
    returning * into v_connection;
  else
    v_secret_id := vault.create_secret(
      p_refresh_token, 'gcal-refresh-' || gen_random_uuid(), 'Google Calendar refresh token'
    );
    insert into public.calendar_connections (
      household_id, user_id, account_email, external_calendar_id, refresh_token_secret_id
    )
    values (p_household_id, p_user_id, p_account_email, p_external_calendar_id, v_secret_id)
    returning * into v_connection;
  end if;

  -- Every live event, plus cancelled ones Google may still show (linked to this
  -- connection, e.g. cancelled while the connection was revoked).
  perform private.queue_calendar_sync(p_household_id, e.id, v_connection.id)
  from public.events e
  where e.household_id = p_household_id
    and (e.deleted_at is null or exists (
      select 1 from public.calendar_event_links l where l.event_id = e.id and l.connection_id = v_connection.id
    ));

  return v_connection.id;
end;
$$;

-- A connection with its refresh token, for jobs-run (backend only). Null unless the
-- caregiver is still a member of the household.
create or replace function public.get_calendar_credentials(p_connection_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_backend();
  return (
    select jsonb_build_object(
      'connection_id', c.id,
      'household_id', c.household_id,
      'user_id', c.user_id,
      'external_calendar_id', c.external_calendar_id,
      'status', c.status,
      'refresh_token', s.decrypted_secret
    )
    from public.calendar_connections c
    join vault.decrypted_secrets s on s.id = c.refresh_token_secret_id
    where c.id = p_connection_id
      and exists (
        select 1 from public.household_members m
        where m.household_id = c.household_id and m.user_id = c.user_id
      )
  );
end;
$$;

-- One event in Google Calendar's terms for a connection (backend only): local start and
-- end in the household timezone, a weekly RRULE (DTSTART moved to the first matching
-- weekday, UNTIL in UTC at the end of the last local day), the popup reminder minutes
-- that land on event_notice_time the same day (60 when the event starts earlier), and
-- the existing Google event id, if linked.
create or replace function public.get_event_sync_payload(p_event_id uuid, p_connection_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_event public.events;
  v_household public.households;
  v_first date;
  v_minutes integer;
begin
  perform private.assert_backend();
  select * into v_event from public.events where id = p_event_id;
  if not found then
    return null;
  end if;
  select * into v_household from public.households where id = v_event.household_id;

  v_first := case when v_event.repeat_days is null then v_event.starts_on else (
    select min(d)::date from generate_series(v_event.starts_on, v_event.starts_on + 6, interval '1 day') d
    where extract(isodow from d)::smallint = any (v_event.repeat_days)
  ) end;
  v_minutes := (extract(epoch from v_event.start_time - v_household.event_notice_time) / 60)::integer;

  return jsonb_build_object(
    'event_id', v_event.id,
    'household_id', v_event.household_id,
    'cancelled', v_event.deleted_at is not null,
    'title', v_event.title,
    'place', v_event.place,
    'notes', v_event.notes,
    'visitor_name', v_event.visitor_name,
    'label', coalesce(v_event.label, v_event.title),
    'senior_preferred_name', v_household.senior_preferred_name,
    'time_zone', v_household.timezone,
    'start_local', to_char(v_first + v_event.start_time, 'YYYY-MM-DD"T"HH24:MI:SS'),
    'end_local', to_char(v_first + v_event.start_time
                         + make_interval(mins => coalesce(v_event.duration_minutes, 60)),
                         'YYYY-MM-DD"T"HH24:MI:SS'),
    'rrule', case when v_event.repeat_days is not null then
      'RRULE:FREQ=WEEKLY;BYDAY=' || (
        select string_agg((array['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])[d], ',' order by d)
        from unnest(v_event.repeat_days) d
      ) || coalesce(';UNTIL=' || to_char(
        ((v_event.repeat_until + time '23:59:59') at time zone v_household.timezone) at time zone 'UTC',
        'YYYYMMDD"T"HH24MISS"Z"'), '')
    end,
    'reminder_minutes', case when v_minutes > 0 then v_minutes else 60 end,
    'external_event_id', (
      select l.external_event_id from public.calendar_event_links l
      where l.event_id = v_event.id and l.connection_id = p_connection_id
    )
  );
end;
$$;

-- Mark a connection revoked or in error (backend only), e.g. after invalid_grant.
create or replace function public.set_calendar_connection_status(
  p_connection_id uuid,
  p_status public.calendar_connection_status,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_backend();
  update public.calendar_connections
  set status = p_status, last_error = left(p_error, 2000)
  where id = p_connection_id;
end;
$$;

-- A caregiver removed from the household loses their Google connection (and with it the
-- refresh token), so their calendar stops receiving the household's events.
create or replace function private.drop_member_connections()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.calendar_connections
  where household_id = old.household_id and user_id = old.user_id;
  return old;
end;
$$;

create trigger household_members_drop_connections after delete on public.household_members
  for each row execute function private.drop_member_connections();

-- The household's timezone, notice time and name shape every Google event (time zone,
-- reminder minutes, description), so changing them re-pushes every live event.
create or replace function private.resync_household_calendars()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.queue_calendar_sync(new.id, e.id, c.id)
  from public.calendar_connections c
  join public.events e on e.household_id = c.household_id and e.deleted_at is null
  where c.household_id = new.id and c.status = 'active';
  return new;
end;
$$;

create trigger households_resync_calendars
  after update of timezone, event_notice_time, senior_preferred_name on public.households
  for each row
  when (old.timezone is distinct from new.timezone
        or old.event_notice_time is distinct from new.event_notice_time
        or old.senior_preferred_name is distinct from new.senior_preferred_name)
  execute function private.resync_household_calendars();

-- ---------------------------------------------------------------------------
-- Agent context reads the new event shape
-- ---------------------------------------------------------------------------

-- Same as 20261025000400 except 'events': occurrences in the next 7 days that have not
-- ended, keyed as before (title, starts_at, ends_at, place, visitor_name, notes) plus label.
create or replace function public.get_agent_context(
  p_household_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with h as (
    select *,
           (p_now at time zone timezone) as local_now,
           ((p_now at time zone timezone)::date)::timestamp at time zone timezone as local_midnight
    from public.households
    where id = p_household_id and private.is_backend()
  )
  select jsonb_build_object(
    'household', jsonb_build_object(
      'id', h.id,
      'senior_preferred_name', h.senior_preferred_name,
      'timezone', h.timezone,
      'local_now', h.local_now
    ),
    'today', private.today_json(h.id, p_now),
    'as_needed', coalesce((
      select jsonb_agg(jsonb_build_object(
        'task_id', t.id,
        'display_label', t.display_label,
        'pill_description', t.pill_description,
        'max_per_day', t.as_needed_max_per_day,
        'min_hours_between', t.as_needed_min_hours,
        'taken_today', coalesce((
          select jsonb_agg(d.taken_at order by d.taken_at)
          from public.dose_log d
          where d.household_id = h.id and d.task_id = t.id and d.taken_at >= h.local_midnight
        ), '[]'::jsonb)
      ))
      from public.tasks t
      where t.household_id = h.id and t.active
        and (t.as_needed_max_per_day is not null or t.as_needed_min_hours is not null)
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'title', e.title, 'label', coalesce(e.label, e.title),
        'starts_at', o.starts_at, 'ends_at', o.ends_at,
        'place', e.place, 'visitor_name', e.visitor_name, 'notes', e.notes
      ) order by o.starts_at)
      from private.event_occurrences(h.id, h.local_now::date, h.local_now::date + 7) o
      join public.events e on e.id = o.event_id
      where coalesce(o.ends_at, o.starts_at) >= p_now
        and o.starts_at < p_now + interval '7 days'
    ), '[]'::jsonb),
    'latest_message', (
      select jsonb_build_object(
        'from', coalesce(m.display_name, 'family'), 'body', fm.body,
        'has_photo', fm.photo_path is not null, 'sent_at', fm.created_at, 'seen', fm.seen_at is not null
      )
      from public.family_messages fm
      left join public.household_members m
        on m.household_id = fm.household_id and m.user_id = fm.sender_user_id
      where fm.household_id = h.id and fm.sender_kind = 'caregiver'
      order by fm.created_at desc
      limit 1
    ),
    'life_profile', coalesce((
      select jsonb_agg(jsonb_build_object('category', l.category, 'name', l.name, 'details', l.details)
                       order by l.category, l.name)
      from public.life_profile_entries l where l.household_id = h.id
    ), '[]'::jsonb),
    'sensitive_topics', coalesce((
      select jsonb_agg(jsonb_build_object('topic', s.topic, 'guidance', s.guidance))
      from public.sensitive_topics s where s.household_id = h.id
    ), '[]'::jsonb),
    'memory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'fact', x.fact, 'source', x.source, 'verified', x.verified_at is not null, 'noted_at', x.created_at
      ))
      from (
        select a.* from public.agent_memory a
        where a.household_id = h.id
        order by a.verified_at is not null desc, a.created_at desc
        limit 50
      ) x
    ), '[]'::jsonb),
    'recent_conversations', coalesce((
      select jsonb_agg(jsonb_build_object('started_at', c.started_at, 'summary', c.summary))
      from (
        select c.* from public.conversations c
        where c.household_id = h.id and c.summary is not null
        order by c.started_at desc
        limit 5
      ) c
    ), '[]'::jsonb)
  )
  from h
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.add_event(uuid, text, date, time, integer, text, text, text, text, smallint[], date, timestamptz) from public, anon;
revoke execute on function public.update_event(uuid, jsonb, timestamptz, uuid) from public, anon;
revoke execute on function public.cancel_event(uuid, uuid) from public, anon;
revoke execute on function public.list_events(uuid, date, date) from public, anon;
revoke execute on function public.get_day_view(uuid, timestamptz) from public, anon;
revoke execute on function public.event_notice_tick(timestamptz) from public, anon, authenticated;
revoke execute on function public.save_calendar_connection(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.get_calendar_credentials(uuid) from public, anon, authenticated;
revoke execute on function public.get_event_sync_payload(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.set_calendar_connection_status(uuid, public.calendar_connection_status, text) from public, anon, authenticated;
revoke execute on function public.get_agent_context(uuid, timestamptz) from public, anon, authenticated;

grant execute on function public.add_event(uuid, text, date, time, integer, text, text, text, text, smallint[], date, timestamptz) to authenticated, service_role;
grant execute on function public.update_event(uuid, jsonb, timestamptz, uuid) to authenticated, service_role;
grant execute on function public.cancel_event(uuid, uuid) to authenticated, service_role;
grant execute on function public.list_events(uuid, date, date) to authenticated, service_role;
grant execute on function public.get_day_view(uuid, timestamptz) to authenticated, service_role;
grant execute on function public.event_notice_tick(timestamptz) to service_role;
grant execute on function public.save_calendar_connection(uuid, uuid, text, text, text) to service_role;
grant execute on function public.get_calendar_credentials(uuid) to service_role;
grant execute on function public.get_event_sync_payload(uuid, uuid) to service_role;
grant execute on function public.set_calendar_connection_status(uuid, public.calendar_connection_status, text) to service_role;
grant execute on function public.get_agent_context(uuid, timestamptz) to service_role;

-- The private helpers added in this and the jobs migration are backend-only: RPCs and
-- triggers (which run as their owner) call them; the API roles never may.
do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = any (array[
      'assert_backend', 'vault_secret', 'dispatch_jobs', 'dispatch_new_jobs', 'enqueue_job',
      'running_job', 'requeue_job', 'record_failure',
      'set_event_created_via', 'audit_event', 'event_occurrences', 'event_json',
      'occurrence_json', 'occurrences_json', 'part_of_day', 'assert_calendar_editor',
      'assert_household_reader', 'lock_event', 'assert_event_not_past', 'event_with_next',
      'queue_calendar_sync', 'queue_event_sync', 'delete_connection_secret',
      'drop_member_connections', 'resync_household_calendars'
    ])
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', v_fn);
  end loop;
end;
$$;
