-- calendar_jobs.test.sql
-- Purpose: pgTAP tests for the calendar and the background job queue: event writes and
-- who may make them, weekly repeats across the March 2027 DST change, the day view,
-- day-of event notices, Google connection storage and sync jobs, the Google payload
-- (RRULE, reminder minutes), and the job lifecycle (claim, fail with backoff, defer,
-- sweep, lease expiry, pause, caregiver agent requests).
-- Run with: supabase test db

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Fixtures: Mom (New York) with Pat (primary), Max (member), Val (viewer) and a paired
-- phone; Dad's household with Xen as an outsider.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role, is_anonymous) values
  ('11111111-1111-1111-1111-111111111111', 'pat@test.local', 'authenticated', 'authenticated', false),
  ('22222222-2222-2222-2222-222222222222', 'max@test.local', 'authenticated', 'authenticated', false),
  ('33333333-3333-3333-3333-333333333333', 'val@test.local', 'authenticated', 'authenticated', false),
  ('44444444-4444-4444-4444-444444444444', null, 'authenticated', 'authenticated', true),
  ('55555555-5555-5555-5555-555555555555', 'xen@test.local', 'authenticated', 'authenticated', false);

insert into public.households (id, senior_preferred_name, timezone) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Mom', 'America/New_York'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Dad', 'America/Chicago');

insert into public.household_members (household_id, user_id, role, display_name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'primary', 'Pat'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member', 'Max'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'viewer', 'Val'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '55555555-5555-5555-5555-555555555555', 'primary', 'Xen');

insert into public.devices (id, household_id, user_id, kind) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '44444444-4444-4444-4444-444444444444', 'senior_phone');

-- ---------------------------------------------------------------------------
-- Adding events: who may, and what is recorded
-- ---------------------------------------------------------------------------

-- Max (member) adds physiotherapy on Thursday 2027-03-18 at 2 PM (after spring-forward).
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select set_config('test.physio', (
  public.add_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ' Physiotherapy ', '2027-03-18', '14:00',
                   p_duration_minutes => 60, p_place => 'Riverside Clinic') ->> 'event_id'), true);
select is(
  (select created_via::text || ' ' || title || ' ' || created_by::text from public.events
   where id = current_setting('test.physio')::uuid),
  'caregiver Physiotherapy 22222222-2222-2222-2222-222222222222',
  'a member can add an event; title is trimmed and the caregiver is recorded');
select results_eq(
  $$ with d as (delete from public.events where id = current_setting('test.physio')::uuid returning 1)
     select count(*)::int from d $$,
  $$ values (0) $$,
  'caregivers cannot hard-delete events (no delete policy)');
reset role;
select set_config('request.jwt.claims', '', true);
select is(
  (select count(*)::int from public.events where id = current_setting('test.physio')::uuid),
  1, 'the event is still there after a hard-delete attempt');

select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select throws_ok(
  $$ select public.add_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Lunch', '2027-03-19', '12:00') $$,
  '42501', null, 'a viewer cannot add events');
reset role;

select set_config('request.jwt.claims',
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","is_anonymous":true}', true);
set local role authenticated;
select throws_ok(
  $$ select public.add_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Lunch', '2027-03-19', '12:00') $$,
  '42501', null, 'a senior device cannot add events directly');
reset role;

select set_config('request.jwt.claims',
  '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select throws_ok(
  $$ select public.add_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Lunch', '2027-03-19', '12:00') $$,
  '42501', null, 'an outsider cannot add events');
select throws_ok(
  $$ select public.list_events('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2027-03-01', '2027-03-31') $$,
  '42501', null, 'an outsider cannot list another household''s events');
reset role;
select set_config('request.jwt.claims', '', true);

-- The agent (service role) adds a weekly Tuesday/Thursday walk from Monday 2027-03-08
-- until 2027-03-25; repeat days arrive unsorted and duplicated.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('test.walk', (
  public.add_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Walk with Sarah', '2027-03-08', '10:00',
                   p_visitor_name => 'Sarah', p_label => 'Walk',
                   p_repeat_days => '{4,2,4}', p_repeat_until => '2027-03-25',
                   p_now => '2027-03-01 12:00Z') ->> 'event_id'), true);
