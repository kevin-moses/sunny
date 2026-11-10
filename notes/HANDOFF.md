# Handoff: code map

A map of the current repo for someone picking it up. Product behavior: `notes/SPEC.md`. Tables: `notes/SCHEMA.md`. Background work: `notes/AGENT_RUNTIME.md`. How the backend moved from Supabase to Convex, and what is still open: `notes/CONVEX_MIGRATION.md`. Google setup: `notes/GOOGLE_CALENDAR_SETUP.md`. The original voice concierge brief is `notes/brief.md` (historical).

Going live with real families: `notes/PRODUCTION.md`.

Sunny is a memory-care agent for seniors with MCI or early dementia who live alone, and the family who coordinate their care. One shared state behind every surface: caregivers schedule the day, the senior confirms on whatever is closest (home display, phone, voice), anything unconfirmed escalates to family, and a daily digest closes the loop. The agent is a tool, not a companion.

## Repo layout

| Folder | What it is |
| --- | --- |
| `sunny_backend/` | Convex backend (TypeScript): schema, access rules, scheduler, agent runtime, integrations, tests, dev scripts |
| `sunny_app/` | React Native / Expo (SDK 57) iOS app: the senior's phone (Today view, Talk) and the iPad home display (standing in for the e-ink device: Done and Talk keys, voice on the panel, due cue). Clerk sign-in, Convex subscriptions, LiveKit voice |
| `sunny_agent/` | LiveKit Python voice agent (Deepgram STT, Claude Haiku, Cartesia TTS, Tavily search) that reads and writes household state through Convex |
| `notes/` | Specs and design notes |

Removed and not coming back: screen share and vision, guided workflows, EventKit reminders, the Swift app, and Supabase (the `supabase/` directory was deleted in phase 6).

## sunny_backend

