# Sunny: Phase 2 — Epic/Ticket Breakdown with Claude Code Agent Prompts
# Updated: Includes API-2/API-3, all clients use API, scraper for new workflows

## Additional Workstreams
```bash
git worktree add ../sunny-notify      feature/notifications
git worktree add ../sunny-caregiver   feature/caregiver-dashboard
# Reuse ../sunny-api for API-2, API-3
# Reuse ../sunny-agent for EPIC-AGENT-V2
# Reuse ../sunny-ios for IOS notification updates
# Reuse ../sunny-workflows for AGENT-V2-3
```

## Dependency Graph
```
Phase 1 complete ──────────────────────────────────────────────┐
EPIC-API-P2: API-2 (caregiver endpoints), API-3 (agent callbacks) │
EPIC-NOTIFY (depends on DB-1 ✅, IOS-1 ✅, API-1 ✅) ────────┤
EPIC-ADHERENCE (depends on NOTIFY-2) ─────────────────────────┼──> INT-2
EPIC-CG (depends on API-2, ADHERENCE-1) ──────────────────────┤
EPIC-AGENT-V2 (depends on Phase 1 logs) ──────────────────────┘
```

---

# EPIC-API-P2: API Layer — Phase 2 Endpoints

**Workstream:** `feature/api` | **Dependencies:** DB-1 ✅, API-1 (Phase 1)

---

## API-2: Caregiver-facing API endpoints

**Size:** M (3-4h) | **Depends on:** API-1 (shared utilities), ADHERENCE-1 (adherence_log table)

**Acceptance Criteria:**
- Caregiver dashboard data available in 1-2 API calls
- Endpoints enforce caregiver-senior relationship pattern (via caregiver_links)
- Alerts and escalation data surfaced efficiently

**Agent Prompt:**
```
Create Supabase Edge Functions for the caregiver dashboard. These serve
Sarah (caregiver) looking at Margaret's (senior) data.

Use the _shared/response.ts and _shared/supabase.ts from API-1.

1. supabase/functions/caregiver-dashboard/index.ts
   GET ?senior_id=uuid
   Returns everything the dashboard needs in ONE call:
   {
     senior: { name, last_active: timestamp },
     today: {
       adherence: [{ reminder_title, scheduled_time, status, confirmed_at }],
       conversations: [{ started_at, duration_minutes, summary, sentiment, topics }],
       alerts: [{ type: 'escalation'|'concern', message, timestamp }]
     },
     week: {
       adherence_rate: 0.85,
       conversation_count: 12,
       avg_session_minutes: 4.2,
       flagged_concerns: ["mentioned not sleeping well twice"]
     }
   }
   This is a composite endpoint joining across multiple tables.
   Optimized for single network call on mobile.

2. supabase/functions/caregiver-conversations/index.ts
   GET ?senior_id=uuid&days=7&limit=20&offset=0
   Returns conversation list with summaries for a date range.

3. supabase/functions/caregiver-reminders/index.ts
   GET ?senior_id=uuid — list senior's active reminders
   POST — create reminder for senior
   PUT ?reminder_id=uuid — update reminder
   DELETE ?reminder_id=uuid — soft delete

4. supabase/functions/caregiver-register/index.ts
   POST — register caregiver device for push notifications
   Body: { fcm_token, platform, senior_id }
   Creates/updates caregiver_devices and caregiver_links rows.

5. supabase/functions/caregiver-settings/index.ts
   GET ?senior_id=uuid — notification preferences
   PUT — update (notify_escalations, notify_daily_summary)

AUTHORIZATION PATTERN:
Caregiver endpoints MUST verify caregiver has a caregiver_links row with
the requested senior_id. For MVP: skip check but add query structure as
comment. Phase 3: enforce via Supabase Auth JWT.

PERFORMANCE: caregiver-dashboard is most critical — called every time
Sarah opens the app. Use parallel queries, not sequential. Consider a
Postgres function for the full payload.
```

---

## API-3: Agent callback endpoints

**Size:** S (2-3h) | **Depends on:** API-1 (shared utilities)

**Acceptance Criteria:**
- Agent can POST session lifecycle events
- Centralized business logic for session end (summary, fact extraction, alerts)
- Endpoints authenticated via service role key

