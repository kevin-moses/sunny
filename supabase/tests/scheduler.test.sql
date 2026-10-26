-- scheduler.test.sql
-- Purpose: pgTAP tests for the shared-state schema and SQL scheduler. Drives the clock
-- explicitly (p_now) through the March 2027 US DST change and checks expansion, the
-- escalation ladder, claim, snooze, confirm (early, late, by caregiver), schedule
-- edits, what "Done" means (confirm_due_task), senior-created reminders, join codes,
-- row level security and the agent context RPC.
-- Run with: supabase test db

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Fixtures: one household (Mom, New York) with a primary (Pat, on call), a member
-- (Max), a viewer (Val) and a paired senior phone; a second household for an outsider.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role, is_anonymous) values
  ('11111111-1111-1111-1111-111111111111', 'pat@test.local', 'authenticated', 'authenticated', false),
  ('22222222-2222-2222-2222-222222222222', 'max@test.local', 'authenticated', 'authenticated', false),
  ('33333333-3333-3333-3333-333333333333', 'val@test.local', 'authenticated', 'authenticated', false),
  ('44444444-4444-4444-4444-444444444444', null, 'authenticated', 'authenticated', true),
  ('55555555-5555-5555-5555-555555555555', 'xen@test.local', 'authenticated', 'authenticated', false),
  ('66666666-6666-6666-6666-666666666666', null, 'authenticated', 'authenticated', true);

insert into public.households (id, senior_preferred_name, timezone) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Mom', 'America/New_York'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Dad', 'America/Chicago');

insert into public.household_members (household_id, user_id, role, display_name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'primary', 'Pat'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member', 'Max'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'viewer', 'Val'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '55555555-5555-5555-5555-555555555555', 'primary', 'Xen');

update public.households set on_call_user_id = '11111111-1111-1111-1111-111111111111'
where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

insert into public.devices (id, household_id, user_id, kind) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '44444444-4444-4444-4444-444444444444', 'senior_phone');

-- ---------------------------------------------------------------------------
-- Default policies
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.escalation_policies
   where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  2, 'two default escalation policies are seeded per household');

select results_eq(
  $$ select s.offset_minutes, s.action::text, s.skip_if_claimed
     from public.escalation_steps s join public.escalation_policies p on p.id = s.policy_id
     where p.household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and p.name = 'Medication'
     order by s.position $$,
  $$ values (0, 'prompt_senior', false), (15, 'prompt_senior', false),
            (30, 'alert_on_call', false), (45, 'alert_all_caregivers', true) $$,
  'medication ladder matches the SPEC defaults');

-- ---------------------------------------------------------------------------
-- Expansion across spring-forward (2027-03-14 02:00 local)
-- ---------------------------------------------------------------------------

insert into public.tasks (
  id, household_id, type, title, display_label, spoken_prompt, times, window_minutes, escalation_policy_id
) values (
  'cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'medication',
  'Morning pills (lisinopril)', 'Morning pills',
  'It''s 8 o''clock. Time for your morning pills, the small white ones.',
  '{08:00}', 60,
  (select id from public.escalation_policies
   where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and name = 'Medication')
);

select public.scheduler_tick('2027-03-13 11:00Z');  -- 06:00 EST

select set_config('test.i1', (select id::text from public.task_instances
  where task_id = 'cccccccc-0000-0000-0000-000000000001' and local_date = '2027-03-13'), true);
select set_config('test.i2', (select id::text from public.task_instances
  where task_id = 'cccccccc-0000-0000-0000-000000000001' and local_date = '2027-03-14'), true);

select is(
  (select window_start from public.task_instances where id = current_setting('test.i1')::uuid),
  '2027-03-13 13:00Z'::timestamptz, '8:00 local before DST is 13:00 UTC');
select is(
  (select window_start from public.task_instances where id = current_setting('test.i2')::uuid),
  '2027-03-14 12:00Z'::timestamptz, '8:00 local after spring-forward is 12:00 UTC');
select is(
  (select window_end from public.task_instances where id = current_setting('test.i1')::uuid),
  '2027-03-13 14:00Z'::timestamptz, 'window is 60 minutes');
select is(public.expand_task_instances('2027-03-13 11:00Z'), 0, 'expansion is idempotent');
select is(
  (select state::text from public.task_instances where id = current_setting('test.i1')::uuid),
  'upcoming', 'instance is upcoming before its window');

-- ---------------------------------------------------------------------------
-- Escalation ladder for the 2027-03-13 instance
-- ---------------------------------------------------------------------------

