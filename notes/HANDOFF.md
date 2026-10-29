# Handoff: Sunny -> Memory-Care Agent

Written 2026-10-24 from a planning chat. Read this with `notes/SPEC.md`. Nothing in the codebase was changed; this is a map, not a refactor.

## Status (2026-10-25)

Phase 0 (removals) and the shared-state step are done on branch `memory-care-refactor`. The schema was rebuilt from scratch rather than evolved: `reminders`, `adherence_log`, `caregiver_links`, `users.profile_summary` and the caregiver Edge Functions no longer exist, so the "Keep, but refactor" rows below about them are historical. See `notes/SCHEMA.md` for what replaced them. Decisions since this note: the voice pipeline stays (no Gemini Live), parked features were removed rather than flagged, the app is iOS-only, the caregiver app will be a second target in the same Xcode project, and the scheduler runs as SQL under pg_cron.

## What changed in the product

Sunny started as a voice-first phone concierge for seniors (see `notes/brief.md`). The new direction narrows the user and widens the surfaces:

- **Users:** seniors with MCI or early dementia living alone, and the adult children who coordinate their care. The caregiver is the buyer and the one who sets everything up.
- **Surfaces:** one shared state behind four views: a caregiver iOS app, an e-ink home display (Done and Talk buttons), the senior's phone (widget, Live Activity, one-screen app), and voice.
- **Core loop:** caregiver schedules the day, senior confirms on whatever is closest, anything unconfirmed escalates to family before it is missed, and a daily digest closes the loop.
- **Agent stance:** a full personal agent that answers anything (web search, errands, questions about their own life), but a tool, not a companion. No persona, no small talk, never starts talking without a task behind it.

## Decisions made in the planning chat

These came from the user's review comments and override anything older in `notes/brief.md` or the Phase tickets.

1. **Tool, not friend.** Positioned against companion products like Sam (withsam.com) and ElliQ. Success is confirmations and answers, not minutes spent talking.
2. **Open questions are in scope.** The household data model is the agent's context, not its boundary. The agent answers anything, using household state first, then general knowledge and tools.
3. **Going out is passive.** The senior will not tell the system they are leaving. The display shows a fixed "Going out? Wallet · Keys · Glasses · Phone" line. A door sensor cue is a later-stage option. No "Going out" button.
4. **A separate Talk button.** Not a long-press on Done. Own shape, color and label; one press listens until they stop talking.
5. **Medication questions: facts first, their decision.** The agent says what was taken today and the label's as-needed limits, then lets the senior decide. Caregivers are alerted only past a limit, for repeated symptoms, or if the senior asked. It never invents a dose.
6. **Memory hygiene.** Facts the senior states are stored as unverified and never overwrite caregiver-verified facts.

## Existing code against the new spec

### Keep, mostly as is

| Existing piece | Where | Maps to in SPEC |
| --- | --- | --- |
| LiveKit voice pipeline, provider switch | `sunny_agent/src/agent.py`, `providers.py` | Voice transport. The display and phone both join a LiveKit room on Talk |
| Senior-tuned endpointing and interruption constants | `sunny_agent/src/config.py` | Voice guardrails (slow speech, pauses) |
| STT garbage filter, echo detection, progressive error recovery | `agent.py` helpers (`_is_garbage_input`, `_is_echo`, `_recovery_message`) | Voice robustness |
| Tavily web search tool | `Assistant.web_search` | Open questions |
| Contacts and messaging tools over iOS RPC | `find_contact`, `send_message` | Small errands ("Tell Sarah I'm home") |
| Conversation and message logging | `memory.py` `ConversationLogger`, `conversations` and `messages` tables | Conversation log (needs topic, outcome, repeat count) |
| Session-context trigger from a notification tap (NOTIFY-1) | `memory.resolve_session_context`, migration 008 | Scheduled prompt and voice confirm |
| FCM device tokens, caregiver devices | migrations 003 and 006, `save-device-token`, `caregiver-register` | Fan-out to phone and caregiver app |

### Keep, but refactor

