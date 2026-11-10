# Handoff: code map

A map of the current repo for someone picking it up. Product behavior: `notes/SPEC.md`. Tables: `notes/SCHEMA.md`. Background work: `notes/AGENT_RUNTIME.md`. How the backend moved from Supabase to Convex, and what is still open: `notes/CONVEX_MIGRATION.md`. Google setup: `notes/GOOGLE_CALENDAR_SETUP.md`. The original voice concierge brief is `notes/brief.md` (historical).

Going live with real families: `notes/PRODUCTION.md`.

Sunny is a memory-care agent for seniors with MCI or early dementia who live alone, and the family who coordinate their care. One shared state behind every surface: caregivers schedule the day, the senior confirms on whatever is closest (home display, phone, voice), anything unconfirmed escalates to family, and a daily digest closes the loop. The agent is a tool, not a companion.

## Repo layout

| Folder | What it is |
| --- | --- |
| `sunny_backend/` | Convex backend (TypeScript): schema, access rules, scheduler, agent runtime, integrations, tests, dev scripts |
| `sunny_app/` | React Native / Expo (SDK 57) iOS app: the senior's phone (Today view, Talk) and the iPad home display stub. Clerk sign-in, Convex subscriptions, LiveKit voice |
| `sunny_agent/` | LiveKit Python voice agent (Deepgram STT, Claude Haiku, Cartesia TTS, Tavily search) that reads and writes household state through Convex |
| `notes/` | Specs and design notes |

Removed and not coming back: screen share and vision, guided workflows, EventKit reminders, the Swift app, and Supabase (the `supabase/` directory was deleted in phase 6).

## sunny_backend