select public.scheduler_tick('2027-03-13 13:00Z');  -- 08:00 window opens

select is(
  (select state::text from public.task_instances where id = current_setting('test.i1')::uuid),
  'due', 'window opening makes the instance due');
select results_eq(
  $$ select kind::text, recipient_device_id, body from public.notification_outbox
     where task_instance_id = current_setting('test.i1')::uuid $$,
  $$ values ('senior_prompt', 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid,
             'It''s 8 o''clock. Time for your morning pills, the small white ones.') $$,
  'window opening queues the spoken prompt for the senior device');

select public.scheduler_tick('2027-03-13 13:00:30Z');
select is(
  (select count(*)::int from public.notification_outbox
   where task_instance_id = current_setting('test.i1')::uuid),
  1, 'a second tick in the same minute fires nothing new');

select public.scheduler_tick('2027-03-13 13:15Z');
select is(
  (select count(*)::int from public.notification_outbox
   where task_instance_id = current_setting('test.i1')::uuid and kind = 'senior_prompt'),
  2, '+15 min reprompts the senior');

select public.scheduler_tick('2027-03-13 13:30Z');
select results_eq(
  $$ select recipient_user_id, title, body from public.notification_outbox
     where task_instance_id = current_setting('test.i1')::uuid and kind = 'caregiver_alert' $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid,
             'Mom hasn''t confirmed Morning pills', 'Due at 8:00 AM. Tap to claim it.') $$,
  '+30 min alerts only the on-call caregiver');
select is(
  (select state::text from public.task_instances where id = current_setting('test.i1')::uuid),
  'escalated', 'a caregiver alert marks the instance escalated');

-- Max claims it.
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select is(
  (select claimed_by from public.claim_task_instance(current_setting('test.i1')::uuid)),
  '22222222-2222-2222-2222-222222222222'::uuid, 'a member can claim an escalated task');
reset role;
select set_config('request.jwt.claims', '', true);

select public.scheduler_tick('2027-03-13 13:45Z');
select is(
  (select count(*)::int from public.notification_outbox
   where task_instance_id = current_setting('test.i1')::uuid and kind = 'caregiver_alert'),
  1, '+45 min all-caregiver alert is skipped once claimed');

select public.scheduler_tick('2027-03-13 14:00Z');
select is(
  (select state::text from public.task_instances where id = current_setting('test.i1')::uuid),
  'missed', 'closing the window marks an unconfirmed instance missed');

-- Max marks it done after calling.
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select results_eq(
  $$ select state::text, confirmed_via::text, confirmed_by, resolution_note
     from public.confirm_task_instance(current_setting('test.i1')::uuid, 'phone_app', 'Called her, she took them') $$,
  $$ values ('resolved', 'caregiver', '22222222-2222-2222-2222-222222222222'::uuid, 'Called her, she took them') $$,
  'a caregiver confirmation resolves the task under their name');
reset role;
select set_config('request.jwt.claims', '', true);

select results_eq(
  $$ select detail ->> 'to', actor_kind::text from public.audit_log
     where entity_id = current_setting('test.i1')::uuid and action = 'state_change' order by id $$,
  $$ values ('due', 'system'), ('escalated', 'system'), ('missed', 'system'), ('resolved', 'caregiver') $$,
  'every state change is audited with its actor');

-- ---------------------------------------------------------------------------
-- Confirming the 2027-03-14 instance
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims',
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","is_anonymous":true}', true);
set local role authenticated;
select throws_ok(
  $$ select public.confirm_task_instance(current_setting('test.i2')::uuid, 'button') $$,
  '22023', 'This task is not due yet',
  'a device cannot confirm a task more than an hour early (users get the server clock)');
reset role;
select set_config('request.jwt.claims', '', true);

select results_eq(
  $$ select state::text, confirmed_at, confirmed_via::text
     from public.confirm_task_instance(current_setting('test.i2')::uuid, 'voice', null, '2027-03-14 11:30Z') $$,
  $$ values ('confirmed', '2027-03-14 11:30Z'::timestamptz, 'voice') $$,
  'the agent can confirm 30 minutes early');
select is(
  (select confirmed_at from public.confirm_task_instance(
     current_setting('test.i2')::uuid, 'button', null, '2027-03-14 12:10Z')),
  '2027-03-14 11:30Z'::timestamptz, 'confirming again keeps the first confirmation (already-done guard)');