**Agent Prompt:**
```
Create Supabase Edge Functions for the Python voice agent to call.
These centralize business logic for session events.

Server-to-server auth via service role key.

1. supabase/functions/session-start/index.ts
   POST body: { user_id, trigger: 'app_open'|'notification_tap'|'watch_tap',
                reminder_id?, adherence_log_id? }
   Creates conversation row.
   Returns: { conversation_id, reminder_context? }

2. supabase/functions/session-end/index.ts
   POST body: { conversation_id, summary, sentiment, topics,
                extracted_facts: [{category, key, value}],
                flagged_concerns: [string],
                wellness_data?: {mood_score, topics_discussed} }
   Updates conversation (ended_at, status).
   Inserts session_summary.
   Upserts extracted facts via upsert_user_fact.
   Creates caregiver alerts if flagged_concerns non-empty.

3. supabase/functions/log-adherence/index.ts
   POST body: { adherence_log_id, status, notes }
   Updates adherence_log row.

AUTH CHECK:
  if (authHeader !== 'Bearer ' + Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    return error('Unauthorized', 'auth_failed', 401)

These are NOT callable from client apps.
```

---

# EPIC-NOTIFY: Push Notifications

**Workstream:** `feature/notifications` | **Dependencies:** DB-1 ✅, IOS-1 ✅

---

## NOTIFY-1: Firebase Cloud Messaging setup + iOS integration

**Size:** M (2-3h) | **Depends on:** IOS-1 ✅, API-1 (for token storage)

**Acceptance Criteria:**
- Firebase project configured with APNs key
- iOS app registers for pushes and stores FCM token via API
- Test push from Firebase console arrives on device
- Notification tap opens app and starts voice session

**Agent Prompt:**
```
Set up Firebase Cloud Messaging for push notifications in the Sunny iOS app.

FIREBASE SETUP (document steps for developer):
- Create Firebase project "Sunny"
- Add iOS app with bundle ID
- Download GoogleService-Info.plist
- Upload APNs .p8 key
- Enable Cloud Messaging API

iOS APP UPDATES:
New file: Services/NotificationService.swift
Update: SunnyApp.swift (add UIApplicationDelegate)

- Add firebase-ios-sdk via SPM (FirebaseMessaging module)
- Request notification permission: "Sunny would like to send you reminders
  about your medications and appointments. Is that OK?"
- On token received: store via SunnyAPIClient.shared.saveDeviceToken(token:)
  (uses the POST /save-device-token API endpoint from API-1)
- On token refresh: call saveDeviceToken again (upserts)

NEW TABLE (add migration):
CREATE TABLE device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) NOT NULL,
  token text NOT NULL,
  platform text DEFAULT 'ios',
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, platform)
);

NOTIFICATION TAP HANDLING:
- If app backgrounded/terminated: open app, auto-connect to LiveKit
- Pass notification context (reminder_id, type, title) via LiveKit
  participant metadata so agent knows this was reminder-triggered
- Agent greets accordingly: "Hi Margaret! It's time for your blood
  pressure medication. Did you take it?"

Include step-by-step setup README.
```

---

## NOTIFY-2: Scheduled reminder Edge Function

**Size:** M (3-4h) | **Depends on:** NOTIFY-1, DB-2 ✅

**Acceptance Criteria:**
- pg_cron runs every minute
- Due reminders trigger FCM push notifications
- Double-send prevention via last_triggered check
- Notification content varies by reminder type

**Agent Prompt:**
```
Create a Supabase Edge Function that sends push notifications for due
reminders via Firebase Cloud Messaging.

File: supabase/functions/send-reminders/index.ts

Architecture: pg_cron (every minute) -> pg_net -> Edge Function ->
              query due reminders -> FCM push

EDGE FUNCTION:
1. Call get_due_reminders(now()) database function
2. For each due reminder:
   a. Look up user's FCM token from device_tokens
   b. Send via FCM HTTP v1 API
   c. Call mark_reminder_triggered(reminder_id)
3. If FCM returns token-not-registered, mark token invalid. Log all sends.

FCM AUTH: Firebase service account key as Supabase secret. Generate
OAuth2 token, cache for 1 hour.

PG_CRON SETUP SQL:
SELECT cron.schedule('send-due-reminders', '* * * * *',
  $$SELECT net.http_post(url:='<URL>/functions/v1/send-reminders',
    headers:=jsonb_build_object('Authorization','Bearer <SERVICE_KEY>',
    'Content-Type','application/json'), body:='{}'::jsonb);$$);

NOTIFICATION CONTENT BY TYPE:
- medication: "Time for your [title] 💊"
- appointment: "Reminder: [title] coming up 📅"
- exercise: "Time for your [title] 🏃"
- wellness_checkin: "Sunny would love to check in ☀️"
- custom: "[title]"

Include deployment instructions and secrets setup docs.
```

