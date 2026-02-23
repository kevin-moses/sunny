# Sunny: Phase 1 — Epic/Ticket Breakdown with Claude Code Agent Prompts
# Updated: Includes API layer, Apple docs scraper, completed ticket status

## Workstream Setup
```bash
git worktree add ../sunny-agent       feature/agent-brain      # ✅ COMPLETE
git worktree add ../sunny-ios         feature/ios-app
git worktree add ../sunny-db          feature/database         # ✅ COMPLETE
git worktree add ../sunny-api         feature/api
git worktree add ../sunny-workflows   feature/guided-workflows
```

## Dependency Graph
```
EPIC-DB ✅ ──────────> EPIC-API ────────────────────────┐
EPIC-AGENT ✅ ─────────────────────────────────────────┤
EPIC-IOS (IOS-1 ✅, IOS-2 ✅) ─────────────────────────┼──> INT-1
EPIC-WF: WF-1 ──> WF-0 ──> WF-3 (auto-generated) ────┤
          └──────────────> WF-2 (needs AGENT-1 ✅) ────┘
```

## Completion Status
```
✅ DB-1       Core Supabase schema
✅ DB-2       Helper database functions
✅ AGENT-1    Base LiveKit agent with senior-optimized voice UX
✅ AGENT-2    Supabase integration — memory and logging
✅ AGENT-3    Reminder tool functions
✅ AGENT-4    Error handling hardening
✅ IOS-1      Base SwiftUI app with LiveKit voice
✅ IOS-2      LiveKit token Edge Function
⬜ API-1      Senior-facing REST API endpoints (NEW)
⬜ IOS-3      Accessibility polish
⬜ IOS-4      Developer conversation log view (UPDATED — uses API)
⬜ WF-1       JSON schema and first 3 workflows
⬜ WF-0       Apple support docs scraper (NEW — depends on WF-1)
⬜ WF-2       Workflow engine in the agent
⬜ WF-3       Expand to 10 workflows (UPDATED — uses WF-0 scraper)
⬜ INT-1      End-to-end integration test
```

---

# EPIC-API: REST API Layer

**Workstream:** `feature/api` | **Dependencies:** DB-1 ✅, DB-2 ✅ — ready to start immediately

All client-facing data access goes through these Edge Function endpoints.
The Python voice agent continues to use direct supabase-py (backend-to-backend).

---

## API-1: Senior-facing API endpoints

**Size:** M (3-4h) | **Depends on:** DB-1 ✅, DB-2 ✅

**Acceptance Criteria:**
- All endpoints return consistent JSON: `{ data: ..., error: null }` or `{ data: null, error: { message, code } }`
- CORS configured for iOS app and future web dashboard
- MVP auth pattern established (reads Authorization header, defaults to test user)
- Each endpoint handles missing/invalid params gracefully

