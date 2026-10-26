# Sunny Edge Functions

Most app traffic does not need an Edge Function: the caregiver app and the senior surfaces sign in with Supabase Auth and use PostgREST and the RPCs directly, with row level security scoping every row to the caller's household (see `notes/SCHEMA.md`). Edge Functions are only for work that needs a server secret.

## Functions

| Function | Method | Body | Response (`data`) |
|---|---|---|---|
| `livekit-token` | `POST` | `{ trigger?: 'talk' \| 'scheduled_prompt' \| 'notification_tap', taskInstanceId?: uuid }` | `{ serverUrl, roomName, participantName, participantToken }` |

`livekit-token` requires the caller's Supabase JWT and a paired device (`public.devices`). It embeds `{ household_id, device_id, trigger, task_instance_id? }` in the participant metadata the agent reads.

All responses use the envelope:

```json
{ "data": "...", "error": null }
```

or

```json
{ "data": null, "error": { "message": "...", "code": "..." } }
```

## Secrets

- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SERVER_URL` (set with `supabase secrets set`)
- `SUPABASE_URL` and `SUPABASE_ANON_KEY` are provided automatically

## Planned

- Push sender: delivers unsent `notification_outbox` rows over APNs and marks them sent
- Daily digest
