-- 20261025000400_agent_context.sql
-- Purpose: Everything the agent reads and writes besides tasks. Creates events
-- (appointments and visits, including who is coming), family messages, the
-- caregiver-owned life profile and sensitive-topic playbook, agent memory with source
-- and verification (verified once verified_at is set; senior-stated facts start
-- unverified), and the conversation log (conversations, turns, and per-question
-- topic/outcome/tools rows the digest counts repeats from). get_agent_context()
-- assembles one household's context for a voice session. See notes/SCHEMA.md.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.message_sender as enum ('caregiver', 'senior');
create type public.life_category as enum (
  'person', 'place', 'doctor', 'habit', 'interest', 'preference', 'other'
);
create type public.memory_source as enum ('caregiver', 'senior');
create type public.question_outcome as enum ('answered', 'routed', 'unsure');

-- ---------------------------------------------------------------------------
-- Events and family messages
-- ---------------------------------------------------------------------------

create table public.events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  starts_at timestamptz not null,
  ends_at timestamptz,
  place text,
  visitor_name text,
  notes text,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);

create index events_household_start_idx on public.events (household_id, starts_at);

create table public.family_messages (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  sender_kind public.message_sender not null,
  -- Caregiver who sent it; null when the senior sent it through the agent.
  sender_user_id uuid references auth.users (id) on delete set null,
  body text,
  photo_path text,
  audio_path text,
  seen_at timestamptz,
  created_at timestamptz not null default now(),
  check (num_nonnulls(body, photo_path, audio_path) > 0),
  check (sender_kind = 'senior' or sender_user_id is not null)
);

create index family_messages_household_idx on public.family_messages (household_id, created_at desc);

create trigger events_updated_at before update on public.events
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Life profile, sensitive topics, agent memory
-- ---------------------------------------------------------------------------

