-- 20261025000100_households.sql
-- Purpose: Household identity for the memory-care POC. Creates households (senior
-- profile, timezone, on-call caregiver, digest and sharing preferences), caregiver
-- membership with roles, paired senior devices (phone, home display), push tokens,
-- and one-time join codes used both to pair devices and to invite caregivers.
-- Also creates the private helper functions every RLS policy uses to resolve the
-- signed-in user (caregiver or paired device) to a household. See notes/SCHEMA.md.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Validate an IANA region timezone ("America/New_York"). Abbreviations and POSIX
-- strings ("EST", "PST8PDT") are rejected because they do not follow local DST rules.
-- Marked immutable so it can back a CHECK; the timezone database only changes on
-- Postgres upgrades.
create or replace function private.is_valid_timezone(tz text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select tz like '%/%' and exists (select 1 from pg_catalog.pg_timezone_names where name = tz)
$$;

-- Keep updated_at current on every UPDATE.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.member_role as enum ('primary', 'member', 'viewer');
create type public.device_kind as enum ('senior_phone', 'home_display');
create type public.join_grant as enum (
  'senior_phone', 'home_display', 'caregiver_primary', 'caregiver_member', 'caregiver_viewer'
);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.households (
  id uuid primary key default gen_random_uuid(),
  senior_preferred_name text not null check (length(trim(senior_preferred_name)) > 0),
  senior_full_name text,
  timezone text not null default 'America/New_York'
    check (private.is_valid_timezone(timezone)),
  photo_path text,
  on_call_user_id uuid,
  digest_time time not null default '19:00',
  -- Sharing preferences agreed at onboarding: caregivers see full transcripts only if true.
  share_transcripts boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'member',
  display_name text not null check (length(trim(display_name)) > 0),
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create index household_members_user_idx on public.household_members (user_id);

-- The on-call caregiver must be a member of the same household.
alter table public.households
  add constraint households_on_call_member_fk
  foreign key (id, on_call_user_id)
  references public.household_members (household_id, user_id)
  on delete set null (on_call_user_id);

-- Senior-side devices. user_id is the anonymous auth user the device signed in as.
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  kind public.device_kind not null,
  name text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create index devices_household_idx on public.devices (household_id);

-- APNs device tokens for any signed-in user (caregiver app installs and senior phones).
-- Delivery details (environment, Live Activity tokens) arrive with the push sender.
create table public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token text not null unique,
  updated_at timestamptz not null default now()
);

create index push_tokens_user_idx on public.push_tokens (user_id);

create table public.join_codes (
  code text primary key check (code ~ '^[A-Z0-9]{8}$'),
  household_id uuid not null references public.households (id) on delete cascade,
  grants public.join_grant not null,
  created_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default now() + interval '24 hours',
  redeemed_by uuid references auth.users (id) on delete set null,
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);

create index join_codes_household_idx on public.join_codes (household_id);

create trigger households_updated_at before update on public.households
  for each row execute function private.set_updated_at();
create trigger household_members_updated_at before update on public.household_members
  for each row execute function private.set_updated_at();
create trigger push_tokens_updated_at before update on public.push_tokens
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Access helpers (security definer so RLS policies can call them without
-- recursing into the policies of the tables they read)
-- ---------------------------------------------------------------------------

-- Households the signed-in user can see: as a caregiver or as a paired device.
create or replace function private.my_household_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select household_id from public.household_members where user_id = (select auth.uid())
  union
  select household_id from public.devices where user_id = (select auth.uid())
$$;

-- True when the signed-in user is a caregiver in the household with one of the roles.
create or replace function private.is_caregiver(
  p_household_id uuid,
  p_roles public.member_role[] default array['primary', 'member', 'viewer']::public.member_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.household_members
    where household_id = p_household_id
      and user_id = (select auth.uid())
      and role = any (p_roles)
  )
$$;

-- True when the signed-in user may change household data (primary or member).
create or replace function private.can_edit(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_caregiver(p_household_id, array['primary', 'member']::public.member_role[])
$$;

-- The paired device row for the signed-in user, if the user is a senior device.
create or replace function private.my_device()
returns public.devices
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.devices where user_id = (select auth.uid())
$$;

-- True when the request comes from the backend rather than an end user: the service
-- role (the agent, Edge Functions) or a direct database session that is not the API's
-- connection role and carries no JWT (pg_cron, migrations, tests). API requests always
-- connect as 'authenticator', so a missing or malformed claim never counts as backend.
create or replace function private.is_backend()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'role', '') = 'service_role'
      or (session_user <> 'authenticator' and (select auth.jwt()) is null)
$$;

-- True when the signed-in user is an anonymous Supabase Auth user (a senior device).
create or replace function private.is_anonymous()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
$$;

-- The time a write should record: backend callers (agent, scheduler, tests) may pass
-- their own clock; end users always get the server clock.
create or replace function private.clock(p_now timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case when private.is_backend() then p_now else now() end
$$;

-- Raise unless the caller acts for the senior of this household: the backend (agent)
-- or one of the household's paired devices. Written with EXISTS so a caller without a
-- device yields false, never NULL (NOT NULL would silently skip the raise).
create or replace function private.assert_senior_access(p_household_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (
    private.is_backend()
    or exists (
      select 1 from public.devices
      where user_id = (select auth.uid()) and household_id = p_household_id
    )
  ) then
    raise exception 'Only the senior''s devices can do this' using errcode = '42501';
  end if;
end;
$$;

grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.devices enable row level security;
alter table public.push_tokens enable row level security;
alter table public.join_codes enable row level security;

create policy households_select on public.households for select to authenticated
  using (id in (select private.my_household_ids()));
create policy households_update on public.households for update to authenticated
  using (private.can_edit(id)) with check (private.can_edit(id));

create policy members_select on public.household_members for select to authenticated
  using (household_id in (select private.my_household_ids()));
create policy members_update_primary on public.household_members for update to authenticated
  using (private.is_caregiver(household_id, array['primary']::public.member_role[]))
  with check (private.is_caregiver(household_id, array['primary']::public.member_role[]));
create policy members_delete_primary_or_self on public.household_members for delete to authenticated
  using (
    private.is_caregiver(household_id, array['primary']::public.member_role[])
    or user_id = (select auth.uid())
  );

create policy devices_select on public.devices for select to authenticated
  using (household_id in (select private.my_household_ids()));
create policy devices_delete_editor on public.devices for delete to authenticated
  using (private.can_edit(household_id));

create policy push_tokens_own on public.push_tokens for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy join_codes_select_editor on public.join_codes for select to authenticated
  using (private.can_edit(household_id));
create policy join_codes_delete_editor on public.join_codes for delete to authenticated
  using (private.can_edit(household_id));

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Create a household with the caller as its primary caregiver and on-call contact.
-- Default escalation policies are seeded by a trigger in the tasks migration.
create or replace function public.create_household(
  p_senior_preferred_name text,
  p_timezone text,
  p_caregiver_display_name text
)
returns public.households
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_household public.households;
begin
  if v_uid is null or private.is_anonymous() then
    raise exception 'Only a signed-in caregiver can create a household' using errcode = '42501';
  end if;

  insert into public.households (senior_preferred_name, timezone)
  values (p_senior_preferred_name, p_timezone)
  returning * into v_household;

  insert into public.household_members (household_id, user_id, role, display_name)
  values (v_household.id, v_uid, 'primary', p_caregiver_display_name);

  update public.households set on_call_user_id = v_uid where id = v_household.id
  returning * into v_household;

  return v_household;
end;
$$;

-- Generate a one-time join code for pairing a device or inviting a caregiver: 8
-- characters from an unambiguous 32-letter alphabet, drawn from a cryptographic random
-- source (about 10^12 codes, valid 24 hours). Only primaries may invite another primary.
create or replace function public.create_join_code(p_household_id uuid, p_grants public.join_grant)
returns public.join_codes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  v_row public.join_codes;
begin
  if not private.can_edit(p_household_id)
     or (p_grants = 'caregiver_primary'
         and not private.is_caregiver(p_household_id, array['primary']::public.member_role[])) then
    raise exception 'Not allowed to create this join code' using errcode = '42501';
  end if;

  for v_attempt in 1..10 loop
    select string_agg(substr(v_alphabet, 1 + (get_byte(b.bytes, g) % 32), 1), '' order by g)
      into v_code
      from (select extensions.gen_random_bytes(8) as bytes) b, generate_series(0, 7) as g;
    begin
      insert into public.join_codes (code, household_id, grants, created_by)
      values (v_code, p_household_id, p_grants, (select auth.uid()))
      returning * into v_row;
      return v_row;
    exception when unique_violation then
      -- extremely unlikely collision; try another code
    end;
  end loop;
  raise exception 'Could not generate a unique join code' using errcode = '23505';
end;
$$;

-- Redeem a join code as the signed-in user. Device grants pair the caller (normally an
-- anonymous user) as a senior device; caregiver grants add the caller (must not be
-- anonymous) as a household member. Returns the household id.
create or replace function public.redeem_join_code(p_code text, p_display_name text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_code public.join_codes;
begin
  if v_uid is null then
    raise exception 'Sign in before redeeming a code' using errcode = '42501';
  end if;

  select * into v_code from public.join_codes
  where code = upper(trim(p_code))
  for update;

  if not found or v_code.redeemed_at is not null or v_code.expires_at <= now() then
    raise exception 'This code is invalid or has expired' using errcode = 'P0002';
  end if;

  if v_code.grants in ('senior_phone', 'home_display') then
    insert into public.devices (household_id, user_id, kind, name)
    values (v_code.household_id, v_uid, v_code.grants::text::public.device_kind, p_display_name);
  else
    if private.is_anonymous() then
      raise exception 'Caregivers must sign in with an account' using errcode = '42501';
    end if;
    insert into public.household_members (household_id, user_id, role, display_name)
    values (
      v_code.household_id,
      v_uid,
      replace(v_code.grants::text, 'caregiver_', '')::public.member_role,
      coalesce(nullif(trim(p_display_name), ''), 'Caregiver')
    );
  end if;

  update public.join_codes set redeemed_by = v_uid, redeemed_at = now() where code = v_code.code;
  return v_code.household_id;
end;
$$;

revoke execute on function public.create_household(text, text, text) from public, anon;
revoke execute on function public.create_join_code(uuid, public.join_grant) from public, anon;
revoke execute on function public.redeem_join_code(text, text) from public, anon;
grant execute on function public.create_household(text, text, text) to authenticated;
grant execute on function public.create_join_code(uuid, public.join_grant) to authenticated;
grant execute on function public.redeem_join_code(text, text) to authenticated;
