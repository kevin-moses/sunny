# Sunny Edge Functions

Most app traffic does not need an Edge Function: the caregiver app and the senior surfaces sign in with Supabase Auth and use PostgREST and the RPCs directly, with row level security scoping every row to the caller's household (see `notes/SCHEMA.md`). Edge Functions are only for work that needs a server secret.

## Functions

| Function | Method | Body | Response (`data`) |
|---|---|---|---|
| `livekit-token` | `POST` | `{ trigger?: 'talk' \| 'scheduled_prompt' \| 'notification_tap', taskInstanceId?: uuid }` | `{ serverUrl, roomName, participantName, participantToken }` |
| `google-oauth/start` | `POST` | `{ household_id }` (caregiver JWT) | `{ url }`: Google consent page |
| `google-oauth/callback` | `GET` | Google redirect (`code`, `state`) | HTML page |
| `jobs-run` | `POST` | `{ job_id }` with header `x-sunny-jobs-secret` | `202`, work continues in the background |

`livekit-token` requires the caller's Supabase JWT and a paired device (`public.devices`). It embeds `{ household_id, device_id, trigger, task_instance_id? }` in the participant metadata the agent reads.

`google-oauth` connects a caregiver's Google account and creates Sunny's own calendar there (see `notes/GOOGLE_CALENDAR_SETUP.md`). `jobs-run` is called only by the database (pg_net) to run a queued background job: calendar pushes and agent requests on Claude Managed Agents (see `notes/AGENT_RUNTIME.md`). Both have `verify_jwt = false` in `config.toml` and check their own credentials.

Shared code: `_shared/admin.ts` (service-role client), `_shared/google.ts` (Google OAuth and Calendar API), `_shared/agent_tools.ts` and `_shared/agent_config.ts` (the household agent's tools and prompt). Unit tests: `deno test -A supabase/functions/tests`.

All responses use the envelope:

```json
{ "data": "...", "error": null }
```

or

```json
{ "data": null, "error": { "message": "...", "code": "..." } }
```

## Secrets

See `.env.example`. Locally, copy it to `.env` and run `supabase functions serve --env-file supabase/functions/.env`; remotely, `supabase secrets set`. `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically. The database finds `jobs-run` through two Vault secrets, `sunny_functions_url` and `sunny_jobs_secret` (local values in `supabase/seed.sql`).

## Planned

- Push sender: delivers unsent `notification_outbox` rows over APNs and marks them sent
- Daily digest
- Google pull sync (Google to Sunny)