create table public.life_profile_entries (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  category public.life_category not null,
  -- e.g. "Sarah" (person), "Dr. Patel" (doctor), "Morning walk" (habit).
  name text not null check (length(trim(name)) > 0),
  details text,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index life_profile_household_idx on public.life_profile_entries (household_id, category);

-- Caregiver-written guidance for hard questions, e.g. "Where's my husband?".
create table public.sensitive_topics (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  topic text not null check (length(trim(topic)) > 0),
  guidance text not null check (length(trim(guidance)) > 0),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.agent_memory (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  fact text not null check (length(trim(fact)) > 0),
  source public.memory_source not null,
  -- Verified when verified_at is set; a senior-stated fact needs a caregiver in verified_by.
  verified_by uuid references auth.users (id) on delete set null,
  verified_at timestamptz,
  conversation_id uuid,
  created_at timestamptz not null default now(),
  check ((verified_at is null) or (verified_by is not null) or source = 'caregiver')
);

create index agent_memory_household_idx on public.agent_memory
  (household_id, (verified_at is not null) desc, created_at desc);

-- Memory hygiene for caregiver edits: a fact's source never changes, and verifying (or
-- re-verifying) always records the caregiver doing it, so "verified" cannot be spoofed.
create or replace function private.guard_memory_verification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.is_backend() then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.source is distinct from old.source then
    raise exception 'A remembered fact''s source cannot change' using errcode = '42501';
  end if;
  if new.source = 'caregiver' and tg_op = 'INSERT' then
    new.verified_at := coalesce(new.verified_at, now());
  end if;
  if new.verified_at is not null
     and (tg_op = 'INSERT' or new.verified_at is distinct from old.verified_at
          or new.verified_by is distinct from old.verified_by) then
    new.verified_at := now();
    new.verified_by := (select auth.uid());
  end if;
  return new;
end;
$$;

create trigger agent_memory_guard_verification before insert or update on public.agent_memory
  for each row execute function private.guard_memory_verification();

create trigger life_profile_updated_at before update on public.life_profile_entries
  for each row execute function private.set_updated_at();
create trigger sensitive_topics_updated_at before update on public.sensitive_topics
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Conversation log
-- ---------------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,
  -- 'talk' (Talk button), 'scheduled_prompt', 'notification_tap', ...
  trigger text not null default 'talk',
  task_instance_id uuid references public.task_instances (id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  summary text
);

create index conversations_household_idx on public.conversations (household_id, started_at desc);
create index conversations_instance_idx on public.conversations (task_instance_id);

alter table public.agent_memory
  add constraint agent_memory_conversation_fk
  foreign key (conversation_id) references public.conversations (id) on delete set null;

create table public.conversation_turns (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index conversation_turns_conversation_idx on public.conversation_turns (conversation_id, id);

-- One row per question the senior asked; the digest counts repeats by topic and day.
create table public.agent_questions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  asked_at timestamptz not null default now(),
  question text not null,
  -- Short normalized topic, e.g. "sarah visit time"; repeats share a topic.
  topic text not null,
  outcome public.question_outcome not null,
  tools_used text[] not null default '{}'
);

create index agent_questions_household_idx on public.agent_questions (household_id, asked_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.events enable row level security;
alter table public.family_messages enable row level security;
alter table public.life_profile_entries enable row level security;
alter table public.sensitive_topics enable row level security;
alter table public.agent_memory enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_turns enable row level security;
alter table public.agent_questions enable row level security;

-- Events and messages are shown on every surface.
create policy events_select on public.events for select to authenticated
  using (household_id in (select private.my_household_ids()));
create policy events_write on public.events for all to authenticated
  using (private.can_edit(household_id)) with check (private.can_edit(household_id));

create policy messages_select on public.family_messages for select to authenticated
  using (household_id in (select private.my_household_ids()));
create policy messages_insert_caregiver on public.family_messages for insert to authenticated
  with check (
    sender_kind = 'caregiver'
    and sender_user_id = (select auth.uid())
    and private.is_caregiver(household_id, array['primary', 'member']::public.member_role[])
  );

-- Life profile, playbook and memory are caregiver-managed; the agent reads them with
-- the service role. Viewers can read.
create policy life_profile_select on public.life_profile_entries for select to authenticated
  using (private.is_caregiver(household_id));
create policy life_profile_write on public.life_profile_entries for all to authenticated
  using (private.can_edit(household_id)) with check (private.can_edit(household_id));

create policy sensitive_topics_select on public.sensitive_topics for select to authenticated
  using (private.is_caregiver(household_id));
create policy sensitive_topics_write on public.sensitive_topics for all to authenticated
  using (private.can_edit(household_id)) with check (private.can_edit(household_id));

create policy memory_select on public.agent_memory for select to authenticated
  using (private.is_caregiver(household_id));
create policy memory_insert_caregiver on public.agent_memory for insert to authenticated
  with check (private.can_edit(household_id) and source = 'caregiver');
create policy memory_update_caregiver on public.agent_memory for update to authenticated
  using (private.can_edit(household_id)) with check (private.can_edit(household_id));
create policy memory_delete_caregiver on public.agent_memory for delete to authenticated
  using (private.can_edit(household_id));

-- Summaries, questions and transcripts all carry what the senior said, so caregivers
-- read them only if the senior agreed to share at onboarding. The digest reads them with
-- the service role and reports only topics and counts.
create policy conversations_select_if_shared on public.conversations for select to authenticated
  using (private.is_caregiver(household_id) and exists (
    select 1 from public.households h where h.id = household_id and h.share_transcripts
  ));
create policy questions_select_if_shared on public.agent_questions for select to authenticated
  using (private.is_caregiver(household_id) and exists (
    select 1 from public.households h where h.id = household_id and h.share_transcripts
  ));
create policy turns_select_if_shared on public.conversation_turns for select to authenticated
  using (exists (
    select 1 from public.conversations c
    join public.households h on h.id = c.household_id
    where c.id = conversation_id and h.share_transcripts and private.is_caregiver(c.household_id)
  ));

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Mark a family message as seen by the senior's device.
create or replace function public.mark_message_seen(p_message_id uuid)
returns public.family_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message public.family_messages;
begin
  update public.family_messages
  set seen_at = coalesce(seen_at, now())
  where id = p_message_id
    and household_id = (private.my_device()).household_id
    and sender_kind = 'caregiver'
  returning * into v_message;
  if not found then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  return v_message;
end;
$$;

-- Assemble a household's context for one voice session: senior profile and local time,
-- today's task instances, as-needed medications with today's doses, events for the next
-- 7 days, the latest family message, life profile, sensitive-topic playbook, memory
-- (caregiver-verified first, newest 50), and the last five conversation summaries.
-- Backend only: returns null for any other caller even if granted by mistake.
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
        'title', e.title, 'starts_at', e.starts_at, 'ends_at', e.ends_at,
        'place', e.place, 'visitor_name', e.visitor_name, 'notes', e.notes
      ) order by e.starts_at)
      from public.events e
      where e.household_id = h.id
        and coalesce(e.ends_at, e.starts_at) >= p_now
        and e.starts_at < p_now + interval '7 days'
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

revoke execute on function public.mark_message_seen(uuid) from public, anon;
grant execute on function public.mark_message_seen(uuid) to authenticated;
revoke execute on function public.get_agent_context(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.get_agent_context(uuid, timestamptz) to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.events, public.family_messages;
  end if;
end;
$$;