**Agent Prompt:**
```
Create Supabase Edge Functions that serve as the REST API for Sunny's
client applications. ALL client-facing data access goes through these
endpoints — no direct Supabase table queries from iOS or web clients.
The Python voice agent continues to use direct supabase-py calls
(backend-to-backend), which is fine.

Directory: supabase/functions/

STEP 1: Create shared utilities.

File: supabase/functions/_shared/response.ts
- success(data, status=200): returns Response with { data, error: null }
- error(message, code, status=400): returns Response with { data: null, error: { message, code } }
- corsHeaders(): returns headers with Access-Control-Allow-Origin: * (lock down in Phase 3)
- getUserId(req): reads Authorization: Bearer <token> header. For MVP,
  if token is UUID format use it as user_id, otherwise default to test
  user '00000000-0000-0000-0000-000000000001'. Add TODO for Phase 3 JWT validation.

File: supabase/functions/_shared/supabase.ts
- Initialize Supabase admin client using SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.
- Export for use by all Edge Functions.

STEP 2: Create endpoints.

1. supabase/functions/get-user-profile/index.ts
   GET, OPTIONS
   Calls get_user_context RPC function.
   Returns: { user: {name, ios_version, timezone}, facts: {...},
              reminders: [...], recent_summaries: [...] }

2. supabase/functions/get-conversations/index.ts
   GET, OPTIONS
   Query params: ?limit=20&offset=0
   Queries conversations for user ordered by started_at DESC.
   Calculates duration_minutes from started_at/ended_at.
   Returns: { conversations: [...], total: count }

3. supabase/functions/get-messages/index.ts
   GET, OPTIONS
   Query params: ?conversation_id=uuid
   Validates conversation belongs to user.
   Returns: { messages: [...], conversation: {summary, sentiment, topics} }

4. supabase/functions/manage-reminders/index.ts
   GET, POST, DELETE, OPTIONS
   GET: all active reminders for user.
   POST body: { type, title, description, times, days } — validates, inserts.
   DELETE ?reminder_id=uuid — validates ownership, sets active=false.
   Returns: { reminders: [...] } or { reminder: {...} } or { deleted: true }

5. supabase/functions/save-device-token/index.ts
   POST, OPTIONS
   Body: { token: string, platform: 'ios'|'web' }
   Upserts into device_tokens (unique on user_id + platform).
   Returns: { saved: true }

DESIGN RULES:
- Every endpoint handles OPTIONS for CORS preflight.
- HTTP status: 200, 201, 400, 404, 500.
- Log each request: method, path, user_id, duration.
- Use Supabase admin client (service role) since auth handled at Edge Function level.
- Each endpoint is its own folder with index.ts (Supabase convention).

STEP 3: Create deployment docs.
File: supabase/functions/README.md
- Table of all endpoints with method, path, params, response shape.
- Deployment commands: supabase functions deploy <name>
- Required env vars / secrets.
- Example curl commands for testing each endpoint.
```

---

# EPIC-IOS: iOS App (partially complete)

**Workstream:** `feature/ios-app` | **IOS-1 ✅, IOS-2 ✅**

---

## IOS-3: Accessibility polish

**Size:** S (2-3h) | **Depends on:** IOS-1 ✅ (ready to start)

**Acceptance Criteria:**
- Fully usable at largest Dynamic Type size
- All colors WCAG AA compliant
- Works with VoiceOver enabled
- Tested with Bold Text + Reduce Motion

**Agent Prompt:**
```
Polish Sunny iOS app accessibility for seniors. Review and update all Views.

TYPOGRAPHY: All body .title3 min, buttons .title2 min, status .headline min.
Never fixed font sizes. Create SunnyColors.swift with semantic palette.

COLORS: 4.5:1 minimum contrast. Don't rely on color alone. Support Dark Mode.

TAP TARGETS: All interactive 60x60pt min. Generous spacing. Talk button
120x120, End button 80x80.

VOICEOVER: accessibilityLabel on every element. Button states announced.
Connection status changes announced. Group related elements.

MOTION: Respect Reduce Motion for animations. Static fallback for visualizer.

SENIOR UX: No complex gestures. Clear feedback for every tap (haptic + visual).
Loading states always visible.

Test on Simulator with: largest Dynamic Type, Bold Text, VoiceOver,
Reduce Motion, Dark Mode. Fix all issues found.
```

---

## IOS-4: Developer conversation log view (uses API)

**Size:** S (2-3h) | **Depends on:** IOS-1 ✅, API-1

**Acceptance Criteria:**
- Long-press (3s) on title reveals conversation list
- Shows date, duration, summary, sentiment
- Tap shows full transcript as chat bubbles
- All data fetched through REST API, NOT direct Supabase queries

