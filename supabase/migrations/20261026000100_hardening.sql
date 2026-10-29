-- 20261026000100_hardening.sql
-- Purpose: Follow-ups from the Supabase security and performance advisors after the
-- first remote push.
--   * Disables pg_graphql: the apps use PostgREST and RPCs only, so the GraphQL schema
--     was pure exposure.
--   * Nothing is reachable before sign-in: revokes table and sequence grants from anon
--     (paired devices sign in anonymously and act as 'authenticated') and Supabase's
--     schema-level default grants to anon. Postgres's global PUBLIC execute on new
--     functions cannot be revoked per schema, so every RPC revokes PUBLIC and anon
--     explicitly; supabase/tests/scheduler.test.sql fails if any public function is
--     callable by anon.
--   * One SELECT policy per table: each "for all" write policy becomes separate insert,
--     update and delete policies. Escalation steps check their policy through
--     private.can_edit_policy().
--   * Indexes for foreign keys on low-write tables that cascades and unpairing scan.

drop extension if exists pg_graphql;

-- ---------------------------------------------------------------------------
-- No access before sign-in
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;

-- ---------------------------------------------------------------------------
-- One SELECT policy per table
-- ---------------------------------------------------------------------------

-- Household-scoped tables whose writes all use private.can_edit(household_id).
do $$
declare
  v_table text;
  v_prefix text;
begin
  for v_table, v_prefix in
    select * from (values
      ('escalation_policies', 'policies'),
      ('tasks', 'tasks'),
      ('events', 'events'),
      ('life_profile_entries', 'life_profile'),
      ('sensitive_topics', 'sensitive_topics')
    ) as t (table_name, prefix)
  loop
    execute format('drop policy %I on public.%I', v_prefix || '_write', v_table);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (private.can_edit(household_id))',
      v_prefix || '_insert', v_table);
    execute format(
      'create policy %I on public.%I for update to authenticated using (private.can_edit(household_id)) with check (private.can_edit(household_id))',
      v_prefix || '_update', v_table);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (private.can_edit(household_id))',
      v_prefix || '_delete', v_table);
  end loop;
end;
$$;

-- True when the signed-in user may edit the escalation policy (and so its steps).
create or replace function private.can_edit_policy(p_policy_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.escalation_policies p
    where p.id = p_policy_id and private.can_edit(p.household_id)
  )
$$;

drop policy steps_write on public.escalation_steps;
create policy steps_insert on public.escalation_steps for insert to authenticated
  with check (private.can_edit_policy(policy_id));
create policy steps_update on public.escalation_steps for update to authenticated
  using (private.can_edit_policy(policy_id)) with check (private.can_edit_policy(policy_id));
create policy steps_delete on public.escalation_steps for delete to authenticated
  using (private.can_edit_policy(policy_id));

-- ---------------------------------------------------------------------------
-- Foreign-key indexes on low-write tables (hot tables like task_instances and the
-- outbox are already covered by existing indexes or rarely cascade)
-- ---------------------------------------------------------------------------

create index tasks_household_policy_idx on public.tasks (household_id, escalation_policy_id);
create index dose_log_household_task_idx on public.dose_log (household_id, task_id);
create index conversations_device_idx on public.conversations (device_id);
create index agent_questions_conversation_idx on public.agent_questions (conversation_id);
create index agent_memory_conversation_idx on public.agent_memory (conversation_id);
