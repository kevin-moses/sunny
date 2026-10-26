# Memory-Care Agent: POC Feature Spec

Source of truth: the Claude Doc "Memory-Care Agent — POC Feature Spec" (https://claude.ai/artifact/XBuzb5G7QUsSEoevKWnkHn). This file is a snapshot exported on 2026-10-24. If they disagree, the doc wins; re-export it.

## Goal and scope

The POC proves one loop: a family sets up a parent's day in the caregiver app, the parent confirms each task on whichever surface is closest, and anything unconfirmed escalates to a family member before it is missed.

**Hypothesis to test:** a senior with MCI can keep a daily routine confirmed through a quiet, mostly glanceable interface, without it feeling like surveillance or a relationship with an AI.

**Pilot shape**

- 3–5 households, each with one senior and 1–3 caregivers
- 2–4 weeks of daily use
- iOS only, for both the caregiver app and the senior's phone
- One e-ink home display per household, with a front light, speaker, mic and two physical buttons (Done and Talk)
- Voice runs on the home display, push-to-talk only; an outbound phone call is a later escalation step

**Principle:** every surface is a different view of the same state. The intelligence lives in the backend, so each surface can stay simple.

**A full personal agent behind a simple front:** the senior gets the same capable agent anyone else could use (open questions, lookups, small errands) without ever having to learn how to use one. The schedule and checklists are the structure the agent works inside; they are not the limit of what it will talk about.

## Shared state

One server-side state is the source of truth. Every surface renders a Today view from it and writes confirmations back through one API, so a task confirmed on the display clears from the widget, the Live Activity and the caregiver's timeline within seconds.

```
Caregiver app  <-->  Shared state (server)  <-->  E-ink home display (Today list, Done, Talk)
     ^               tasks + daily instances <-->  Senior's phone (widget, Live Activity)
     |               life profile, memory    <-->  Voice (prompts, confirms, answers)
     |               confirmation log
     |                       ^
     |                       | due, missed, escalate
     +---- alerts + digest -- Agent (answers anything with tools; schedule, escalation, digest)
```

The agent changes instance states on schedule; surfaces only render and confirm.

| Entity | Key fields | Written by | Read by |
| --- | --- | --- | --- |
| Household | Senior profile (preferred name, timezone, photo), caregivers, roles, on-call caregiver | Caregiver app | All |
| Life profile | People and relationships, places, doctors, daily habits, interests, preferences, sensitive topics and how to handle them | Caregiver app, with the senior at onboarding | Agent |
| Agent memory | Facts learned in conversation, each with source (caregiver or senior), date and a verified flag | Agent; caregivers review and correct | Agent |
| Task | Type (medication, appointment, routine, checklist, reminder), created_by (caregiver or senior), schedule rule, confirmation window, display label, spoken prompt, pill description, as-needed limits copied from the label, escalation policy | Caregiver app, agent on the senior's request | Agent |
| Task instance | Date, state, confirmed_by, confirmed_via (button, widget, voice, caregiver), timestamps | Agent, all surfaces | All |
| Checklist | Items, trigger (time, going out, manual) | Caregiver app | Display, phone, voice |
| Event | Title, time, place, visitor name | Caregiver app | Display, phone, voice |
| Message | Sender, recipient, text, optional photo or voice clip, seen_at | Caregiver app, agent on the senior's request | Display, phone, voice |
| Escalation policy | Ordered steps: delay, channel, recipient | Caregiver app | Agent |
| Conversation log | Transcript, topic, tools used, outcome (answered, routed, unsure), repeat count | Agent | Agent, digest |
| Audit log | Every state change with actor and surface | All | Caregiver app |

This state is the agent's context, not its boundary. Questions it can't answer from the household go to general knowledge and tools, covered under Voice and Agent below.

**Task instance states:** upcoming -> due -> confirmed, or due -> missed -> escalated -> resolved. A caregiver can resolve on the senior's behalf ("I called; she took them"), recorded under their name.

**Offline rule:** the display and phone cache today's instances and keep prompting from the cache. Confirmations queue locally and sync when the connection returns.

## Caregiver app

All setup and all visibility live here; the senior never configures anything.

| Feature | What it does | Priority |
| --- | --- | --- |
| Household setup | Create the senior's profile; invite siblings as primary, member or viewer | Must have |
| Schedule builder | Add medications, appointments, routines and checklists with times and confirmation windows | Must have |
| Senior-facing wording | Write the short label the display shows and the exact sentence voice speaks; preview both | Must have |
| Today timeline | Live status of every task instance, with who confirmed it and on which surface | Must have |
| Mark done for them | Resolve a task after checking in by phone, recorded under the caregiver's name | Must have |
| Escalation alerts and claim | Push when a task escalates; "I'm on it" stops alerts going to the others | Must have |
| Calendar events | Appointments and visits, including who is coming; feeds the display's Next up | Must have |
| Daily digest settings | Delivery time and recipients | Must have |
| Sharing preferences | What the senior agreed to share, set together at onboarding | Must have |
| Send message or photo | Text, photo or short voice clip that appears on the display | Nice to have |
| On-call rotation | Which caregiver gets first alerts each week | Nice to have |
| Questions inbox | Questions voice could not answer, so family can follow up | Nice to have |

## E-ink home display

The display answers orienting questions at a glance and takes two inputs: Done and Talk.

| Feature | What it does | Priority |
| --- | --- | --- |
| Orientation header | Day and part of day in large type ("Saturday morning"), date below; no minute clock | Must have |
| Today list | 3–6 items, the due one highlighted, finished ones checked off | Must have |
| Next up | The next event and who it involves ("Sarah visits at 2pm") | Must have |
| Going-out strip | A fixed line at the bottom: "Going out? Wallet · Keys · Glasses · Phone"; always visible, nothing to press | Must have |
| Done button | A press confirms the task that is due; if two are due, the top one | Must have |
| Talk button | A second button, separate from Done, with its own shape, color and printed label; one press starts listening and it stops when they stop talking; no holding, no wake word, no always-listening | Must have |
| Due cue | Soft chime plus a light when a task comes due, repeated per escalation policy | Must have |
| Offline mode | Keeps showing and prompting from cache, with a small "not connected" mark | Must have |
| No on-device settings | Everything is configured from the caregiver app | Must have |
| Latest message | Newest family message or photo, with the sender's name | Nice to have |
| Night view | After a set hour: "It's nighttime. Next: breakfast pills at 8am" | Nice to have |
| Door sensor cue | For later stages: when the front door opens, chime, highlight the going-out strip and read it once; nothing to confirm | Later |
| Weather | One line: temperature and what to wear | Later |

Refresh the panel on state changes and at part-of-day boundaries only; skipping minute ticks keeps it calm and saves power.

## Senior's phone

The phone mirrors the display for when the senior is out, with the same Today list and Done button.

| Feature | What it does | Priority |
| --- | --- | --- |
| Home screen widget | Medium widget with the Today list and Next up, plus an interactive Done button | Must have |
| Live Activity | Opens when a task's window starts, with Done on the lock screen; ends on confirm or when the window closes | Must have |
| Time-sensitive notifications | At due time and for each reprompt | Must have |
| One-screen app | Same layout as the widget, for when they tap it; nothing to navigate | Must have |
| Lock screen widget | Just the next item | Nice to have |
| Geofence nudge | A gentle going-out reminder once they leave home; a backstop only, since it fires after they are out | Later |

Two early checks: confirm whether the widget appears under Apple's Assistive Access mode (if not, ship the one-screen app as an Assistive Access tile), and don't rebuild left-behind alerts for wallet and keys, since item trackers like AirTag already do that. Recommend them at onboarding instead.

## Voice

Voice does three jobs: prompt, confirm and answer anything. It is a full personal agent the senior reaches with the Talk button, but it never speaks without a task or a question behind it.

| Feature | What it does | Priority |
| --- | --- | --- |
| Scheduled prompt | Fixed template per task: "It's 8 o'clock. Time for your morning pills, the small white ones. Press the button when you've taken them." | Must have |
| Voice confirm | "Done", "I took them" or "yes" confirms; "not yet" snoozes 15 minutes; anything unclear counts as unconfirmed | Must have |
| Already-done guard | If the task is confirmed: "You took your morning pills at 8:10." Guards against double doses | Must have |
| Questions about their life | Day, schedule, visits, people, places and earlier conversations, answered from household state and memory first | Must have |
| Open questions | Anything else, answered with general knowledge and web search: the game last night, how long to boil an egg, that actor's name, what a word on a letter means | Must have |
| Small errands | "Remind me to call the plumber tomorrow", "Add milk to the list", "Tell Sarah I'm home"; each becomes a senior-created item caregivers can see | Must have |
| Route to a person | Medication questions get the facts (what was taken today, label limits) so the senior decides; the caregiver is flagged past a limit, for new or repeated symptoms, money requests or anything scam-like, or signs of distress | Must have |
| Sensitive-topic playbook | Caregiver-written guidance for hard questions, such as how to answer "Where's my husband?" after a death | Must have |
| Read latest message | "What did Sarah send?" reads the newest message aloud | Nice to have |
| Family voice clips | Recorded, never cloned, family clips for key prompts | Nice to have |
| Outbound call step | Automated call with the same prompt as an escalation step; confirm by voice or keypad | Nice to have |

**Guardrails**

- Capable, not chatty: answer as fully as the question needs, then stop; no "anything else?", no follow-ups to keep talking
- Never start a conversation without a task behind it
- No persona: no feelings, no "I missed you", no claims of friendship
- Household facts beat general knowledge; caregiver-verified facts beat things the senior said; if nothing is known, say so plainly
- Never say "you already asked me that"; answer again the same way, patiently, and count the repeat for the digest
- Same words every day for scheduled prompts; answers to open questions can vary
- Slow speech rate; caregiver sets the volume
- Keep transcripts, discard audio by default; caregivers see topics in the digest, and full transcripts only if the senior agreed at onboarding

## Agent and backend

The backend runs the schedule, the escalation ladder and the digest. This is where the agent lives; the surfaces only display and confirm.

**Scheduler:** expands each task's schedule into daily instances at local midnight, handles timezone and daylight-saving changes, and pushes the day to every surface.

**Escalation ladder, proposed defaults for medication**

1. Window opens: display chime and light, voice prompt, phone notification and Live Activity
2. +15 min: voice reprompt and a second notification
3. +30 min: alert the on-call caregiver ("Mom hasn't confirmed her morning pills"); they can claim it
4. +45 min, still unclaimed: alert every caregiver
5. Window closes: mark missed and include it in the digest

Routines and checklists default to digest-only, with no escalation. Every delay is configurable per task.

**Answering:** every question runs through the same loop.

1. Assemble context: today's state, the life profile, relevant memory, and the last few exchanges
2. Run the model with tools: web search, weather, create reminder or note, send message, read calendar
3. Check policy: routing rules and the sensitive-topic playbook can reshape or flag the answer before it is spoken
4. Speak the answer and show it on the display for a few minutes, so a repeat question can be answered by a glance
5. Log the topic, tools used and outcome; write any new fact to memory as unverified until a caregiver confirms it

**Memory hygiene:** things the senior says can be mistaken, so they never overwrite caregiver-verified facts. Conflicts surface in the caregiver app for a quick yes or no.

**Daily digest:** one message at the caregiver's chosen time, 3–5 lines written only from the day's logged events, with a plain template as fallback. It covers what was confirmed and when, misses and escalations, questions voice couldn't answer, and repeat-question counts.

**Fan-out:** push to the caregiver app; push updates to the widget and Live Activity; a persistent connection (WebSocket or MQTT) to the display.

**Data handling:** encrypt in transit and at rest, let caregivers export or delete, and choose vendors that will sign a BAA so a HIPAA path stays open later.

## Key flows

Six flows cover the POC; if these work end to end, the loop is proven.

**Morning pills, confirmed**

1. At 8:00 the window opens: the display chimes and highlights Morning pills, a Live Activity appears on the phone, and voice says the prompt
2. The senior takes the pills and presses Done
3. The instance becomes confirmed via button; the widget, Live Activity and caregiver timeline update
4. The evening digest reads "Morning pills at 8:12 (button)"

**Morning pills, missed**

1. No confirmation by 8:15: voice reprompts
2. At 8:30 the on-call caregiver gets an alert, taps "I'm on it" and calls Mom
3. The caregiver marks it done for her: taken at 8:40, confirmed by phone
4. The digest notes the late confirmation and who resolved it

**Going out**

1. The senior just leaves; nothing is asked of them
2. On the way to the door they pass the display, whose bottom line always reads "Going out? Wallet · Keys · Glasses · Phone"
3. Later stages add a door sensor: the door opens, the display chimes, highlights the strip and reads it once
4. Nothing to confirm; a door-open event is logged for the digest when a sensor is present

**"When is Sarah coming?"**

1. The senior presses Talk and asks
2. The agent finds Sarah's next visit in events
3. Voice answers "Sarah is coming today at 2 o'clock"; the display already shows it under Next up
4. The question is logged with its repeat count for the digest

**An open question that mixes in their day**

1. The senior asks "Do I need an umbrella for my walk?"
2. The agent pulls today's walk time from the schedule and checks the weather for that hour
3. Voice answers "Rain is likely around 3. Your walk is at 2, so you should be fine, but take the umbrella just in case."
4. The answer stays on the display for a few minutes; the topic goes in the log

**A medication question: facts first, their decision**

1. The senior asks "Can I take another pill? My head hurts."
2. The agent checks today's log and the as-needed rule a caregiver copied from the label
3. Voice gives the facts and leaves the choice to them: "Today you took your morning pills at 8:10 and one pain reliever at 11. The label says up to 3 a day, 6 hours apart, so another is fine after 5 o'clock."
4. If they take one, saying so logs a self-reported dose; the caregiver is alerted only past the limit, if headaches keep coming back, or if they asked to always know

With no as-needed rule on file, voice still says what was taken today, then offers to call the caregiver or the pharmacy. It never invents a dose.

## Out of scope for the POC

- Verifying pills were actually taken, or dispensing them; pair with a smart dispenser later
- Passive sensors, activity monitoring and fall detection
- Emergency response; onboarding states plainly that this is not an emergency device
- Android
- Pharmacy, refill or health-record integrations
- Cognitive scoring or anything resembling diagnosis
- Companionship behavior: starting small talk, a persona, emotional engagement (open questions are in scope)
- Households with more than one senior
- Billing and subscriptions

## Build order and success metrics

Build the shared state first, then add one surface at a time, so each surface plugs into a loop that already works.

1. Shared state, scheduler and caregiver app (schedule builder, Today timeline)
2. E-ink display: render Today, Done button, chime
3. Phone: widget, Live Activity, notifications
4. Escalation ladder with caregiver alerts and claim
5. Voice: prompts, confirm, already-done guard, open questions with tools, routing rules and memory
6. Daily digest
7. Pilot with 3–5 households

| Metric | How it's measured | Proposed target |
| --- | --- | --- |
| Confirmation rate | Instances confirmed within their window / scheduled | 80% or more |
| Caught before missed | Unconfirmed instances a caregiver resolved before the window closed / all unconfirmed | 70% or more |
| Time to confirm | Median minutes from window open to confirmation | Under 15 |
| Answer success | Questions answered without "not sure" or a caregiver correction / asked | 85% or more |
| Helpfulness to the senior | Weekly 1–5 check-in: "Is this helping you?" | Median 4 or higher |
| Caregiver alert load | Escalation alerts per caregiver per week | Falls over the pilot |
| Surface mix | Share of confirmations by button, widget and voice; questions asked per week as the adoption signal | Tracked, no target |