**Agent Prompt:**
```
Add a hidden developer conversation log to the Sunny iOS app. Accessed via
3-second long-press on "Sunny" title on HomeView.

New files:
  Views/ConversationListView.swift
  Views/ConversationDetailView.swift
  Services/SunnyAPIClient.swift

IMPORTANT: Do NOT use the Supabase Swift SDK for data access. All data
fetching goes through Sunny's REST API (Supabase Edge Functions). This
ensures a single API contract shared by all current and future clients.

SunnyAPIClient.swift — lightweight HTTP client:

class SunnyAPIClient {
    static let shared = SunnyAPIClient()
    private let baseURL: String  // "<SUPABASE_URL>/functions/v1" from AppConfig
    private let userId: String   // hardcoded test user for MVP

    // Every request includes Authorization: Bearer <userId>

    func fetchConversations(limit: Int = 20, offset: Int = 0) async throws -> ConversationsResponse
        // GET /get-conversations?limit=20&offset=0

    func fetchMessages(conversationId: String) async throws -> MessagesResponse
        // GET /get-messages?conversation_id=<id>

    func fetchUserProfile() async throws -> UserProfileResponse
        // GET /get-user-profile

    func fetchReminders() async throws -> RemindersResponse
        // GET /manage-reminders

    func saveDeviceToken(token: String, platform: String = "ios") async throws
        // POST /save-device-token
}

Response format is always { "data": <payload>, "error": null } on success.
Use Codable structs. Unwrap in the client — callers get data or thrown error.

CONVERSATION LIST: Call fetchConversations(). Display date/time, duration,
summary (truncated), sentiment emoji. Pull to refresh. NavigationStack.

CONVERSATION DETAIL: Call fetchMessages(conversationId:). Chat bubbles:
user right (blue), Sunny left (gray). Tool calls inline. Summary at bottom.

ACCESS: 3-second long-press on "Sunny" title. Dev tool — functional over pretty.

FUTURE-PROOFING: SunnyAPIClient will be reused by any future iOS views
and is the pattern the caregiver native app will follow.
```

---

# EPIC-WF: Guided Workflows

**Workstream:** `feature/guided-workflows` | **Dependencies:** AGENT-1 ✅ for engine integration

---

## WF-1: JSON schema definition

**Size:** S (1-2h) | **Depends on:** nothing (ready to start)

**Acceptance Criteria:**
- JSON schema defined, documented, and validated
- Schema supports iOS version branching, common issues, fallbacks
- README with schema documentation and example
- No workflow content yet — that comes from WF-0 scraper

**Agent Prompt:**
```
Define the JSON schema for Sunny's guided phone navigation workflows.
This ticket creates ONLY the schema and documentation — actual workflow
content will be auto-generated by the Apple docs scraper (WF-0).

Files:
  workflows/schema.json    -- JSON Schema definition
  workflows/README.md      -- Documentation with examples

SCHEMA — each workflow file structure:
{
  "id": "string (snake_case identifier)",
  "version": "string (semver)",
  "triggers": ["array of natural language phrases that activate this workflow"],
  "title": "string (human-readable title)",
  "description": "string (what this workflow helps with)",
  "estimated_minutes": "number",
  "source_url": "string (Apple support doc URL, if auto-generated)",
  "ios_versions": {
    "16": { "steps": [...] },
    "17": { "steps": [...] },
    "18": { "steps": [...] }
  },
  "fallback_steps": ["used if iOS version is unknown"]
}

Each step:
{
  "step_id": "string (unique within workflow)",
  "instruction": "string (what Sunny says — warm, clear, one action)",
  "visual_cue": "string (what the icon/button looks like)",
  "confirmation_prompt": "string (how Sunny checks if step is done)",
  "success_indicators": ["phrases that mean 'done'"],
  "common_issues": [
    {
      "trigger": ["phrases indicating this problem"],
      "response": "string (how Sunny helps)"
    }
  ],
  "fallback": "string (alternative approach if main instruction fails)",
  "next_step": "string (step_id of next step, null for final step)"
}

CONTENT RULES (document in README):
- Write as if speaking to a 72-year-old
- Concrete visual descriptions ("gray gear icon", "green phone icon")
- One action per step — never combine multiple taps
- Always confirm before proceeding
- Include rollback instructions
- Warm language ("Perfect!", "You're doing great!")
- 2-3 common issues per step minimum

Include a minimal example workflow in the README to illustrate the schema,
but do NOT create full workflows — those come from the scraper.
```

---

## WF-0: Apple support docs scraper → workflow JSON generator

**Size:** M (4-6h) | **Depends on:** WF-1 (needs schema to validate output)

**Acceptance Criteria:**
- Script scrapes Apple support docs for a given URL
- Fetches version-specific content for iOS 16, 17, and 18
- LLM transforms raw content into Sunny workflow JSON matching schema
- Output validates against schema from WF-1
- Batch mode: feed a topics file → generate multiple workflows
- Results cached locally to avoid re-fetching