---

# EPIC-ADHERENCE: Medication Adherence Loop

**Workstream:** `feature/notifications` | **Dependencies:** NOTIFY-2, AGENT-3 ✅

---

## ADHERENCE-1: Adherence tracking table and agent confirmation

**Size:** M (3-4h) | **Depends on:** NOTIFY-2, AGENT-3 ✅

**Acceptance Criteria:**
- Medication push → voice session → agent asks "did you take it?" → logged
- adherence_log table tracks status: pending/confirmed/skipped/missed/escalated
- Agent handles: "yes", "already took it", "I'll take it now", "skipping today"

**Agent Prompt:**
```
Implement closed-loop medication adherence in the Sunny agent and database.

New table:
CREATE TABLE adherence_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id uuid REFERENCES reminders(id) NOT NULL,
  user_id uuid REFERENCES users(id) NOT NULL,
  scheduled_time timestamptz NOT NULL,
  status text DEFAULT 'pending',
  confirmed_at timestamptz,
  followup_count integer DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now()
);
INDEX on (user_id, status, created_at DESC);

AGENT SIDE (update tools.py):
New tool: confirm_medication(adherence_log_id, status, notes)
- "yes" → status='confirmed', confirmed_at=now()
- "already took it" → status='confirmed', notes="Taken earlier"
- "I'll take it now" → status='confirmed', notes="Taking now"
- "skipping" → status='skipped', notes=reason

When voice session starts from medication notification (detect from
participant metadata):
1. Greet: "Hi Margaret! It's time for your [medication]. Did you take it?"
2. Listen, call confirm_medication tool
3. After: "Great, I've noted that. Anything else?"

SEND-REMINDERS UPDATE:
When sending medication-type push, also insert adherence_log row with
status='pending'. Include adherence_log_id in push data payload.
```

---

## ADHERENCE-2: Follow-up escalation Edge Function

**Size:** S (2-3h) | **Depends on:** ADHERENCE-1

**Acceptance Criteria:**
- Unconfirmed medications get follow-up push at +15 minutes
- Second follow-up at +30 minutes
- After second follow-up, status set to 'escalated'
- Escalated items visible to caregiver dashboard via API-2

**Agent Prompt:**
```
Create an escalation Edge Function for unconfirmed medication reminders.

File: supabase/functions/adherence-followup/index.ts

LOGIC:
1. Query: adherence_log WHERE status='pending' AND created_at < now()-15min
   AND followup_count < 2
2. For each: send follow-up FCM push, increment followup_count
   - First: "Just checking — did you take your [medication]? 💊"
   - Second: "Margaret, Sunny is a little worried. Please take your
     [medication] or let me know you're OK."
3. Query: WHERE status='pending' AND followup_count >= 2 AND created_at < now()-45min
4. For each: set status='escalated'

PG_CRON:
SELECT cron.schedule('adherence-followup', '*/5 * * * *',
  $$SELECT net.http_post(...)$$);

The escalation status is surfaced via API-2's caregiver-dashboard endpoint.
```

---

# EPIC-CG: Caregiver Dashboard

**Workstream:** `feature/caregiver-dashboard` | **Dependencies:** API-2, ADHERENCE-1

---

## CG-1: Caregiver web dashboard MVP

**Size:** L (8-10h) | **Depends on:** API-2, ADHERENCE-1

**Acceptance Criteria:**
- Mobile-first web app showing senior's activity
- All data fetched through API-2 endpoints (NOT direct Supabase queries)
- Today's medication adherence with green/yellow/red status
- Recent conversation summaries
- Escalation alerts prominently displayed

