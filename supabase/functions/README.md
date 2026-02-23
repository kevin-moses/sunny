# Sunny Edge Functions (API-1)

All client-facing data access for iOS/web runs through these Supabase Edge Functions.

## Required secrets

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Endpoints

| Function | Methods | Path | Params / Body | Response (`data`) |
|---|---|---|---|---|
| `get-user-profile` | `GET`, `OPTIONS` | `/functions/v1/get-user-profile` | Header: `Authorization: Bearer <uuid-or-token>` | `{ user, facts, reminders, recent_summaries }` |
| `get-conversations` | `GET`, `OPTIONS` | `/functions/v1/get-conversations` | Query: `limit` (default `20`), `offset` (default `0`) | `{ conversations, total }` |
| `get-messages` | `GET`, `OPTIONS` | `/functions/v1/get-messages` | Query: `conversation_id=<uuid>` | `{ messages, conversation: { summary, sentiment, topics } }` |
| `manage-reminders` | `GET`, `POST`, `DELETE`, `OPTIONS` | `/functions/v1/manage-reminders` | `POST` body: `{ type, title, description?, schedule: { times, days } }`; `DELETE` query: `reminder_id=<uuid>` | `GET: { reminders }`, `POST: { reminder }`, `DELETE: { deleted: true }` |
| `save-device-token` | `POST`, `OPTIONS` | `/functions/v1/save-device-token` | Body: `{ token: string, platform: 'ios'|'web' }` | `{ saved: true }` |

All responses are wrapped as:

```json
{ "data": "...", "error": null }
```

or

```json
{ "data": null, "error": { "message": "...", "code": "..." } }
```

## Deploy

```bash
supabase functions deploy get-user-profile
supabase functions deploy get-conversations
supabase functions deploy get-messages
supabase functions deploy manage-reminders
supabase functions deploy save-device-token
```

## Local serve

```bash
supabase functions serve
```

## Example curl (test user)

Test user ID: `00000000-0000-0000-0000-000000000001`

```bash
# get-user-profile
curl -i "http://127.0.0.1:54321/functions/v1/get-user-profile" \
  -H "Authorization: Bearer 00000000-0000-0000-0000-000000000001"

# get-conversations
curl -i "http://127.0.0.1:54321/functions/v1/get-conversations?limit=20&offset=0" \
  -H "Authorization: Bearer 00000000-0000-0000-0000-000000000001"

# get-messages
curl -i "http://127.0.0.1:54321/functions/v1/get-messages?conversation_id=<conversation-uuid>" \
  -H "Authorization: Bearer 00000000-0000-0000-0000-000000000001"

# manage-reminders GET
curl -i "http://127.0.0.1:54321/functions/v1/manage-reminders" \
  -H "Authorization: Bearer 00000000-0000-0000-0000-000000000001"

# manage-reminders POST
curl -i -X POST "http://127.0.0.1:54321/functions/v1/manage-reminders" \
  -H "Authorization: Bearer 00000000-0000-0000-0000-000000000001" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "medication",
    "title": "Take blood pressure medicine",
    "description": "With breakfast",
    "schedule": { "times": ["08:00"], "days": ["mon","tue","wed","thu","fri","sat","sun"] }
  }'

# manage-reminders DELETE
curl -i -X DELETE "http://127.0.0.1:54321/functions/v1/manage-reminders?reminder_id=<reminder-uuid>" \
  -H "Authorization: Bearer 00000000-0000-0000-0000-000000000001"

# save-device-token
curl -i -X POST "http://127.0.0.1:54321/functions/v1/save-device-token" \
  -H "Authorization: Bearer 00000000-0000-0000-0000-000000000001" \
  -H "Content-Type: application/json" \
  -d '{ "token": "device-token-value", "platform": "ios" }'
```