| Existing piece | Problem against SPEC | Direction |
| --- | --- | --- |
| `reminders` table and `tools.py` reminder CRUD | Types are medication, appointment, exercise, wellness_checkin, custom. No confirmation window, display label, spoken prompt, pill description, as-needed limits, created_by or escalation policy | Evolve into the SPEC `Task` entity. Add a migration rather than a new table so existing tools keep working during the move |
| `adherence_log` | Statuses are pending, confirmed, skipped, missed, escalated. No confirmed_by, confirmed_via or resolved state. Only covers reminders | Evolve into `Task instance`: add `upcoming`, `due`, `resolved`, `confirmed_by`, `confirmed_via`, and make it cover every task type |
| `caregiver_links` | No household concept, no roles or on-call; `caregiver_user_id` has no FK; RLS policy is permissive (`USING (true)`) | Add `households` with roles (primary, member, viewer) and on-call. Tighten RLS before any real pilot data |
| `users.profile_summary` (one LLM-merged prose paragraph) | Mixes caregiver facts and things the senior said, and is rewritten by the model every session. Breaks memory hygiene | Split into a caregiver-owned `life_profile` and an `agent_memory` table of facts with source, date and verified flag. Keep `profile_summary` only as a derived cache, if at all |
| `prompts.py` system prompt | Persona ("warm and patient", "like a knowledgeable friend"), frequent check-ins ("Does that make sense?", "Would you like me to do that?"). The brief also suggests "Do you need help with anything else?" All conflict with the voice guardrails | Rewrite around SPEC guardrails: capable, not chatty; no persona; answer then stop; household facts first; never say "you already asked" |
| Proactive greeting on session start | `agent_state_changed` handler greets on every session; returning-user greeting within 10 minutes | Speak first only when a task triggered the session (scheduled prompt, reprompt). On a Talk press, just listen |
| `agent.py` (1,370 lines) | One `Assistant` class carries voice, reminders, workflows, screen share and vision | Split by concern before adding the scheduler, policy check and memory tools: tools, policy, context assembly, session wiring |
| iOS app (`sunny_app/VoiceAgent`) | Built as a "Tap and Speak" call screen with chat, conversation log and screen share views | Becomes the senior phone surface: one-screen Today view, WidgetKit widget, Live Activity. The caregiver app is a separate target or app |
| Caregiver Edge Functions (`caregiver-dashboard`, `caregiver-reminders`, `caregiver-settings`, `caregiver-conversations`) | Written for a web dashboard MVP (CG-1) | Reuse as the caregiver app's API; extend for households, Today timeline, mark done for them, claim |

### Park for the POC

These are outside the SPEC's scope. Recommend keeping the code but not loading these tools in memory-care mode (a config flag), rather than deleting.

- Screen share and vision: `screen_capture.py`, `screen_describer.py`, `BroadcastExtension/`, SCREEN-1 to SCREEN-9 in `Sunny-Phase3-Tickets.md`
- Guided iPhone workflows: `workflow_engine.py`, `workflows/wf0` scraper, migration 004, WF tickets
- iOS native Reminders via EventKit (`create_reminder`): the SPEC keeps one schedule in shared state, so a second reminder system confuses the senior and the caregiver

### Not built yet

- Households, roles, on-call; life profile; agent memory with verification; sensitive-topic playbook
- Events (visits, appointments with who is coming) and senior-facing messages. Note the existing `messages` table holds conversation turns, so senior messages need a different name (for example `family_messages`)
- Scheduler that expands tasks into daily instances at local midnight, with timezone and DST handling. `get_due_reminders` exists as an RPC, but no scheduled Edge Function was found in `supabase/functions`
- Escalation ladder with claim (ADHERENCE-2 and CG-2 are not in the repo)
- Daily digest (`caregiver_links.notify_daily_summary` exists; nothing sends it)
- Realtime fan-out: Supabase Realtime or a WebSocket channel for the display, APNs pushes for the widget and Live Activity
- E-ink display client and firmware (hardware choice is open)
- Policy check step in the answering loop (routing rules, medication limits, scam and distress flags)
- Agent tools: weather, read calendar and events, create senior-created task, log self-reported dose

## Suggested refactor order

Follows the SPEC build order and keeps the agent working at every step.

1. Branch from `main` once the open `gemini-switch` work (uncommitted changes to `agent.py`, `config.py`, `screen_describer.py`, new `providers.py`) is committed or stashed by the user
2. Migrations: households and roles; evolve `reminders` to tasks and `adherence_log` to task instances; add events, family messages, life profile, agent memory. Tighten RLS
3. Scheduler and escalation Edge Functions, plus caregiver API changes; test with the existing iOS app as the only client
4. Split `agent.py`; add a memory-care mode flag that drops screen share, workflows and EventKit tools
5. Rewrite `prompts.py` to the SPEC guardrails; add context assembly from tasks, events, life profile and memory
6. Phone surface: Today view, widget, Live Activity
7. E-ink display client
8. Daily digest

## Open questions for the user

- Does the caregiver experience stay a web dashboard for the pilot, or become an iOS app as the SPEC says?
- Is the senior phone app still the existing `sunny_app` target, with a Talk button, or display-only voice for the POC?
- Which e-ink hardware, and does it run its own LiveKit client or relay audio through a hub?
- Keep the Gemini Live realtime provider from `gemini-switch`, or the Deepgram, Haiku, Cartesia pipeline? The pipeline gives tighter control over templated prompts and the policy check
- Park screen share and workflows behind a flag (recommended) or remove them from this repo?