select set_config('request.jwt.claims', '', true);

select is(
  (select created_via::text || ' ' || repeat_days::text from public.events
   where id = current_setting('test.walk')::uuid),
  'agent {2,4}', 'the agent''s events are marked created_via agent; repeat days are normalized');

select throws_ok(
  $$ select public.add_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Late', '2027-03-01', '09:00',
                             p_now => '2027-03-01 15:00Z') $$,
  '22023', 'That time has already passed', 'a one-off event cannot start in the past');
select throws_ok(
  $$ select public.add_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Bad', '2027-03-20', '09:00',
                             p_repeat_until => '2027-03-30') $$,
  '23514', null, 'repeat_until needs repeat days');
select throws_ok(
  $$ select public.add_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Bad', '2027-03-22', '09:00',
                             p_repeat_days => '{7}', p_repeat_until => '2027-03-23',
                             p_now => '2027-03-01 12:00Z') $$,
  '22023', 'The repeat has no dates between its start and end', 'a weekly repeat must have a date');
select throws_ok(
  $$ select public.add_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', repeat('x', 201), '2027-03-22', '09:00') $$,
  '23514', null, 'titles are length-capped');

-- ---------------------------------------------------------------------------
-- Occurrences across DST
-- ---------------------------------------------------------------------------

select results_eq(
  $$ select (o ->> 'local_date')::date, (o ->> 'starts_at')::timestamptz
     from jsonb_array_elements(public.list_events('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                                                  '2027-03-08', '2027-03-31')) o
     where o ->> 'event_id' = current_setting('test.walk') $$,
  $$ values ('2027-03-09'::date, '2027-03-09 15:00Z'::timestamptz),
            ('2027-03-11', '2027-03-11 15:00Z'),
            ('2027-03-16', '2027-03-16 14:00Z'),
            ('2027-03-18', '2027-03-18 14:00Z'),
            ('2027-03-23', '2027-03-23 14:00Z'),
            ('2027-03-25', '2027-03-25 14:00Z') $$,
  'a weekly event stays at 10:00 local across spring-forward and stops at repeat_until');

select is(
  (select (o ->> 'ends_at')::timestamptz
   from jsonb_array_elements(public.list_events('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                                                '2027-03-18', '2027-03-18')) o
   where o ->> 'event_id' = current_setting('test.physio')),
  '2027-03-18 19:00Z'::timestamptz, 'a one-off event has its end from duration');

select throws_ok(
  $$ select public.list_events('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2027-01-01', '2027-06-01') $$,
  '22023', null, 'list_events limits the range');

-- ---------------------------------------------------------------------------
-- Updating and cancelling
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select is(
  (public.update_event(current_setting('test.physio')::uuid, '{"start_time": "15:00"}')
     -> 'next_occurrence' ->> 'starts_at')::timestamptz,
  '2027-03-18 19:00Z'::timestamptz, 'moving the event to 3 PM moves its next occurrence');
select throws_ok(
  $$ select public.update_event(current_setting('test.physio')::uuid, '{"color": "red"}') $$,
  '22023', 'Unknown event fields: color', 'unknown fields are rejected');
select set_config('test.lunch', (
  public.add_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Lunch with Ann', '2027-03-18', '12:00')
  ->> 'event_id'), true);
select is(
  public.cancel_event(current_setting('test.lunch')::uuid) ->> 'cancelled',
  'true', 'a member can cancel an event');
select throws_ok(
  $$ select public.cancel_event(current_setting('test.lunch')::uuid) $$,
  'P0002', 'Event not found', 'a cancelled event cannot be cancelled again');
reset role;
select set_config('request.jwt.claims', '', true);

select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select throws_ok(
  $$ select public.update_event(current_setting('test.physio')::uuid, '{"title": "x"}') $$,
  '42501', null, 'a viewer cannot change events');
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select count(*)::int
   from jsonb_array_elements(public.list_events('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                                                '2027-03-18', '2027-03-18')) o
   where o ->> 'event_id' = current_setting('test.lunch')),
  0, 'cancelled events have no occurrences');

select results_eq(
  $$ select action from public.audit_log
     where entity = 'event' and entity_id = current_setting('test.lunch')::uuid order by id $$,
  $$ values ('insert'), ('cancel') $$,
  'event changes are audited, with cancellation named');

-- The backend (agent) must name the household it acts for.
select throws_ok(
  $$ select public.update_event(current_setting('test.walk')::uuid, '{"title": "x"}') $$,
  '22023', 'The backend must name the household', 'the backend cannot change an event without its household');
select throws_ok(
  $$ select public.cancel_event(current_setting('test.walk')::uuid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$,
  'P0002', 'Event not found', 'the backend cannot reach another household''s event');

-- One-off repeat cleared through update_event: a null repeat_days makes it one-off.
select is(
  (public.update_event(current_setting('test.walk')::uuid,
                       '{"repeat_days": null, "repeat_until": null, "on_date": "2027-03-30"}',
                       '2027-03-01 12:00Z', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') ->> 'repeat_days'),
  null, 'repeat_days null makes a weekly event one-off');
select is(
  (public.update_event(current_setting('test.walk')::uuid,
                       '{"repeat_days": [2, 4], "repeat_until": "2027-03-25", "on_date": "2027-03-08"}',
                       '2027-03-01 12:00Z', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') ->> 'repeat_days'),
  '[2, 4]', 'repeat days can be set again');
select is(
  (select count(*)::int from public.audit_log
   where entity = 'event' and entity_id = current_setting('test.walk')::uuid and action = 'update'),
  2, 'updates are audited');

-- ---------------------------------------------------------------------------
-- Day view
-- ---------------------------------------------------------------------------

select results_eq(
  $$ select v ->> 'header', v ->> 'date_label', v -> 'next_up' ->> 'title',
            jsonb_array_length(v -> 'events_today'), jsonb_array_length(v -> 'tasks')
     from public.get_day_view('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2027-03-18 13:00Z') v $$,
  $$ values ('Thursday morning', 'March 18', 'Walk with Sarah', 2, 0) $$,
  'at 9 AM Thursday the day view shows the walk next and both of today''s events');
select is(
  (select v -> 'next_up' ->> 'title'
   from public.get_day_view('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2027-03-18 14:20Z') v),
  'Walk with Sarah', 'an event without a duration stays Next up for 30 minutes');
select is(
  (select v -> 'next_up' ->> 'label'
   from public.get_day_view('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2027-03-18 14:31Z') v),
  'Physiotherapy', 'then the next event takes over');
select is(
  (select v ->> 'header'
   from public.get_day_view('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2027-03-19 02:30Z') v),
  'Thursday night', 'late evening is night');

select set_config('request.jwt.claims',
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","is_anonymous":true}', true);
set local role authenticated;
select is(
  (select v ->> 'senior_preferred_name' from public.get_day_view('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') v),
  'Mom', 'the senior''s device can read the day view');
reset role;
select set_config('request.jwt.claims',
  '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select throws_ok(
  $$ select public.get_day_view('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  '42501', null, 'an outsider cannot read the day view');
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select jsonb_array_length(c -> 'events') from public.get_agent_context(
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2027-03-18 13:00Z') c),
  3, 'agent context lists occurrences in the next 7 days that have not ended');

-- ---------------------------------------------------------------------------
-- Day-of notices
-- ---------------------------------------------------------------------------

select is(public.event_notice_tick('2027-03-18 11:59Z'), 0, 'nothing is announced before 8 AM local');
select is(public.event_notice_tick('2027-03-18 12:00Z'), 2, 'at 8 AM both of today''s events are announced');
select is(
  (select count(*)::int from public.notification_outbox where kind = 'event_notice'),
  6, 'each announced event goes to all three caregivers');
select is(
  (select title || ' | ' || body from public.notification_outbox
   where kind = 'event_notice' and event_id = current_setting('test.physio')::uuid
     and recipient_user_id = '11111111-1111-1111-1111-111111111111'),
  'Today: Physiotherapy at 3:00 PM | Mom has Physiotherapy at 3:00 PM today at Riverside Clinic.',
  'the notice names the event, time and place');
select is(public.event_notice_tick('2027-03-18 12:01Z'), 0, 'each occurrence is announced once');

select set_config('test.late', (
  public.add_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Haircut', '2027-03-18', '16:00',
                   p_now => '2027-03-18 15:00Z') ->> 'event_id'), true);
select public.add_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Coffee', '2027-03-18', '11:05',
                        p_now => '2027-03-18 15:00Z');
select is(public.event_notice_tick('2027-03-18 15:06Z'), 1,
  'an event added later the same day is announced on the next tick; one that already started is not');
select is(
  (select count(*)::int from public.notification_outbox
   where kind = 'event_notice' and event_id = current_setting('test.late')::uuid),
  3, 'the late event reaches every caregiver');

-- ---------------------------------------------------------------------------
-- Google connections and sync jobs
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.save_calendar_connection('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       '55555555-5555-5555-5555-555555555555', 'xen@gmail.com', 'cal-x', 'token-x') $$,
  '42501', 'Not a caregiver in this household', 'only household caregivers can connect');

select set_config('test.conn', public.save_calendar_connection(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111',
  'pat@gmail.com', 'cal-pat-1', 'refresh-1')::text, true);

select is(
  public.get_calendar_credentials(current_setting('test.conn')::uuid) ->> 'refresh_token',
  'refresh-1', 'the refresh token is stored in Vault and readable by the backend');
select is(
  (select count(*)::int from public.jobs
   where kind = 'calendar_sync_event' and payload ->> 'connection_id' = current_setting('test.conn')),
  4, 'connecting queues a push for every live event (not the cancelled one)');

update public.events set notes = 'Bring the referral' where id = current_setting('test.physio')::uuid;
update public.events set notes = 'Bring the referral and card' where id = current_setting('test.physio')::uuid;
select is(
  (select count(*)::int from public.jobs
   where kind = 'calendar_sync_event' and status = 'queued'
     and payload ->> 'event_id' = current_setting('test.physio')),
  1, 'repeated edits merge into one queued push per event and connection');

insert into public.calendar_event_links (event_id, connection_id, external_event_id)
values (current_setting('test.physio')::uuid, current_setting('test.conn')::uuid, 'g-physio');

select is(
  public.save_calendar_connection('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '11111111-1111-1111-1111-111111111111', 'pat@gmail.com', 'cal-pat-1', 'refresh-2')::text,
  current_setting('test.conn'), 'reconnecting reuses the connection');
select is(
  (select count(*)::int from public.calendar_event_links where connection_id = current_setting('test.conn')::uuid),
  1, 'reconnecting to the same calendar keeps links');
select is(
  public.get_calendar_credentials(current_setting('test.conn')::uuid) ->> 'refresh_token',
  'refresh-2', 'reconnecting replaces the refresh token');
select public.save_calendar_connection('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '11111111-1111-1111-1111-111111111111', 'pat@gmail.com', 'cal-pat-2', 'refresh-3');
select is(
  (select count(*)::int from public.calendar_event_links where connection_id = current_setting('test.conn')::uuid),
  0, 'a new calendar drops the old links');

select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select is((select count(*)::int from public.calendar_connections), 1, 'a caregiver sees their own connection');
select throws_ok(
  $$ select public.get_calendar_credentials(current_setting('test.conn')::uuid) $$,
  '42501', null, 'caregivers cannot read refresh tokens');
reset role;
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select is((select count(*)::int from public.calendar_connections), 0, 'other caregivers do not see it');
reset role;
select set_config('request.jwt.claims', '', true);

-- Changing the household timezone re-pushes every live event to active connections.
delete from public.jobs where kind = 'calendar_sync_event';
update public.households set timezone = 'America/Chicago' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select is(
  (select count(*)::int from public.jobs where kind = 'calendar_sync_event' and status = 'queued'),
  4, 'a timezone change queues a push per live event');
update public.households set timezone = 'America/New_York' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- A caregiver removed from the household loses their connection and its token.
select set_config('test.maxconn', public.save_calendar_connection(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222',
  'max@gmail.com', 'cal-max', 'refresh-max')::text, true);
select set_config('test.maxsecret', (select refresh_token_secret_id::text from public.calendar_connections
                                     where id = current_setting('test.maxconn')::uuid), true);
delete from public.household_members
where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and user_id = '22222222-2222-2222-2222-222222222222';
select is(
  (select count(*)::int from public.calendar_connections where id = current_setting('test.maxconn')::uuid)
  + (select count(*)::int from vault.secrets where id = current_setting('test.maxsecret')::uuid),
  0, 'removing a caregiver removes their Google connection and token');
insert into public.household_members (household_id, user_id, role, display_name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member', 'Max');

-- Google payloads.
select results_eq(
  $$ select p ->> 'start_local', p ->> 'end_local', p ->> 'rrule', (p ->> 'reminder_minutes')::int,
            p ->> 'time_zone'
     from public.get_event_sync_payload(current_setting('test.walk')::uuid,
                                        current_setting('test.conn')::uuid) p $$,
  $$ values ('2027-03-09T10:00:00', '2027-03-09T11:00:00',
             'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20270326T035959Z', 120, 'America/New_York') $$,
  'a weekly event starts on its first matching weekday, ends at the last local day in UTC, reminds at 8 AM');
select is(
  (public.get_event_sync_payload(current_setting('test.physio')::uuid,
                                 current_setting('test.conn')::uuid) ->> 'reminder_minutes')::int,
  420, 'a 3 PM event reminds 7 hours before (8 AM)');
select set_config('test.early', (
  public.add_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Blood test', '2027-03-19', '07:00',
                   p_now => '2027-03-18 15:00Z') ->> 'event_id'), true);
select is(
  (public.get_event_sync_payload(current_setting('test.early')::uuid,
                                 current_setting('test.conn')::uuid) ->> 'reminder_minutes')::int,
  60, 'an event before 8 AM reminds an hour ahead');
select is(
  (public.get_event_sync_payload(current_setting('test.lunch')::uuid,
                                 current_setting('test.conn')::uuid) ->> 'cancelled'),
  'true', 'a cancelled event is marked for deletion in Google');

select set_config('test.secret', (select refresh_token_secret_id::text from public.calendar_connections
                                  where id = current_setting('test.conn')::uuid), true);
delete from public.calendar_connections where id = current_setting('test.conn')::uuid;
select is(
  (select count(*)::int from vault.secrets where id = current_setting('test.secret')::uuid),
  0, 'removing a connection removes its token from Vault');

-- ---------------------------------------------------------------------------
-- Job lifecycle
-- ---------------------------------------------------------------------------

delete from public.jobs;

select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select set_config('test.job', public.request_agent_chat(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '  Add physiotherapy at 2PM next Thursday ')::text, true);
select is(
  (select payload ->> 'message' from public.jobs where id = current_setting('test.job')::uuid),
  'Add physiotherapy at 2PM next Thursday', 'a member can message the agent; the caregiver reads the job');
select throws_ok(
  $$ select public.request_agent_chat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '   ') $$,
  '22023', null, 'an empty message is rejected');
select throws_ok(
  $$ select public.claim_job() $$, '42501', null, 'caregivers cannot claim jobs');
select throws_ok(
  $$ select public.request_agent_chat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hi',
                                      '00000000-0000-0000-0000-000000000000') $$,
  'P0002', null, 'continuing needs an earlier, finished agent job of the household');
reset role;
select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select throws_ok(
  $$ select public.request_agent_chat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hi') $$,
  '42501', null, 'a viewer cannot message the agent');
select is((select count(*)::int from public.jobs), 0, 'viewers do not read the household''s jobs');
reset role;
select set_config('request.jwt.claims',
  '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select is((select count(*)::int from public.jobs), 0, 'an outsider cannot read the household''s jobs');
reset role;
select set_config('request.jwt.claims', '', true);

update public.jobs set run_after = '2027-01-01 00:00Z' where id = current_setting('test.job')::uuid;

select is(
  (select status::text from public.claim_job(current_setting('test.job')::uuid, 60, '2027-01-01 00:00Z')),
  'running', 'the backend claims a due job');
select is(
  (select count(*)::int from public.claim_job(current_setting('test.job')::uuid, 60, '2027-01-01 00:00Z')),
  0, 'a running job cannot be claimed twice');

select results_eq(
  $$ select status::text, attempts, run_after from public.fail_job(
       current_setting('test.job')::uuid, 'boom', true, '2027-01-01 00:00Z') $$,
  $$ values ('queued', 1, '2027-01-01 00:00:30Z'::timestamptz) $$,
  'a failure retries after 30 seconds');
select is(
  (select count(*)::int from public.claim_job(null, 60, '2027-01-01 00:00:10Z')),
  0, 'a retry is not claimed before its time');
select public.claim_job(null, 60, '2027-01-01 00:00:30Z');
select is(
  (select run_after from public.fail_job(current_setting('test.job')::uuid, 'boom', true, '2027-01-01 00:00:30Z')),
  '2027-01-01 00:01:30Z'::timestamptz, 'the backoff doubles');

select public.claim_job(null, 60, '2027-01-01 00:01:30Z');
select is(
  (select checkpoint ->> 'step' from public.checkpoint_job(
     current_setting('test.job')::uuid, '{"step": "started"}', 60, '2027-01-01 00:01:31Z')),
  'started', 'a running job can save a checkpoint');
select results_eq(
  $$ select status::text, checkpoint ->> 'session_id', run_after from public.defer_job(
       current_setting('test.job')::uuid, '{"session_id": "sesn_1"}', '2027-01-01 01:00Z', true) $$,
  $$ values ('waiting', 'sesn_1', '2027-01-01 01:00Z'::timestamptz) $$,
  'a deferred job waits with its checkpoint');
select is(
  (select checkpoint ->> 'step' from public.jobs where id = current_setting('test.job')::uuid),
  'started', 'checkpoints merge');
select throws_ok(
  $$ select public.checkpoint_job(current_setting('test.job')::uuid, '{}') $$,
  'P0002', null, 'only a running job can save a checkpoint');
select is(
  (public.jobs_sweep('2027-01-01 00:59Z') ->> 'woken')::int, 0, 'the sweep leaves it waiting until its time');
select is(
  (public.jobs_sweep('2027-01-01 01:00Z') ->> 'woken')::int, 1, 'then wakes it');
select is(
  (select status::text from public.jobs where id = current_setting('test.job')::uuid),
  'queued', 'a woken job is queued again');

select public.claim_job(null, 60, '2027-01-01 01:00Z');
select is(
  (public.jobs_sweep('2027-01-01 01:01:01Z') ->> 'expired')::int, 1, 'an expired lease is swept');
select results_eq(
  $$ select status::text, attempts, last_error, run_after from public.jobs where id = current_setting('test.job')::uuid $$,
  $$ values ('queued', 3, 'lease expired', '2027-01-01 01:03:01Z'::timestamptz) $$,
  'lease expiry counts as a failed attempt, with the same backoff');

update public.households set background_paused = true where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select is(
  (select count(*)::int from public.claim_job(null, 60, '2027-01-01 02:00Z')),
  0, 'nothing is claimed while the household is paused');
update public.households set background_paused = false where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

select public.claim_job(null, 60, '2027-01-01 02:00Z');
select results_eq(
  $$ select status::text, result ->> 'reply', finished_at from public.complete_job(
       current_setting('test.job')::uuid, '{"reply": "Added."}', '2027-01-01 02:00:05Z') $$,
  $$ values ('succeeded', 'Added.', '2027-01-01 02:00:05Z'::timestamptz) $$,
  'a completed job keeps its result');
select throws_ok(
  $$ select public.complete_job(current_setting('test.job')::uuid) $$,
  'P0002', null, 'a finished job cannot be finished again');

-- Continuing a conversation points at the earlier job; a final failure stops retrying.
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select set_config('test.job2', public.request_agent_chat(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Make it 3PM instead', current_setting('test.job')::uuid)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);
select is(
  (select payload ->> 'continue_job_id' from public.jobs where id = current_setting('test.job2')::uuid),
  current_setting('test.job'), 'a follow-up names the job it continues');
update public.jobs set run_after = '2027-01-01 00:00Z', max_attempts = 1 where id = current_setting('test.job2')::uuid;
select public.claim_job(current_setting('test.job2')::uuid, 60, '2027-01-01 03:00Z');
select results_eq(
  $$ select status::text, attempts from public.fail_job(
       current_setting('test.job2')::uuid, 'bad', true, '2027-01-01 03:00Z') $$,
  $$ values ('failed', 1) $$,
  'the last allowed attempt fails for good');

-- A job going back to the queue while a newer one with its key is queued is superseded,
-- and jobs sharing a key never run at the same time.
delete from public.jobs;
select set_config('test.k1', private.enqueue_job(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'calendar_sync_event', '{}', 'kx', '2027-01-01Z')::text, true);
select public.claim_job(current_setting('test.k1')::uuid, 60, '2027-01-01 00:00Z');
select set_config('test.k2', private.enqueue_job(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'calendar_sync_event', '{}', 'kx', '2027-01-01Z')::text, true);
select isnt(current_setting('test.k2'), current_setting('test.k1'), 'a running job does not absorb a new one');
select is(
  (select count(*)::int from public.claim_job(current_setting('test.k2')::uuid, 60, '2027-01-01 00:00Z')),
  0, 'a job is not claimed while another with its key runs');
select results_eq(
  $$ select status::text, last_error from public.fail_job(current_setting('test.k1')::uuid, 'boom', true, '2027-01-01 00:00Z') $$,
  $$ values ('cancelled', 'superseded by a newer job') $$,
  'a retry superseded by a queued job of the same key is cancelled, not a unique-key error');
select is(
  (select status::text from public.claim_job(current_setting('test.k2')::uuid, 60, '2027-01-01 00:00Z')),
  'running', 'the newer job runs once the older one is done');
select set_config('test.k3', private.enqueue_job(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'calendar_sync_event', '{}', 'kx', '2027-01-01Z')::text, true);
select is(
  (public.jobs_sweep('2027-01-01 00:02Z') ->> 'expired')::int,
  1, 'an expired lease with a queued same-key job does not break the sweep');
select is(
  (select status::text from public.jobs where id = current_setting('test.k2')::uuid),
  'cancelled', 'the expired job is superseded');

-- Backend-only private helpers are not callable by the API roles.
select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname in ('vault_secret', 'dispatch_jobs', 'enqueue_job', 'record_failure', 'requeue_job',
                        'queue_calendar_sync', 'event_occurrences', 'lock_event')
      and (has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute'))
  ),
  'API roles cannot run backend-only private helpers');

-- enqueue_job merges by dedupe key while queued, and keeps the earlier run time.
select is(
  private.enqueue_job('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'calendar_sync_event', '{"n": 1}', 'k1', '2027-02-01Z'),
  private.enqueue_job('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'calendar_sync_event', '{"n": 2}', 'k1', '2027-01-15Z'),
  'the same dedupe key reuses the queued job');
select results_eq(
  $$ select payload ->> 'n', run_after from public.jobs where dedupe_key = 'k1' $$,
  $$ values ('2', '2027-01-15Z'::timestamptz) $$,
  'the merged job takes the new payload and the earlier time');

select * from finish();
rollback;