select public.scheduler_tick('2027-03-14 12:00Z');
select is(
  (select count(*)::int from public.notification_outbox
   where task_instance_id = current_setting('test.i2')::uuid),
  0, 'a confirmed instance is never prompted');

-- ---------------------------------------------------------------------------
-- Snooze
-- ---------------------------------------------------------------------------

insert into public.tasks (
  id, household_id, type, title, display_label, times, window_minutes, escalation_policy_id
) values (
  'cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'medication',
  'Evening pills', 'Evening pills', '{20:00}', 60,
  (select id from public.escalation_policies
   where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and name = 'Medication')
);

select public.scheduler_tick('2027-03-15 23:00Z');  -- 19:00 EDT
select set_config('test.i3', (select id::text from public.task_instances
  where task_id = 'cccccccc-0000-0000-0000-000000000002' and local_date = '2027-03-15'), true);
select public.scheduler_tick('2027-03-16 00:00Z');  -- 20:00 EDT

select is(
  (select snoozed_until from public.snooze_task_instance(
     current_setting('test.i3')::uuid, 20, '2027-03-16 00:05Z')),
  '2027-03-16 00:25Z'::timestamptz, '"not yet" snoozes for the requested minutes');

select public.scheduler_tick('2027-03-16 00:15Z');
select is(
  (select count(*)::int from public.notification_outbox
   where task_instance_id = current_setting('test.i3')::uuid and kind = 'senior_prompt'),
  1, 'the +15 reprompt waits while snoozed');

select public.scheduler_tick('2027-03-16 00:30Z');
select is(
  (select count(*)::int from public.notification_outbox
   where task_instance_id = current_setting('test.i3')::uuid and kind = 'senior_prompt'),
  2, 'the deferred reprompt fires after the snooze ends');
select is(
  (select count(*)::int from public.notification_outbox
   where task_instance_id = current_setting('test.i3')::uuid and kind = 'caregiver_alert'),
  1, 'caregiver alerts are not delayed by a snooze');

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims',
  '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select is(
  (select count(*)::int from public.task_instances
   where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0, 'a caregiver from another household sees none of these instances');
select throws_ok(
  $$ select public.confirm_task_instance(current_setting('test.i3')::uuid, 'phone_app') $$,
  '42501', 'Not allowed to confirm this task', 'an outsider cannot confirm');
reset role;
select set_config('request.jwt.claims', '', true);

select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select ok(
  (select count(*) from public.task_instances
   where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') > 0,
  'a viewer can read the household timeline');
select throws_ok(
  $$ select public.confirm_task_instance(current_setting('test.i3')::uuid, 'phone_app') $$,
  '42501', 'Not allowed to confirm this task', 'a viewer cannot mark a task done');
select throws_ok(
  $$ insert into public.tasks (household_id, type, title, display_label)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'routine', 'Walk', 'Walk') $$,
  '42501', null, 'a viewer cannot create tasks');
reset role;
select set_config('request.jwt.claims', '', true);