**Agent Prompt:**
```
Build a Python script that scrapes Apple's iPhone User Guide and generates
Sunny workflow JSON files using an LLM to transform the content.

Files:
  scripts/generate_workflow.py   -- main CLI
  scripts/scraper.py             -- Apple docs fetcher
  scripts/transformer.py         -- LLM transformation
  scripts/validator.py           -- JSON schema validation
  scripts/workflow_topics.json   -- batch input file
  scripts/requirements.txt       -- dependencies
  scripts/README.md              -- usage documentation

THE SOURCE:
Apple's iPhone User Guide at support.apple.com/guide/iphone/<slug>/<version>
serves different content per iOS version. The same page slug returns
version-specific navigation paths when fetched with different version params.

1. SCRAPER (scraper.py):
   Input: Apple support URL + list of iOS versions ["16","17","18"]
   For each version:
   - Fetch the page (handle version selector URL pattern)
   - Parse with BeautifulSoup
   - Extract: title, numbered steps, "Go to Settings > X > Y" paths,
     "tap X" actions, any conditional instructions
   - Apple docs use consistent structure: numbered steps with Settings
     paths like "Go to Settings > Phone > Blocked Contacts"
   Output: { "16": [raw_steps], "17": [raw_steps], "18": [raw_steps] }
   
   CACHING: Store fetched pages in scripts/.cache/ directory. Don't
   re-fetch if cached within 7 days. Be polite: 1-2 second delay between requests.

2. LLM TRANSFORMER (transformer.py):
   Input: scraped content + workflow JSON schema + metadata (id, description)
   Calls GPT-4o or Claude with prompt:

   "You are generating a guided workflow JSON file for Sunny, a voice AI
   that helps seniors navigate their iPhone step by step.

   Schema: {schema}

   Raw Apple support docs for this task:
   iOS 16: {ios16_content}
   iOS 17: {ios17_content}
   iOS 18: {ios18_content}

   Transform into Sunny workflow JSON. Rules:
   - Rewrite instructions as if speaking to senior.
   - Concrete visual descriptions: 'the gray gear icon', 'a green phone icon'
   - One action per step — never combine multiple taps
   - Add confirmation prompt after each step
   - Add 2-3 common_issues per step (what could confuse a senior)
   - Add fallback per step (alternative approach)
   - Generate 5-10 trigger phrases seniors might naturally say
   - Warm language: 'Perfect!', 'You're doing great!', 'No worries!'
   - Include rollback: 'If you tapped the wrong thing, tap the back arrow'
   - If steps differ between iOS versions, create separate step arrays
   - If identical, reuse steps across versions

   Return ONLY valid JSON."

   API key from OPENAI_API_KEY or ANTHROPIC_API_KEY env vars.

3. VALIDATOR (validator.py):
   - Validates output against workflow schema from WF-1
   - Checks: required fields, unique step_ids, valid next_step references,
     non-empty triggers
   - Reports validation errors with line numbers

4. CLI:
   Single workflow:
   python scripts/generate_workflow.py \
     --url "https://support.apple.com/guide/iphone/block-or-unblock-contacts-iph3a57e498c/ios" \
     --id "unblock_contact" \
     --output "workflows/unblock_contact.json"

   Batch mode:
   python scripts/generate_workflow.py \
     --batch "scripts/workflow_topics.json" \
     --output-dir "workflows/"

5. BATCH TOPICS FILE (workflow_topics.json):
   Pre-populate with these 10 workflows:
   [
     {"id":"unblock_contact", "url":"https://support.apple.com/guide/iphone/block-or-unblock-contacts-iph3a57e498c/ios"},
     {"id":"connect_wifi", "url":"https://support.apple.com/guide/iphone/connect-to-the-internet-iph0f4d1e4b6/ios"},
     {"id":"increase_text_size", "url":"https://support.apple.com/guide/iphone/make-the-iphone-screen-easier-to-see-iph219444090c/ios"},
     {"id":"make_facetime_call", "url":"https://support.apple.com/guide/iphone/make-facetime-calls-iphb023c8ec0/ios"},
     {"id":"send_photo_message", "url":"https://support.apple.com/guide/iphone/send-photos-videos-and-audio-iphb6d2e0e08/ios"},
     {"id":"adjust_volume", "url":"https://support.apple.com/guide/iphone/adjust-the-volume-iph7d40a9dce/ios"},
     {"id":"set_alarm", "url":"https://support.apple.com/guide/iphone/set-an-alarm-iph23b0e1eba/ios"},
     {"id":"find_app", "url":"https://support.apple.com/guide/iphone/find-your-apps-in-app-library-iph87abad19a/ios"},
     {"id":"check_voicemail", "url":"https://support.apple.com/guide/iphone/check-voicemail-iph8903de593/ios"},
     {"id":"add_contact", "url":"https://support.apple.com/guide/iphone/add-and-use-contact-information-iph3e2e78c7b/ios"}
   ]

   Note: order_food_delivery has no Apple doc (third-party app).
   It stays manually authored or becomes a screen-sharing workflow in Phase 3.

POST-PROCESSING: After generation, print summary per workflow:
"Generated 'Unblock a Contact' — 7 steps (iOS 16: 7, iOS 17: 7, iOS 18: 8)"
Flag steps that differ significantly between versions.
Developer reviews output and manually polishes voice/tone (10-20 min per workflow).
```