Entry points (all in `convex/`; each module's header describes its contracts):

| Feature | Where |
| --- | --- |
| Schema and enums | `schema.ts`, `lib/validators.ts` |
| Auth config (Clerk issuer, `applicationID: "convex"`) | `auth.config.ts` |
| Access rules (`requireReader`, `requireCaregiverReader`, `requireEditor`, `requirePrimary`, `requireSenior`, device claim) | `lib/access.ts` |
| Households, members, roles, join codes, devices, push tokens | `households.ts` |
| Device pairing over HTTP (`POST /pair`, Clerk device users, rate limits) | `pairing.ts`, `http.ts` |
| Tasks and escalation policies | `tasks.ts`, `lib/policies.ts` |
| Task instances (confirm, snooze, claim, dose log, senior reminders); the rule for when a senior device may confirm (60 minutes early) and the day view's `confirmable` flag | `instances.ts`, `lib/confirmRule.ts` |
| Scheduler tick (expand, open and close windows, escalation) | `scheduler.ts`, `lib/schedule.ts`, `crons.ts` |
| Calendar events, occurrences, day view (`calendar.dayView`) | `calendar.ts`, `lib/occurrences.ts`, `lib/today.ts`, `lib/eventNotices.ts` |
| Time zones | `lib/time.ts` |
| Google Calendar connect, push, sweepers | `googleCalendar.ts`, `calendarPush.ts`, `calendarFanOut.ts`, `lib/calendarSync.ts`, `lib/google.ts`, `lib/googleEvent.ts`, `lib/secretBox.ts` |
| Notification delivery (APNs, SMS) | `delivery.ts`, `apns.ts`, `apnsTokens.ts`, `lib/delivery.ts`, `lib/apnsPayload.ts`, `lib/twilio.ts` |
| Caregiver phone verification and inbound SMS | `phone.ts` (includes `households.myPhoneStatus`), `sms.ts` |
| Daily digest | `digest.ts`, `lib/digestFacts.ts`, `lib/digestText.ts` |
| Caregiver requests to the household agent | `agentRequests.ts`, `agentRuntime.ts`, `lib/agentTools.ts`, `lib/agentBriefing.ts`, `lib/agentConfig.ts`, `lib/managedAgents.ts`, `lib/agentRequestState.ts` (the agent's calendar and task tools, run as an agent actor acting for the requesting caregiver; sessions pass the deployed prompt, model and tools as overrides, and a config change starts a new session with the recent chat carried over, so a backend deploy is enough) |
| Life profile, sensitive topics, agent memory and family messages (caregiver read and write path) | `profile.ts` |
| Functions the Python voice agent calls (`agent:*`): context, today, medication status, confirm, snooze, self-reported doses and undo, reminders, memory, caregiver flags, family messages, the household list, conversation and question logs | `agent.ts` (thin argument-checked wrappers; the behavior lives in lib), `lib/agentContext.ts` (the getContext block), `lib/conversationLog.ts` (conversations, turns, questions), `lib/voiceTasks.ts` (snooze, medication status), `lib/seniorMemory.ts` (rememberFact), `lib/voiceRouting.ts` (flags and family messages through the outbox, reachable caregivers only, caps), `lib/voiceDoses.ts` and `lib/doseLimits.ts` (as-needed doses; the maximum applies to 24 hours and the local day), `lib/dueTask.ts` (the task "Done" and "not yet" mean, shared with the display's Done), `lib/memoryLimits.ts` and `lib/profileReads.ts` (agentMemory limits, reads, entry and fact order and the duplicate check, shared with `profile.ts`), `lib/text.ts` (oneLine, textKey) |
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
- `scripts/caregiver.ts` is a command-line stand-in for the caregiver app, acting as a fixed dev caregiver through `convex run --identity`. Commands: `setup` (create a dev household and print join codes), `chat "<message>" [--continue]` (request to the household agent), `day`, `codes`, `invite [primary|member|viewer]` (caregiver invite code, default member), `google` (consent link), `phone <number>` (waits for the text to go out, then prints "Texted a code" or the failure reason), `confirm-phone <code>`, `profile-load <file.json> [--update]` (loads life profile entries, sensitive topics and caregiver facts through the public `profile:*` mutations, one `convex run` process per item, so it is slow; re-running adds nothing; an item stored with other text is reported "differs" and left alone unless `--update` is given, which changes an entry's details only when the item has a `details` key and clears them only for `null` or `""`; format in `scripts/profileLoader.ts`, example in `scripts/profile.example.json`, which is made up; keep real data in `scripts/profile.local.json`, since `scripts/*.local.json` is git-ignored), `profile` (prints what is stored), `message "<text>"` (sends the senior a text), `list`, `list-add "<text>"` and `weather-location "<place>"` (sets `households.weatherLocation`; "" clears it). Run as `npx tsx scripts/caregiver.ts <command>`; it keeps the household id in a git-ignored `scripts/.dev-state.json`. It refuses to run unless `convex run` would target a dev deployment, applying the CLI's precedence (shell variables over `.env.local` over `.env`; a `CONVEX_DEPLOY_KEY` over `CONVEX_DEPLOYMENT`; `scripts/devGuard.ts`), and prints the server's message when a call fails.
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

Entry: `index.ts` and `App.tsx`. Screens in `src/screens` (`PairingScreen`, `TodayScreen` for the phone with its Done button in `src/day/useDoneAction.ts` and the offline press queue in `src/day/pendingConfirms.ts`, `DisplayScreen` for the home display), the day clock in `src/day` (subscribes to `calendar.dayView` with a per-minute argument), pairing in `src/backend` (`pairing.ts`, `useSession.ts`; typed Convex calls through `convexApi.ts`), voice in `src/voice` (LiveKit room token from `voice.livekitToken`; RPCs the agent calls on the phone: `findContact`, `sendMessage`), push registration in `src/notifications`, the home display in `src/display` (panel parts and rules, keys, its voice card in `useDisplayVoice.ts` and `voiceModel.ts`, the due cue in `useDueCue.ts`, `cue.ts` and `cueAudio.ts` with the chime in `assets/sounds`, made by `scripts/makeChime.js`; every timing in `tuning.ts`, live values in `TuningProvider.tsx`, edited from the developer sheet's "Home display" section). Full explanation of pairing and setup: `sunny_app/README.md`.

Run: `npm install`, then `npm run ios -- --device` for the first development build (Expo Go does not work; voice needs a physical iPhone), then `npm start`. Checks: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` (jest).

Environment: all optional, with defaults for the dev deployment and dev Clerk instance. `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_CONVEX_URL`, `EXPO_PUBLIC_CONVEX_SITE_URL` in a git-ignored `.env.local`. The Clerk instance needs a JWT template named `convex` that maps `public_metadata.sunny_kind` to a `sunny_kind` claim.

The app imports only the type of the backend's generated API; after backend changes, regenerate `sunny_backend/convex/_generated` (`npx convex dev` or `npx convex codegen`).

The caregiver app (`src/caregiver`, shown to a signed-in caregiver) has three tabs: Home (the week, alerts, tasks), Chat (the household agent) and About (what Sunny knows: life profile, hard questions, memory facts to confirm, family messages).

Not built: the e-ink display client, widget and Live Activity (native Swift extensions to add to the Expo project).

## sunny_agent

LiveKit Python worker. `src/agent.py` (the `Assistant` and `entrypoint`), `src/prompts.py` (system prompt following the spec's voice guardrails, and household context formatting), `src/tools.py` (helpers behind the household tools and spoken-time formatting; web search is `Assistant.web_search` in `agent.py`), `src/speech_guard.py` (checks on each model reply before it is spoken: no words before a tool call, no "family was told" without a tool result behind it, no promises about what family will do, and the same-or-another dose question), `src/weather.py` (Open-Meteo geocoding and forecast for `households.weatherLocation`, no key), `src/memory.py` (household resolution from participant metadata, conversation logging, and the post-call summary and question extraction), `src/convex_client.py` (HTTP client for the `agent:*` Convex functions), `src/config.py` (senior-tuned endpointing constants, and the emergency numbers).

United States only for now: Sunny assumes a household in the US. The numbers the agent gives (911, 988 for the crisis line, Poison Control 1-800-222-1222) are `EMERGENCY_NUMBER`, `CRISIS_LINE` and `POISON_CONTROL` in `src/config.py`, the one place they are kept; a household elsewhere needs those to come from the household first.

Tools: web_search, get_weather, list_today, confirm_task, snooze_task, medication_status, log_dose, undo_last_dose, create_reminder, cancel_reminder, remember_fact, flag_caregiver, send_family_message, read_latest_message, add_to_list, read_list, take_off_list (`src/list_tools.py`). No tool depends on the phone (the senior talks through the home display); the phone-RPC tools find_contact and send_message were removed. A Talk session opens silently and listens; only a session started by a task that is due or escalated speaks first, with the task's fixed prompt. A bare greeting gets "I'm listening."; "ok" alone never confirms, "no" alone never snoozes, and "yes" confirms only as the answer to the agent's own question about that task. A one- or two-word transcript that repeats the end of the agent's last line is treated as echo. Self-reported doses: a report that may repeat one already written down is asked about ("the same one or another?", `log_dose(another=true)` logs it); a dose can only be taken back in the conversation that logged it, within 30 minutes. A distress flag (a fall is distress) always gives the emergency numbers. The worker ends a session with no speech for 60 seconds (`INACTIVITY_TIMEOUT_S`). Speech is slowed with Cartesia `sonic-3` at speed 0.85 (`TTS_MODEL`, `TTS_SPEED` in `src/config.py`).

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
| Voice (Talk) | `voice.ts`, `sunny_agent`, `sunny_app/src/voice`; on the home display `sunny_app/src/display/useDisplayVoice.ts` |
| Display due cue (chime and spoken prompt, repeated per reprompt) | `sunny_app/src/display/useDueCue.ts`, `cue.ts`, `cueAudio.ts`; reprompt count `seniorPrompts` in `lib/today.ts` |
| Caregiver requests to the agent | `agentRequests.ts`, `agentRuntime.ts` |
| Alerts to family | `delivery.ts` (APNs and SMS), `sms.ts` (reply to claim) |
| Daily digest | `digest.ts` |
| Life profile, playbook, agent memory, family messages | `profile.ts` (caregiver writes, lists), the caregiver About tab (`sunny_app/src/caregiver/CaregiverAboutScreen.tsx`), `scripts/caregiver.ts profile-load`; read by `agent.getContext`; voice writes: `agent.rememberFact`, `agent.sendFamilyMessage`, `agent.readLatestMessage` (seen) |
| Route to a person (flags), medication facts, "not yet" | `agent.flagCaregiver`, `agent.logAsNeededDose`, `agent.undoLastDose`, `agent.medicationStatus`, `agent.snoozeDueTask` |
| Small errands: "Add milk to the list" | `agent.addListItems` / `listItems` / `tickListItem`, `lists.ts`; one digest line for items the senior added |
| Question log for the digest | `agent.logQuestions` (written after each call by `sunny_agent/src/memory.py`), read by `lib/digestFacts.ts` |