select set_config('request.jwt.claims',
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","is_anonymous":true}', true);
set local role authenticated;
select ok(
  (select count(*) from public.notification_outbox) > 0
  and not exists (select 1 from public.notification_outbox where kind = 'caregiver_alert'),
  'the senior device sees its own prompts and no caregiver alerts');
select is(
  (select count(*)::int from public.agent_memory), 0, 'the senior device cannot read agent memory');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- Schedule edits re-expand future instances
-- ---------------------------------------------------------------------------

select set_config('test.i4', (select id::text from public.task_instances
  where task_id = 'cccccccc-0000-0000-0000-000000000002' and local_date = '2027-03-16'), true);
update public.tasks set times = '{21:00}' where id = 'cccccccc-0000-0000-0000-000000000002';
select ok(
  not exists (select 1 from public.task_instances where id = current_setting('test.i4')::uuid),
  'editing the schedule drops future upcoming instances');
select ok(
  exists (select 1 from public.task_instances where id = current_setting('test.i3')::uuid),
  'editing the schedule keeps instances that already opened');
select public.scheduler_tick('2027-03-16 12:00Z');
select is(
  (select scheduled_time from public.task_instances
   where task_id = 'cccccccc-0000-0000-0000-000000000002' and local_date = '2027-03-16'),
  '21:00'::time, 'the next tick creates the instance at the new time');

-- ---------------------------------------------------------------------------
-- Join codes and household creation
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select set_config('test.code', (select code from public.create_join_code(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'home_display')), true);
select ok(current_setting('test.code') ~ '^[A-Z0-9]{8}$', 'join codes are eight characters');
reset role;
select set_config('request.jwt.claims', '', true);

select set_config('request.jwt.claims',
  '{"sub":"66666666-6666-6666-6666-666666666666","role":"authenticated","is_anonymous":true}', true);
set local role authenticated;
select is(
  public.redeem_join_code(lower(current_setting('test.code')), 'Kitchen display'),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'an anonymous device redeems a code (case-insensitive)');
select throws_ok(
  $$ select public.redeem_join_code(current_setting('test.code')) $$,
  'P0002', 'This code is invalid or has expired', 'a code works only once');
select is(
  (select kind::text from public.devices where user_id = '66666666-6666-6666-6666-666666666666'),
  'home_display', 'redeeming pairs the device with the granted kind');
select throws_ok(
  $$ select public.create_household('Grandpa', 'America/Denver', 'Me') $$,
  '42501', 'Only a signed-in caregiver can create a household', 'devices cannot create households');
reset role;
select set_config('request.jwt.claims', '', true);

select set_config('request.jwt.claims',
  '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select set_config('test.h3', (select id::text from public.create_household('Grandpa', 'America/Denver', 'Xen')), true);
select results_eq(
  $$ select role::text, (select on_call_user_id from public.households where id = current_setting('test.h3')::uuid)
     from public.household_members where household_id = current_setting('test.h3')::uuid $$,
  $$ values ('primary', '55555555-5555-5555-5555-555555555555'::uuid) $$,
  'the creator becomes primary and on call');
select throws_ok(
  $$ select public.create_household('Nobody', 'Not/AZone', 'Xen') $$,
  '23514', null, 'invalid timezones are rejected');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- What "Done" means: get_today and confirm_due_task (2027-03-20, EDT)
-- ---------------------------------------------------------------------------

insert into public.tasks (
  id, household_id, type, title, display_label, times, window_minutes, escalation_policy_id
) values (
  'cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'medication',
  'Lunch pills', 'Lunch pills', '{12:00}', 60,
  (select id from public.escalation_policies
   where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and system_key = 'medication')
);
select is(
  (select spoken_prompt from public.tasks where id = 'cccccccc-0000-0000-0000-000000000003'),
  'Time for Lunch pills.', 'a blank spoken prompt defaults from the label');

select public.scheduler_tick('2027-03-20 11:00Z');  -- 07:00 EDT
select public.scheduler_tick('2027-03-20 12:00Z');  -- 08:00 morning pills due
select is(
  jsonb_array_length(public.get_today('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2027-03-20 12:00Z')),
  3, 'get_today lists the day''s three instances');

select results_eq(
  $$ select r ->> 'status', r ->> 'display_label', (r ->> 'confirmed_at')::timestamptz
     from public.confirm_due_task('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'button', null, '2027-03-20 12:05Z') r $$,
  $$ values ('confirmed', 'Morning pills', '2027-03-20 12:05Z'::timestamptz) $$,
  'Done with no label confirms the task that is due');
select is(
  public.confirm_due_task('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'button', null, '2027-03-20 12:06Z') ->> 'status',
  'nothing_due', 'a second Done with nothing due changes nothing');
select results_eq(
  $$ select r ->> 'status', (r ->> 'confirmed_at')::timestamptz
     from public.confirm_due_task('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'voice', 'MORNING', '2027-03-20 12:30Z') r $$,
  $$ values ('already_done', '2027-03-20 12:05Z'::timestamptz) $$,
  'asking again reports the original confirmation time (double-dose guard)');
select is(
  public.confirm_due_task('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'voice', 'lunch', '2027-03-20 12:30Z') ->> 'status',
  'not_due_yet', 'a task hours away is not confirmed');
select is(
  public.confirm_due_task('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'voice', 'pills', '2027-03-20 15:30Z') ->> 'status',
  'ambiguous', 'several open matches ask which one');
select is(
  public.confirm_due_task('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'voice', 'insulin', '2027-03-20 15:30Z') ->> 'status',
  'not_found', 'an unknown task is reported as not found');

select public.scheduler_tick('2027-03-20 16:00Z');  -- 12:00 EDT lunch due
select results_eq(
  $$ select count(*)::int, min(body), max(body) from public.notification_outbox o
     join public.task_instances i on i.id = o.task_instance_id
     where i.task_id = 'cccccccc-0000-0000-0000-000000000003' and i.local_date = '2027-03-20' $$,
  $$ values (2, 'Time for Lunch pills.', 'Time for Lunch pills.') $$,
  'both paired devices (phone and display) get the defaulted spoken prompt');

select set_config('request.jwt.claims',
  '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select throws_ok(
  $$ select public.confirm_due_task('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'button') $$,
  '42501', null, 'an outsider cannot press Done for another household');
select throws_ok(
  $$ select public.get_today('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  '42501', null, 'an outsider cannot read another household''s day');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- Senior-created reminders
-- ---------------------------------------------------------------------------

update public.escalation_policies set name = 'Gentle nudge'
where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and system_key = 'prompt_only';

select set_config('request.jwt.claims',
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","is_anonymous":true}', true);
set local role authenticated;
select results_eq(
  $$ select display_label, spoken_prompt, created_by_kind::text, once_on, window_minutes,
            escalation_policy_id is not null
     from public.create_senior_reminder('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'call the plumber', '10:00', '2027-03-22') $$,
  $$ values ('Call the plumber', 'Reminder: call the plumber.', 'senior', '2027-03-22'::date, 30, true) $$,
  'the senior''s device creates a one-off reminder on the prompt-only policy, even after a rename');
select is(
  (select days_of_week from public.create_senior_reminder(
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'water the plants', '09:00', null, '{1,4}')),
  '{1,4}'::smallint[], 'recurring reminders keep their weekdays');
select is(
  public.cancel_senior_reminder('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'the p') ->> 'status',
  'ambiguous', 'a vague cancel asks which reminder');
select is(
  public.cancel_senior_reminder('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Plumber') ->> 'status',
  'cancelled', 'a clear cancel deactivates the reminder');
select is(
  public.cancel_senior_reminder('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Morning') ->> 'status',
  'not_found', 'family-created tasks cannot be cancelled by the senior');
reset role;
select set_config('request.jwt.claims', '', true);

select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select throws_ok(
  $$ select public.create_senior_reminder('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'x', '10:00') $$,
  '42501', null, 'senior reminders can only come from the senior''s devices or the agent');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- Review fixes: label preference, bursts, mid-window tasks, deactivation, blank cancel
-- ---------------------------------------------------------------------------

select is(
  public.confirm_due_task('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'voice', 'pills', '2027-03-20 16:05Z') ->> 'display_label',
  'Lunch pills', '"pills" prefers the dose due now over a later one');

-- A morning instance that only appeared at 8:40 (task added mid-window).
select set_config('test.i6', (select id::text from public.task_instances
  where task_id = 'cccccccc-0000-0000-0000-000000000001' and local_date = '2027-03-21'), true);
update public.task_instances set created_at = '2027-03-21 12:40Z'
where id = current_setting('test.i6')::uuid;
select public.scheduler_tick('2027-03-21 12:41Z');
select public.scheduler_tick('2027-03-21 12:56Z');
select results_eq(
  $$ select kind::text, count(distinct payload ->> 'step')::int from public.notification_outbox
     where task_instance_id = current_setting('test.i6')::uuid group by kind $$,
  $$ values ('senior_prompt', 2) $$,
  'a task added mid-window starts its ladder then: two prompt steps, no caregiver page');

-- Nothing ticks the 2027-03-21 lunch instance until 12:50 local: steps 0-3 are all due.
select public.scheduler_tick('2027-03-21 16:50Z');
select set_config('test.i5', (select id::text from public.task_instances
  where task_id = 'cccccccc-0000-0000-0000-000000000003' and local_date = '2027-03-21'), true);
select results_eq(
  $$ select step_position::int, notified from public.instance_escalations
     where task_instance_id = current_setting('test.i5')::uuid order by step_position $$,
  $$ values (0, false), (1, true), (2, false), (3, true) $$,
  'after a gap only the latest prompt and the latest alert are sent');
select is(
  (select array_agg(distinct (payload ->> 'step')::int order by (payload ->> 'step')::int)
   from public.notification_outbox where task_instance_id = current_setting('test.i5')::uuid),
  array[1, 3], 'one reprompt and one all-caregiver alert are queued, not four rounds');

select public.create_senior_reminder('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'stretch', '10:00');
select public.scheduler_tick('2027-03-21 14:00Z');  -- 10:00 EDT
select ok(
  exists (select 1 from public.task_instances i join public.tasks t on t.id = i.task_id
          where t.title = 'stretch' and i.local_date = '2027-03-21' and i.state = 'due'),
  'the senior reminder comes due');
select is(
  public.cancel_senior_reminder('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'stretch') ->> 'status',
  'cancelled', 'the senior cancels it');
select ok(
  not exists (select 1 from public.task_instances i join public.tasks t on t.id = i.task_id
              where t.title = 'stretch' and i.state in ('upcoming', 'due', 'escalated')),
  'cancelling removes its open instances so nothing keeps prompting');
select is(
  public.cancel_senior_reminder('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '  ') ->> 'status',
  'not_found', 'a blank cancel matches nothing');
select throws_ok(
  $$ select public.create_senior_reminder('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'x', '10:00', '2020-01-01') $$,
  '22023', 'That date has already passed', 'one-off reminders cannot be in the past');
select throws_ok(
  $$ delete from public.escalation_policies
     where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and system_key = 'medication' $$,
  '42501', null, 'default policies cannot be deleted');

-- ---------------------------------------------------------------------------
-- Review fixes: timezone change, household deletion, backend detection
-- ---------------------------------------------------------------------------

insert into public.tasks (id, household_id, type, title, display_label, times)
values ('cccccccc-0000-0000-0000-000000000009', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'routine', 'Walk', 'Walk', '{09:00}');
select public.scheduler_tick('2027-04-01 05:00Z');
update public.households set timezone = 'America/Los_Angeles'
where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
select public.scheduler_tick('2027-04-01 05:00Z');
select is(
  (select window_start from public.task_instances
   where task_id = 'cccccccc-0000-0000-0000-000000000009' and local_date = '2027-04-01'),
  '2027-04-01 16:00Z'::timestamptz, 'a timezone change moves future windows to the new zone');
select throws_ok(
  $$ update public.households set timezone = 'EST' where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' $$,
  '23514', null, 'timezone abbreviations without DST rules are rejected');
select lives_ok(
  $$ delete from public.households where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' $$,
  'a household with tasks can be deleted');

select set_config('request.jwt.claims', '{"role":"anon"}', true);
select ok(not private.is_backend(), 'an anon JWT is never the backend');
select set_config('request.jwt.claims', '{}', true);
select ok(not private.is_backend(), 'a JWT without a role is never the backend');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(private.is_backend(), 'the service role is the backend');
select set_config('request.jwt.claims', '', true);
select ok(private.is_backend(), 'a direct database session is the backend');

-- ---------------------------------------------------------------------------
-- Review fixes: memory verification and transcript consent
-- ---------------------------------------------------------------------------

insert into public.conversations (id, household_id, summary)
values ('eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Asked about Sarah.');
insert into public.agent_memory (id, household_id, fact, source)
values ('eeeeeeee-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Has a cat named Tom', 'senior');

select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select is(
  (select count(*)::int from public.conversations), 0,
  'without transcript consent caregivers cannot read conversation summaries');
select results_eq(
  $$ insert into public.agent_memory (household_id, fact, source)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Prefers tea', 'caregiver')
     returning verified_by, verified_at is not null $$,
  $$ values ('22222222-2222-2222-2222-222222222222'::uuid, true) $$,
  'a caregiver fact is verified under the caregiver who entered it');
select results_eq(
  $$ update public.agent_memory set verified_at = now(), verified_by = '11111111-1111-1111-1111-111111111111'
     where id = 'eeeeeeee-0000-0000-0000-000000000002' returning verified_by $$,
  $$ values ('22222222-2222-2222-2222-222222222222'::uuid) $$,
  'verifying a senior fact records the caregiver doing it, not a spoofed name');
select throws_ok(
  $$ update public.agent_memory set source = 'caregiver' where id = 'eeeeeeee-0000-0000-0000-000000000002' $$,
  '42501', null, 'a fact''s source cannot be rewritten');
reset role;
select set_config('request.jwt.claims', '', true);

update public.households set share_transcripts = true where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
select is(
  (select count(*)::int from public.conversations), 1,
  'with consent caregivers can read conversation summaries');
select throws_ok(
  $$ select public.get_agent_context('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  '42501', null, 'end users cannot call the agent context RPC');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- Agent context
-- ---------------------------------------------------------------------------

select results_eq(
  $$ select jsonb_array_length(c -> 'today'), c -> 'today' -> 0 ->> 'state', c -> 'household' ->> 'senior_preferred_name'
     from public.get_agent_context('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2027-03-13 15:00Z') as c $$,
  $$ values (1, 'resolved', 'Mom') $$,
  'agent context lists today''s instances in local time');

select * from finish();
rollback;