**Agent Prompt:**
```
Build the caregiver dashboard web app for Sunny. Sarah (caregiver) views
this on her phone to check on Margaret (senior).

Stack: Next.js 14 App Router + Tailwind CSS. Deploy to Vercel free tier.

CRITICAL: All data comes from the Sunny REST API (API-2 endpoints).
Do NOT use Supabase JS client directly. Create a CaregiverAPIClient that
mirrors the pattern from iOS's SunnyAPIClient:

class CaregiverAPIClient:
  baseURL = process.env.NEXT_PUBLIC_API_URL  // Supabase functions URL
  seniorId = process.env.NEXT_PUBLIC_SENIOR_ID  // hardcoded for MVP

  fetchDashboard() → GET /caregiver-dashboard?senior_id=X
  fetchConversations(days) → GET /caregiver-conversations?senior_id=X&days=N
  fetchReminders() → GET /caregiver-reminders?senior_id=X
  updateSettings(settings) → PUT /caregiver-settings?senior_id=X

LAYOUT (mobile-first, single page):

1. HEADER: "Sunny — Margaret's Dashboard" + last-active indicator

2. ALERTS (top, most prominent):
   Red cards for escalated adherence from today.alerts
   Orange cards for flagged concerns from today.alerts

3. MEDICATION ADHERENCE (today):
   For each in today.adherence: pill name, time, status indicator
   ✅ Confirmed (green), ⏳ Pending (yellow), ❌ Missed (red),
   ⏭️ Skipped (gray), 🚨 Escalated (red pulse)

4. RECENT CONVERSATIONS:
   From today.conversations + fetchConversations(7)
   Card per conversation: date, duration, summary, sentiment emoji
   Expandable for topic tags

5. REMINDERS OVERVIEW:
   From fetchReminders(). List all active with schedule info. Read-only for MVP.

6. WEEKLY SUMMARY:
   From week.* fields: adherence rate, conversation count, avg duration
   Simple stat cards.

DESIGN: Clean, calm — caregiver is anxious, don't add stress.
Green = good, yellow = attention, red = action needed.
Large text, touch-friendly. Light/dark mode via Tailwind.

MVP: hardcode senior_id, no auth. TODO: Supabase Auth in Phase 3.
```

---

## CG-2: Caregiver push notifications for escalations

**Size:** S (2-3h) | **Depends on:** CG-1, NOTIFY-1

**Acceptance Criteria:**
- When adherence_log status='escalated', caregiver gets push notification
- Caregiver taps notification → opens dashboard to alerts section
- Notification registered via API

**Agent Prompt:**
```
Add caregiver push notifications for medication escalations.

New tables:
CREATE TABLE caregiver_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_user_id uuid NOT NULL,
  senior_user_id uuid REFERENCES users(id) NOT NULL,
  relationship text,
  notify_escalations boolean DEFAULT true,
  notify_daily_summary boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE caregiver_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_user_id uuid NOT NULL,
  fcm_token text NOT NULL,
  platform text DEFAULT 'ios',
  updated_at timestamptz DEFAULT now(),
  UNIQUE(caregiver_user_id, platform)
);

UPDATE adherence-followup Edge Function:
When setting status='escalated', also:
1. Query caregiver_links WHERE senior_user_id=X AND notify_escalations=true
2. For each: look up FCM token from caregiver_devices
3. Send FCM push: "⚠️ Margaret hasn't confirmed her 9 AM blood pressure
   medication. Tap to view dashboard."

For MVP: manually insert caregiver_links and caregiver_devices rows for
test caregiver. Caregiver registers via POST /caregiver-register (API-2).
```

---

# EPIC-AGENT-V2: Agent Iteration

**Workstream:** `feature/agent-brain` | **Dependencies:** Phase 1 complete

---

## AGENT-V2-1: System prompt iteration from testing logs

**Size:** M (3-4h) | **Depends on:** Phase 1 testing complete

**Acceptance Criteria:**
- Conversation logs analyzed for failure patterns
- System prompt updated to address identified issues
- Voice UX parameters retuned if needed
- Changes documented in CHANGELOG.md

**Agent Prompt:**
```
Analyze Phase 1 conversation logs and iterate on the Sunny agent.

Query Supabase for all conversations and messages. Analyze for:

1. FAILURE PATTERNS: unhelpful responses, senior confusion, workflow
   breakdowns, unhandled requests
2. SYSTEM PROMPT UPDATES: better failure handling, new topics, improved
   transitions, persona tweaks
3. VOICE UX TUNING: endpointing delay, barge-in, TTS speed
4. NEW KNOWLEDGE: iPhone tasks not covered

Document all changes in CHANGELOG.md with before/after and rationale.
```

---

## AGENT-V2-2: Wellness check-in conversations

**Size:** M (3-4h) | **Depends on:** NOTIFY-2

**Acceptance Criteria:**
- Daily wellness check-in triggers push → voice session
- Agent asks about mood, sleep, eating conversationally (not as questionnaire)
- Responses logged and summarized for caregiver dashboard via API-3
- Default wellness_checkin reminder created for new users