Entry points (all in `convex/`; each module's header describes its contracts):

| Feature | Where |
| --- | --- |
| Schema and enums | `schema.ts`, `lib/validators.ts` |
| Auth config (Clerk issuer, `applicationID: "convex"`) | `auth.config.ts` |
| Access rules (`requireReader`, `requireEditor`, `requirePrimary`, `requireSenior`, device claim) | `lib/access.ts` |
| Households, members, roles, join codes, devices, push tokens | `households.ts` |
| Device pairing over HTTP (`POST /pair`, Clerk device users, rate limits) | `pairing.ts`, `http.ts` |
| Tasks and escalation policies | `tasks.ts`, `lib/policies.ts` |
| Task instances (confirm, snooze, claim, dose log, senior reminders) | `instances.ts` |
| Scheduler tick (expand, open and close windows, escalation) | `scheduler.ts`, `lib/schedule.ts`, `crons.ts` |
| Calendar events, occurrences, day view (`calendar.dayView`) | `calendar.ts`, `lib/occurrences.ts`, `lib/today.ts`, `lib/eventNotices.ts` |
| Time zones | `lib/time.ts` |
| Google Calendar connect, push, sweepers | `googleCalendar.ts`, `calendarPush.ts`, `calendarFanOut.ts`, `lib/calendarSync.ts`, `lib/google.ts`, `lib/googleEvent.ts`, `lib/secretBox.ts` |
| Notification delivery (APNs, SMS) | `delivery.ts`, `apns.ts`, `apnsTokens.ts`, `lib/delivery.ts`, `lib/apnsPayload.ts`, `lib/twilio.ts` |
| Caregiver phone verification and inbound SMS | `phone.ts` (includes `households.myPhoneStatus`), `sms.ts` |
| Daily digest | `digest.ts`, `lib/digestFacts.ts`, `lib/digestText.ts` |
| Caregiver requests to the household agent | `agentRequests.ts`, `agentRuntime.ts`, `lib/agentTools.ts`, `lib/agentBriefing.ts`, `lib/agentConfig.ts`, `lib/managedAgents.ts`, `lib/agentRequestState.ts` (the agent's calendar and task tools, run as an agent actor acting for the requesting caregiver; sessions pass the deployed prompt, model and tools as overrides, and a config change starts a new session with the recent chat carried over, so a backend deploy is enough) |
| Functions the Python voice agent calls (`agent:*`): context, today, medication status, confirm, snooze, self-reported doses and undo, reminders, memory, caregiver flags, family messages, the household list, conversation and question logs | `agent.ts`, `lib/voiceRouting.ts` (flags and family messages through the outbox, reachable caregivers only, caps), `lib/voiceDoses.ts` and `lib/doseLimits.ts` (as-needed doses; the maximum applies to 24 hours and the local day), `lib/dueTask.ts` (the task "Done" and "not yet" mean), `lib/memoryLimits.ts` (agentMemory limits) |
| Household list (one shared list per household) | `lists.ts` (caregivers and devices), `lib/householdList.ts` (the only write path) |
| LiveKit room token for a senior device | `voice.ts` |
| Components (rate limiter, workflow, two workpools) | `convex.config.ts` |
| Test helpers | `testing.helpers.ts`, `*.helpers.ts`, `*.test.ts` beside each module |

Run locally (from `sunny_backend/`):

```bash
npm install
npx convex dev            # watches convex/, deploys to the dev deployment, regenerates convex/_generated
npm run typecheck         # tsc for convex/ and scripts/
npm test                  # vitest + convex-test (no network; Twilio, Google, APNs and Managed Agents are stubbed)
npx prettier --check convex scripts
```

The dev deployment is `enduring-ostrich-959` (`https://enduring-ostrich-959.convex.cloud`, HTTP actions at `.convex.site`). Dev scripts refuse to run unless `CONVEX_DEPLOYMENT` in `sunny_backend/.env.local` starts with `dev:`.

Scripts (not part of the deployed backend):
- `scripts/caregiver.ts` is a command-line stand-in for the caregiver app, acting as a fixed dev caregiver through `convex run --identity`. Commands: `setup` (create a dev household and print join codes), `chat "<message>" [--continue]` (request to the household agent), `day`, `codes`, `invite [primary|member|viewer]` (caregiver invite code, default member), `google` (consent link), `phone <number>` (waits for the text to go out, then prints "Texted a code" or the failure reason), `confirm-phone <code>`, `list`, `list-add "<text>"`, `weather-location "<place>"` (sets `households.weatherLocation`; "" clears it). Run as `npx tsx scripts/caregiver.ts <command>`; it keeps the household id in a git-ignored `scripts/.dev-state.json`.
- `scripts/setup_managed_agent.ts` creates or updates the Managed Agents agent and environment; run `npm run setup:agent` (from `sunny_backend`; `-- --prod` for production) once per Anthropic workspace to create the agent and environment (it also keeps the console copy in sync; changes to `lib/agentConfig.ts` or `lib/agentTools.ts` take effect on backend deploy). It reads `ANTHROPIC_API_KEY` from the root `.env`, reads the ids from the Convex deployment, and stores newly created ids there.

Environment (set on the Convex deployment with `npx convex env set`, never in a committed file):

| Area | Variables |
| --- | --- |
| Auth and devices | `CLERK_JWT_ISSUER_DOMAIN`, `CLERK_SECRET_KEY` |
| Voice | `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SERVER_URL`, `SUNNY_AGENT_KEY` (shared with the Python agent) |
| Agent runtime | `ANTHROPIC_API_KEY`, `SUNNY_AGENT_ID`, `SUNNY_ENVIRONMENT_ID`, optional `SUNNY_AGENT_SESSION_BUDGET_CENTS` |
| Google Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_OAUTH_STATE_SECRET`, `CALENDAR_TOKEN_KEY` (also keys phone codes) |
| APNs | `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8`, `APNS_ENVIRONMENT`, optional `APNS_BUNDLE_ID` |
| SMS | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_URL`, optional `SMS_ALLOWED_COUNTRY_CODES` |

## sunny_app

Entry: `index.ts` and `App.tsx`. Screens in `src/screens` (`PairingScreen`, `TodayScreen` for the phone, `DisplayScreen` for the home display), the day clock in `src/day` (subscribes to `calendar.dayView` with a per-minute argument), pairing in `src/backend` (`pairing.ts`, `useSession.ts`; typed Convex calls through `convexApi.ts`), voice in `src/voice` (LiveKit room token from `voice.livekitToken`; RPCs the agent calls on the phone: `findContact`, `sendMessage`), push registration in `src/notifications`. Full explanation of pairing and setup: `sunny_app/README.md`.

Run: `npm install`, then `npm run ios -- --device` for the first development build (Expo Go does not work; voice needs a physical iPhone), then `npm start`. Checks: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` (jest).

Environment: all optional, with defaults for the dev deployment and dev Clerk instance. `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_CONVEX_URL`, `EXPO_PUBLIC_CONVEX_SITE_URL` in a git-ignored `.env.local`. The Clerk instance needs a JWT template named `convex` that maps `public_metadata.sunny_kind` to a `sunny_kind` claim.

The app imports only the type of the backend's generated API; after backend changes, regenerate `sunny_backend/convex/_generated` (`npx convex dev` or `npx convex codegen`).

Not built: the caregiver app, the e-ink display client, widget and Live Activity (native Swift extensions to add to the Expo project).

## sunny_agent

LiveKit Python worker. `src/agent.py` (the `Assistant` and `entrypoint`), `src/prompts.py` (system prompt following the spec's voice guardrails, and household context formatting), `src/tools.py` (helpers behind the household tools and spoken-time formatting; web search is `Assistant.web_search` in `agent.py`), `src/weather.py` (Open-Meteo geocoding and forecast for `households.weatherLocation`, no key), `src/memory.py` (household resolution from participant metadata, conversation logging, and the post-call summary and question extraction), `src/convex_client.py` (HTTP client for the `agent:*` Convex functions), `src/config.py` (senior-tuned endpointing constants).

Tools: web_search, get_weather, list_today, confirm_task, snooze_task, medication_status, log_dose, undo_last_dose, create_reminder, cancel_reminder, remember_fact, flag_caregiver, send_family_message, read_latest_message, add_to_list, read_list, take_off_list (`src/list_tools.py`). No tool depends on the phone (the senior talks through the home display); the phone-RPC tools find_contact and send_message were removed. A Talk session opens silently and listens; only a session started by a task that is due or escalated speaks first, with the task's fixed prompt. The worker ends a session with no speech for 60 seconds (`INACTIVITY_TIMEOUT_S`). Speech is slowed with Cartesia `sonic-3` at speed 0.85 (`TTS_MODEL`, `TTS_SPEED` in `src/config.py`).

Weather: the agent looks up `households.weatherLocation`. After deploy the product owner sets it to "Brooklyn, NY" with one command from `sunny_backend/`: `npx tsx scripts/caregiver.ts weather-location "Brooklyn, NY"` (or `households.update` from the caregiver app). With no location the agent falls back to web search.

Run (from `sunny_agent/`): `uv sync`, `uv run python src/agent.py download-files` once, then `uv run python src/agent.py dev` (or `console` to talk in the terminal). Tests: `uv run pytest -q` (some tests are LLM-judged and need `ANTHROPIC_API_KEY`). Type and lint: `uv run mypy src/ --ignore-missing-imports`, ruff (via pre-commit).

Environment (`sunny_agent/.env`, git-ignored; copy from `.env.example`): `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `TAVILY_API_KEY`, `CONVEX_URL`, `SUNNY_AGENT_KEY` (must equal the value on the Convex deployment), optional `DEV_HOUSEHOLD_ID` (used when the session has no household in its metadata).

## Checks

Style is enforced by pre-commit: `uv tool run pre-commit run --all-files` from the repo root (ruff, ruff-format and mypy for `sunny_agent`; prettier and tsc for `sunny_backend/convex`; prettier, eslint and tsc for `sunny_app`). Run `npm install` in `sunny_app` and `sunny_backend` first. Before committing, run `/simplify` and the TLM code reviewer (see `CLAUDE.md`).

## Where each product feature lives

| SPEC feature | Where |
| --- | --- |
| Shared state, caregiver roles, on-call | `households.ts`, `lib/access.ts` |
| Tasks, escalation ladder, claim | `tasks.ts`, `instances.ts`, `scheduler.ts` |
| Day clock and Next up | `calendar.dayView`, `sunny_app/src/day` |
| Calendar events, Google sync | `calendar.ts`, `googleCalendar.ts`, `calendarPush.ts` |
| Done button, widget, voice confirm | `instances.confirmDueTask` (button via the app, voice via `agent.confirmDueTask`) |
| Voice (Talk) | `voice.ts`, `sunny_agent`, `sunny_app/src/voice` |
| Caregiver requests to the agent | `agentRequests.ts`, `agentRuntime.ts` |
| Alerts to family | `delivery.ts` (APNs and SMS), `sms.ts` (reply to claim) |
| Daily digest | `digest.ts` |
| Life profile, playbook, agent memory, family messages | Read by `agent.getContext`; voice writes: `agent.rememberFact`, `agent.sendFamilyMessage`, `agent.readLatestMessage` (seen) |
| Route to a person (flags), medication facts, "not yet" | `agent.flagCaregiver`, `agent.logAsNeededDose`, `agent.undoLastDose`, `agent.medicationStatus`, `agent.snoozeDueTask` |
| Small errands: "Add milk to the list" | `agent.addListItems` / `listItems` / `tickListItem`, `lists.ts`; one digest line for items the senior added |
| Question log for the digest | `agent.logQuestions` (written after each call by `sunny_agent/src/memory.py`), read by `lib/digestFacts.ts` |