---

## WF-2: Workflow engine in the agent

**Size:** M (3-4h) | **Depends on:** WF-1, AGENT-1 ✅

**Acceptance Criteria:**
- Agent detects phone help requests and launches appropriate workflow
- Step-by-step voice guidance works
- "Go back" and "start over" supported
- Progress persisted for session resume

**Agent Prompt:**
```
Implement the guided workflow engine in the Sunny LiveKit agent.

New file: workflow_engine.py. Update: agent.py, tools.py, prompts.py

Uses LiveKit Agent handoffs pattern:

1. WORKFLOW LOADING: On startup, load all JSON files from workflows/.
   Build trigger map: keyword/phrase -> workflow_id.

2. TRIAGE: Add `start_guided_workflow(workflow_id)` @function_tool.
   System prompt lists available workflows and triggers. When LLM detects
   phone help, it calls the tool, which triggers handoff to
   GuidedWorkflowAgent.

3. GUIDED WORKFLOW AGENT:
   - Receives workflow JSON + user's iOS version + current step index
   - Dynamic system prompt per step: "You are guiding Margaret through
     [title], step [N] of [total]. Instruction: [instruction]. Wait for
     confirmation. If confused: [common_issues]. Fallback: [fallback]."
   - Tools: confirm_step (advance), go_back, restart_workflow, exit_workflow

4. STATE: Track workflow_id, step_index, start_time in session state.
   Persist to Supabase for resume: "Welcome back! We were unblocking a
   contact — you got to the Phone settings step. Continue?"

5. iOS VERSION: Get from user_facts. Select matching step sequence.
   If unknown, use fallback_steps.

Make the engine generic — works with any valid workflow JSON without
hardcoding specific workflow logic.
```

---

## WF-3: Generate and polish 10 workflows via scraper

**Size:** M (3-4h) | **Depends on:** WF-0, WF-1

**Acceptance Criteria:**
- WF-0 scraper run against all 10 Apple support URLs in batch mode
- All 10 generated workflows validate against schema
- Each workflow human-reviewed and polished for voice UX
- Edge cases and common senior confusions added where LLM missed them

**Agent Prompt:**
```
Use the Apple docs scraper (WF-0) to generate all 10 workflows, then
review and polish the output for production quality.

STEP 1: Run the scraper in batch mode:
  python scripts/generate_workflow.py \
    --batch scripts/workflow_topics.json \
    --output-dir workflows/

STEP 2: For each generated workflow, review and polish:
  - Are the trigger phrases natural? Would a 72-year-old say these?
    Add any missing phrases.
  - Are instructions warm and clear? Rewrite any robotic language.
  - Are visual cues concrete? "Gray gear icon" not "the Settings icon."
  - Do common_issues cover the real confusions? Think about:
    * Senior doesn't know what "Settings" looks like
    * Senior accidentally taps the wrong thing
    * Senior's phone is on an unexpected screen
    * Senior has a different home screen layout
  - Are fallbacks genuinely helpful alternatives?
  - Do iOS version differences look correct? Verify any steps the
    scraper flagged as differing between versions.

STEP 3: Manually create order_food_delivery.json (no Apple doc exists):
  - Triggers: "order food", "Uber Eats", "DoorDash", "food delivery"
  - Complex multi-step: which app → open → search → menu → cart → checkout
  - Must check if app is installed first
  - Must check if payment method is saved
  - This is the longest/most complex workflow — use it to stress-test
    the workflow engine

STEP 4: Validate all 11 workflows:
  python scripts/validator.py workflows/

STEP 5: Document any Apple support pages that didn't scrape cleanly
  (JavaScript-rendered content, missing version variants, etc.) in
  workflows/SCRAPER_NOTES.md for future reference.
```