**Agent Prompt:**
```
Add proactive wellness check-in conversations to the Sunny agent.

Scheduled via reminder type='wellness_checkin' → push → voice session.

SYSTEM PROMPT UPDATE:
When session starts from wellness_checkin:
- DON'T ask a list of questions. Warm conversation, not a form.
- Start: "Good morning, Margaret! How are you feeling today?"
- Follow naturally. "I'm tired" → ask about sleep. "Fine" → ask about plans.
- Gently cover IF natural: mood, sleep, eating, pain, social, plans
- Keep to 3-5 minutes. Don't interrogate.
- End warmly: "Lovely chatting, Margaret. Have a wonderful day!"

POST-SESSION: Summary includes mood_score (1-5), topics_discussed,
concerns. Use API-3's session-end endpoint to store structured data.

DEFAULT: Create wellness_checkin reminder for 10:00 AM daily on new user setup.

TOOL: complete_wellness_checkin(mood_score, topics_discussed, concerns)
called at end to structure data.
```

---

## AGENT-V2-3: Expand workflow library from user testing

**Size:** M (3-4h) | **Depends on:** Phase 1 testing, WF-2, WF-0

**Acceptance Criteria:**
- 5+ new workflows based on actual user requests from Phase 1 testing
- Generated using WF-0 scraper where Apple docs exist
- Edge cases from testing addressed in existing workflows

**Agent Prompt:**
```
Based on Phase 1 conversation logs, create new workflows and fix existing ones.
Use the Apple docs scraper (WF-0) to accelerate workflow creation.

1. ANALYZE LOGS: Query conversations where senior asked for phone help.
   Identify uncovered tasks, stuck points, missing trigger phrases.

2. CREATE NEW WORKFLOWS:
   - For tasks with Apple support docs: find the URL, run the scraper:
     python scripts/generate_workflow.py --url <url> --id <id> --output workflows/<id>.json
   - Review and polish the generated output
   - For tasks without Apple docs: manually author following the schema

3. FIX EXISTING WORKFLOWS:
   - Add missing trigger phrases from testing
   - Add new common_issues from real confusions
   - Improve wording where seniors got stuck
   - Fix incorrect navigation paths

4. UPDATE workflow_engine.py trigger map with new workflows.

Document: what was requested, what was created/fixed, evidence from logs.
```

---

## WF-4: Migrate workflows to Supabase with embedding retrieval

**Size:** M (3-4h) | **Depends on:** WF-2 (engine exists), DB-1 ✅

**Acceptance Criteria:**
- Workflows and steps stored in Supabase `workflows` + `workflow_steps` tables
- pgvector embeddings (OpenAI text-embedding-3-small, 1536 dims) on workflow title+description
- `match_workflow` RPC returns best semantic match via cosine similarity with HNSW index
- `get_workflow_steps` RPC returns version-specific steps with automatic fallback
- Ingestion script loads all 88 JSON files + 896 manifest entries, idempotent via upsert
- `WorkflowEngine` refactored to query Supabase instead of loading from disk
- Same external interface (`find_workflow`, `resolve_workflow`) so agent.py changes are minimal
- `find_workflow` latency under 500ms (embedding generation + pgvector query)
- In-memory cache for resolved workflows avoids repeated step fetches
- JSON files remain source of truth for editing/versioning; Supabase is runtime store
- All existing tests pass with updated mocks

**Agent Prompt:**
```
Migrate Sunny's workflow system from local JSON files to Supabase with
pgvector embedding-based retrieval. The current system loads 88 JSON
files + 896-entry manifest into memory at startup and uses token-overlap
scoring. Replace with semantic search.

STEP 1: Database migration (supabase/migrations/004_workflows.sql)
- Enable pgvector extension
- Create `workflows` table: id (text PK), title, description, version,
  estimated_minutes, source_type, source_urls, has_steps (boolean),
  embedding (vector(1536)), created_at, updated_at
- HNSW index on embedding column (vector_cosine_ops, m=16, ef_construction=64)
- Create `workflow_steps` table: workflow_id (FK), ios_version (text: '16',
  '18', '26', or 'fallback'), step_index, step_id, instruction, visual_cue,
  confirmation_prompt, success_indicators, common_issues (jsonb), fallback,
  next_step. Unique on (workflow_id, ios_version, step_id).
- RPC `match_workflow(query_embedding vector, match_threshold float,
  match_count int)`: cosine similarity search returning (workflow_id, title,
  description, has_steps, similarity)
- RPC `get_workflow_steps(p_workflow_id text, p_ios_version text)`: returns
  steps with automatic fallback to 'fallback' version if requested iOS
  version has no steps

STEP 2: Ingestion script (sunny_agent/scripts/ingest_workflows.py)
- Standalone CLI, not part of agent runtime
- Load manifest.yaml (896 entries) + workflows/*.json (88 files)
- Generate embeddings via OpenAI text-embedding-3-small in batches of 100
- Embedding text per workflow: "{title}: {description}" (just title for
  manifest-only entries)
- Upsert into workflows table (ON CONFLICT on id)
- For each JSON file: insert steps for each ios_version + fallback_steps
  (ios_version stored as 'fallback')
- Idempotent, safe to re-run after editing JSON files
- Requires SUPABASE_URL, SUPABASE_SECRET_KEY, OPENAI_API_KEY env vars

STEP 3: Refactor WorkflowEngine (sunny_agent/src/workflow_engine.py)
- Keep WorkflowStep + WorkflowState dataclasses identical
- Constructor: __init__(supabase: AsyncClient) instead of file paths
- find_workflow() becomes async: generate embedding via openai.AsyncOpenAI,
  call match_workflow RPC, return (id, title, has_steps)
- resolve_workflow() becomes async: call get_workflow_steps RPC, build
  WorkflowState from DB rows
- Add _step_cache dict for resolved workflows (avoids re-fetching in session)
- Remove all file loading, token matching, stopword logic

STEP 4: Update agent.py
- entrypoint(): replace WorkflowEngine(workflows_dir=..., manifest_path=...)
  with WorkflowEngine(supabase=supabase) -- supabase client already exists
- start_workflow(): add await to find_workflow() and resolve_workflow() calls
- Remove unused Path import and repo_root computation

STEP 5: Dependencies and config
- Add "openai>=1.0.0" to pyproject.toml (explicit, currently transitive)
- Add EMBEDDING_MODEL and WORKFLOW_MATCH_THRESHOLD to config.py

STEP 6: Update tests
- _make_assistant(): change WorkflowEngine mock to use AsyncClient
- Patch find_workflow and resolve_workflow with AsyncMock
```

---

# Phase 2 Integration Testing

## INT-2: Full notification → adherence → caregiver flow test

**Size:** S (2h) | **Depends on:** All Phase 2 tickets

**Acceptance Criteria:**
- Full flow from scheduled reminder to caregiver alert, all through API

**Agent Prompt:**
```
Write integration test checklist for Phase 2 notification and adherence flow.

HAPPY PATH:
1. Create medication reminder for 2 minutes from now
2. Wait for pg_cron → push notification arrives
3. Tap notification → app opens → voice session starts
4. Agent: "Time for your blood pressure medication. Did you take it?"
5. Say "yes" → adherence_log updated to 'confirmed'
6. curl GET /caregiver-dashboard → green checkmark in today.adherence

ESCALATION PATH:
1. Create reminder, receive push, DON'T respond
2. +15 min → follow-up push arrives
3. +30 min → second follow-up
4. +45 min → status='escalated'
5. Caregiver receives escalation push
6. curl GET /caregiver-dashboard → red alert in today.alerts

WELLNESS CHECK-IN:
1. Create wellness_checkin reminder, tap notification
2. Agent starts warm conversation (not medication mode)
3. 3-minute chat → end session
4. curl GET /caregiver-dashboard → conversation with mood_score

API VERIFICATION:
- All dashboard data comes through API-2 endpoints
- Agent lifecycle events go through API-3 endpoints
- No direct Supabase queries from any client

EDGE CASES:
- Notification while app in foreground / terminated
- Supabase temporarily down during voice confirmation
- Two reminders fire simultaneously
- Caregiver dashboard with empty state (new user)

Create test_phase2_checklist.md with pass/fail columns.
```

---

# Ticket Summary

## Phase 1 (16 tickets, ~33-45 hours)