---

# Integration Testing

## INT-1: End-to-end voice session test

**Size:** S (1-2h) | **Depends on:** API-1, WF-2, all completed tickets

**Acceptance Criteria:**
- iOS app connects → agent greets with user context → conversation logged → summary generated
- Conversation viewable via IOS-4 dev log (fetched through API)
- Guided workflow tested end-to-end via voice

**Agent Prompt:**
```
Write an integration test checklist for the Sunny MVP end-to-end flow.

VOICE + MEMORY FLOW:
1. Launch iOS app, tap "Talk to Sunny"
2. Verify: agent greets Margaret by name with personalized context
3. Say: "Can you help me unblock someone on my phone?"
4. Verify: agent launches unblock_contact workflow with step-by-step guidance
5. Say: "Actually, never mind. Remind me to take my blood pressure pill at 9am every day."
6. Verify: agent confirms details, saves reminder
7. Say: "What reminders do I have?"
8. Verify: agent lists the reminder just created
9. Tap "End"
10. Verify: conversation logged with all messages
11. Verify: session summary generated with extracted facts

API VERIFICATION:
12. curl GET /get-conversations → returns the session just completed
13. curl GET /get-messages?conversation_id=<id> → returns full transcript
14. curl GET /manage-reminders → returns the reminder created via voice
15. curl GET /get-user-profile → includes extracted facts from session

IOS DEV LOG:
16. Long-press title → conversation appears, fetched via API
17. Tap conversation → messages display as chat bubbles

ERROR CASES:
- Kill network during session → graceful recovery message
- Stay silent for 30 seconds → agent doesn't hang
- Speak very quietly → agent asks to repeat
- Say nonsense → agent handles gracefully
- API endpoint returns 500 → iOS app shows error state, doesn't crash

Create test_checklist.md with pass/fail columns.
```

---

# Remaining Work Summary

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
| **API-1** | **API** | **M** | **DB-1 ✅, DB-2 ✅** | **⬜** | **sunny-api** |
| IOS-3 | iOS | S | IOS-1 ✅ | ⬜ | sunny-ios |
| IOS-4 | iOS | S | IOS-1 ✅, API-1 | ⬜ | sunny-ios |
| WF-1 | Workflows | S | — | ⬜ | sunny-workflows |
| **WF-0** | **Workflows** | **M** | **WF-1** | **⬜** | **sunny-workflows** |
| WF-2 | Workflows | M | WF-1, AGENT-1 ✅ | ⬜ | sunny-workflows |
| WF-3 | Workflows | M | WF-0, WF-1 | ⬜ | sunny-workflows |
| INT-1 | Integration | S | All above | ⬜ | any |

**Remaining: 8 tickets, ~22-32 hours**

## Parallel Execution Plan (remaining work)

```
sunny-api:       API-1 ──────────────────────────────> done
sunny-ios:       IOS-3 ──> IOS-4 (blocked on API-1) ─> done
sunny-workflows: WF-1 ──> WF-0 ──> WF-3 ────────────> done
                       └────────> WF-2 ──────────────> done
Integration:     ────────────────────────────────────> INT-1

Parallelism: API-1 + IOS-3 + WF-1 can all start immediately.
Once WF-1 is done: WF-0 and WF-2 can start in parallel.
Once API-1 is done: IOS-4 unblocks.
Once WF-0 is done: WF-3 unblocks.
INT-1 runs when everything else is complete.
```