| Ticket | Epic | Size | Depends On | Status | Workstream |
|--------|------|------|------------|--------|------------|
| DB-1 | Database | S | — | ✅ | sunny-db |
| DB-2 | Database | S | DB-1 | ✅ | sunny-db |
| AGENT-1 | Agent | M | — | ✅ | sunny-agent |
| AGENT-2 | Agent | M | AGENT-1, DB-1 | ✅ | sunny-agent |
| AGENT-3 | Agent | M | AGENT-2 | ✅ | sunny-agent |
| AGENT-4 | Agent | S | AGENT-1 | ✅ | sunny-agent |
| IOS-1 | iOS | M | — | ✅ | sunny-ios |
| IOS-2 | iOS | S | — | ✅ | sunny-ios |
| **API-1** | **API** | **M** | **DB-1 ✅, DB-2 ✅** | ⬜ | sunny-api |
| IOS-3 | iOS | S | IOS-1 ✅ | ⬜ | sunny-ios |
| IOS-4 | iOS | S | IOS-1 ✅, API-1 | ⬜ | sunny-ios |
| WF-1 | Workflows | S | — | ⬜ | sunny-workflows |
| **WF-0** | **Workflows** | **M** | **WF-1** | ⬜ | sunny-workflows |
| WF-2 | Workflows | M | WF-1, AGENT-1 ✅ | ⬜ | sunny-workflows |
| WF-3 | Workflows | M | WF-0, WF-1 | ⬜ | sunny-workflows |
| INT-1 | Integration | S | All above | ⬜ | any |

**Remaining: 8 tickets, ~22-32 hours**

## Phase 2 (12 tickets, ~40-55 hours)

| Ticket | Epic | Size | Depends On | Status | Workstream |
|--------|------|------|------------|--------|------------|
| **API-2** | **API** | **M** | **API-1, ADHERENCE-1** | ⬜ | sunny-api |
| **API-3** | **API** | **S** | **API-1** | ⬜ | sunny-api |
| NOTIFY-1 | Notifications | M | IOS-1 ✅, API-1 | ⬜ | sunny-notify |
| NOTIFY-2 | Notifications | M | NOTIFY-1, DB-2 ✅ | ⬜ | sunny-notify |
| ADHERENCE-1 | Adherence | M | NOTIFY-2, AGENT-3 ✅ | ⬜ | sunny-notify |
| ADHERENCE-2 | Adherence | S | ADHERENCE-1 | ⬜ | sunny-notify |
| CG-1 | Caregiver | L | API-2, ADHERENCE-1 | ⬜ | sunny-caregiver |
| CG-2 | Caregiver | S | CG-1, NOTIFY-1 | ⬜ | sunny-caregiver |
| AGENT-V2-1 | Agent V2 | M | Phase 1 done | ⬜ | sunny-agent |
| AGENT-V2-2 | Agent V2 | M | NOTIFY-2 | ⬜ | sunny-agent |
| AGENT-V2-3 | Agent V2 | M | Phase 1 done, WF-0 | ⬜ | sunny-workflows |
| **WF-4** | **Workflows** | **M** | **WF-2, DB-1 ✅** | ⬜ | sunny-workflows |
| INT-2 | Integration | S | All above | ⬜ | any |

## Parallel Execution Plan

```
Phase 1 Remaining (~1-2 weeks):
  sunny-api:       API-1 ─────────────────────────────────> done
  sunny-ios:       IOS-3 ──> IOS-4 (blocked on API-1) ───> done
  sunny-workflows: WF-1 ──> WF-0 ──> WF-3 ──────────────> done
                        └────────> WF-2 ─────────────────> done
  Integration:     ──────────────────────────────────────> INT-1

Phase 2 (~3-4 weeks):
  sunny-api:       API-3 ──────────────> API-2 (after ADHERENCE-1) ──> done
  sunny-notify:    NOTIFY-1 ──> NOTIFY-2 ──> ADHERENCE-1 ──> ADHERENCE-2
  sunny-caregiver: ─────────────────────────── CG-1 (after API-2) ──> CG-2
  sunny-agent:     AGENT-V2-1 ──> AGENT-V2-2
  sunny-workflows: WF-4 (can start immediately) ──> AGENT-V2-3
  Integration:     ────────────────────────────────────────────────> INT-2
```

## Full Project Summary

```
Total tickets:  29 (16 Phase 1 + 13 Phase 2)
Completed:       8 (DB-1, DB-2, AGENT-1-4, IOS-1, IOS-2)
Remaining:      21 (8 Phase 1 + 13 Phase 2)
Est. hours:     65-91 hours remaining
Est. timeline:  4-6 weeks at ~15-20 hours/week
```
