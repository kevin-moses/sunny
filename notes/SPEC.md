# Memory-Care Agent: POC Feature Spec

This file is the living spec and the source of truth; change it whenever a product decision changes, and add a line to the change log at the end. It began as an export of the Claude Doc "Memory-Care Agent — POC Feature Spec" (https://claude.ai/artifact/XBuzb5G7QUsSEoevKWnkHn) on 2026-10-24; that doc is no longer kept in sync.

Last updated: 2026-11-13.

## Goal and scope

The POC proves one loop: a family sets up a parent's day in the caregiver app, the parent confirms each task on whichever surface is closest, and anything unconfirmed escalates to a family member before it is missed.

**Hypothesis to test:** a senior with MCI can keep a daily routine confirmed through a quiet, mostly glanceable interface, without it feeling like surveillance or a relationship with an AI.

**Pilot shape**

- 3–5 households, each with one senior and 1–3 caregivers
- 2–4 weeks of daily use
- iOS only, for both the caregiver app and the senior's phone
- One e-ink home display per household, with a front light, speaker, mic and two physical buttons (Done and Talk). An iPad stands in until the hardware is ready
- Voice runs on the home display, push-to-talk only; an outbound phone call is a later escalation step

**Principle:** every surface is a different view of the same state. The intelligence lives in the backend, so each surface can stay simple.

**The app is smart, not the user:** caregivers say what they want in plain words and Sunny works out the settings. Nothing in the caregiver app asks a caregiver to fill in a form that Sunny could fill in for them.

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
| Device | Kind (senior phone, home display), screen resolution and grey levels, device token | Pairing | Backend |
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

**Task instance states:** upcoming -> due -> confirmed, or due -> missed -> escalated -> resolved. A caregiver can resolve on the senior's behalf ("I called; she took them"), recorded under their name. An editor caregiver can also reopen any task confirmed that day, recorded in the audit log; this is the backstop for a Done pressed by mistake. A reopened task is simply unconfirmed again: its escalation ladder continues, so prompts and family alerts whose time has already passed go out right away.

**Offline rule:** the display and phone cache today's and tomorrow's instances, move tasks to due on their own clock and keep prompting from the cache. Confirmations queue locally, survive a restart, and sync when the connection returns. The device sends how long ago the press was, so the task is recorded at the time of the press and a wrong device clock cannot shift it. A family alert can still fire for a task that was confirmed offline; that is accepted. An Undo tapped offline is queued the same way and judged from when it was tapped. A press made before an undo, or before a caregiver reopened a device's confirmation, is ignored if it arrives afterwards, so a queued press can never mark a task done again after it was taken back.

**Devices and the device API:** the rules that decide what a senior surface shows (which task is "Now", what is Next up, which rows appear, when to chime and what to say) live in the backend as one device state. Every senior surface reads it: the phone app, the widget, the Live Activity, the iPad and the e-ink display. A device gets a long-lived device token at pairing and uses a small HTTP device API (read the state, confirm, undo); removing the device in the caregiver app revokes the token. A device reports its screen resolution and grey levels, and the server draws e-ink frames to fit, so no layout assumes one screen size.

## Caregiver app

All setup and all visibility live here; the senior never configures anything. Chat with Sunny is the only editing surface: the caregiver says what and when, and Sunny chooses the confirmation window, the escalation ladder and the wording, then shows what it chose. There are no schedule or event forms.

| Feature | What it does | Priority |
| --- | --- | --- |
| Household setup | Create the senior's profile; invite siblings as primary, member or viewer | Must have |
| Schedule by chat | Add or change medications, appointments, routines and checklists by telling Sunny; Sunny picks times, windows and the ladder | Must have |
| Senior-facing wording | Sunny writes the short label the display shows and the exact sentence voice speaks; its reply shows both, with a play button for the sentence | Must have |
| Today timeline | Live status of every task instance, with who confirmed it and on which surface | Must have |
| Mark done for them | Resolve a task after checking in by phone, recorded under the caregiver's name | Must have |
| Reopen a task | Reopen any task confirmed that day, for a Done pressed by mistake; recorded in the audit log | Must have |
| Escalation alerts and claim | Time-sensitive push when a task escalates, with "I'm on it" on the notification; it stops alerts going to the others. A caregiver without the app gets a text instead | Must have |
| Calendar events | Appointments and visits, including who is coming, added by chat; feeds the display's Next up | Must have |
| Daily digest | Posted as a message from Sunny in the chat thread, with a push as its preview; a caregiver can reply to it. Delivery time and recipients are set by chat | Must have |
| Knowledge | Life profile, sensitive-topic guidance and remembered facts are read, confirmed and corrected in the About tab. They can also be told to Sunny in chat ("Mom's doctor is Dr. Patel"); Sunny shows what it stored | Must have |
| Preferences by chat | Digest time, on-call caregiver and sharing preferences (what the senior agreed to share, set together at onboarding) | Must have |
| Settings screen | Only what needs a tap on the phone: pair a device, invite a caregiver, verify a phone number, connect Google, pause, sign out | Must have |
| Send message or photo | Text, photo or short voice clip that appears on the display | Nice to have |
| On-call rotation | Which caregiver gets first alerts each week | Nice to have |
| Questions inbox | Questions voice could not answer, so family can follow up | Nice to have |

## E-ink home display

The display answers orienting questions at a glance and takes two inputs: Done and Talk.

**Hardware:** the first panel is a 13.3 inch Waveshare e-paper (960 x 680, black and white with 4 grey levels, 0.7 s partial and 5 s full refresh) driven by an ESP32-S3 with PSRAM, with wifi, speaker, mic, front light and two keys. Other panel sizes will be tried, so the server draws each frame to the resolution the device reports and the device only displays it. Design changes ship from the backend, never by reflashing. The firmware lives in `sunny_display/` (ESP-IDF), written against one board config file of pin definitions with a driver per peripheral. Until the hardware is ready an iPad runs the same screens; once the server draws frames, the iPad shows those same frames so it is an exact stand-in.

| Feature | What it does | Priority |
| --- | --- | --- |
| Orientation header | Day and part of day in large type ("Saturday morning"), date below; no minute clock | Must have |
| Today list | 3–6 items, the due one highlighted, finished ones checked off. A task whose window closed without a confirmation is dimmed, on the display and on the phone, with no Done and no wording such as "missed"; the family handles it. On such a day the display never says everything is done; with nothing waiting it says "Nothing to do right now." | Must have |
| Next up | The next event and who it involves ("Sarah visits at 2pm") | Must have |
| Going-out strip | A fixed line at the bottom: "Going out? Wallet · Keys · Glasses · Phone"; visible all day, hidden in night view so it does not prompt night-time wandering; nothing to press | Must have |
| Done button | A press confirms the task that is due; if two are due, the top one. There is no undo on the display; a caregiver can reopen the task | Must have |
| Talk button | A second button, separate from Done, with its own shape, color and printed label; one press starts listening and it stops when they stop talking; no holding, no wake word, no always-listening | Must have |
| Due cue | Soft chime plus a light when a task comes due and at every later prompt step of its ladder, followed by the spoken prompt. The display never listens afterwards without a Talk press | Must have |
| Offline mode | The server sends frames ahead for the next 24 hours of clock-driven changes, plus the "after Done" frame for each due task, so the display still turns a task due, chimes, speaks and shows the right screen after Done. Past what it holds, it keeps the last frame with a small "not connected" mark and queues Done | Must have |
| Power | Normally on a wall-mounted charger, with a battery for outages and for carrying it. On power it checks the server every 20 seconds; on battery it sleeps, wakes on a key press and for each chime, and checks every 2 minutes, before every chime and after every key press. The intervals are sent by the server | Must have |
| Pairing and wifi | The display shows a code and QR that the caregiver enters in their app; wifi is set through a setup hotspot with a web page. Bluetooth setup from the app comes later | Must have |
| Over-the-air updates | The device API reports the available firmware version and the device updates itself | Must have |
| No on-device settings | Everything is configured from the caregiver app | Must have |
| Latest message | Newest family message or photo, with the sender's name | Nice to have |
| Night view | After a set hour: "It's nighttime. Next: breakfast pills at 8am" | Nice to have |
| Door sensor cue | For later stages: when the front door opens, chime, highlight the going-out strip and read it once; nothing to confirm | Later |
| Weather | One line: temperature and what to wear | Later |

The panel alternates between a Now page and a Today page. The page list and the interval are sent by the server, so whether the carousel stays on real e-ink (each flip is a partial refresh that leaves ghosting until a full one) is decided on the hardware without reflashing. Apart from that, refresh on state changes and at part-of-day boundaries only; skipping minute ticks keeps it calm and saves power.

Talk on the ESP32 is parked until the base firmware works; the device API reserves a voice-token call for it.

## Senior's phone

The phone mirrors the display for when the senior is out, with the same Today list and Done button.

| Feature | What it does | Priority |
| --- | --- | --- |
| Home screen widget | Medium widget with the Today list and Next up, plus an interactive Done button; no undo | Must have |
| Live Activity | Opens when the window starts for every timed task that prompts the senior, with Done on the lock screen; ends on confirm or when the window closes. Tasks without a time never open one | Must have |
| Time-sensitive notifications | At due time and for each reprompt. The phone does not speak the prompt; the notification and its sound are the cue | Must have |
| One-screen app | One large Done on the task that is due (the top one if two are due), or on the next task within 60 minutes of its time, with the day's list below it read-only; nothing to navigate. For 30 seconds after a press it shows "Morning pills done. Undo" | Must have |
| Lock screen widget | Just the next item; built together with the home screen widget | Nice to have |
| Geofence nudge | A gentle going-out reminder once they leave home; a backstop only, since it fires after they are out | Later |

The phone needs iOS 17.2 or later (interactive widgets and push-started Live Activities).

Two early checks: confirm on a real phone whether the widget appears under Apple's Assistive Access mode. Many seniors choose not to use it, so the one-screen app becomes an Assistive Access tile only if a pilot household needs it. And don't rebuild left-behind alerts for wallet and keys, since item trackers like AirTag already do that. Recommend them at onboarding instead.

## Voice

Voice does three jobs: prompt, confirm and answer anything. It is a full personal agent the senior reaches with the Talk button, but it never speaks without a task or a question behind it.

| Feature | What it does | Priority |
| --- | --- | --- |
| Scheduled prompt | A fixed sentence per task: "It's 8 o'clock. Time for your morning pills, the small white ones. Press the button when you've taken them." Sunny writes the task's sentence when the task is created and the server adds only the time lead; a reprompt is the identical sentence. It plays as local audio on the display, with no voice session: built-in speech on the iPad, and a clip made on the server in Sunny's voice on the e-ink device | Must have |
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

1. Window opens: display chime and light, spoken prompt on the display, phone notification and Live Activity
2. +15 min: the same chime and prompt again, and a second notification
3. +30 min: alert the on-call caregiver ("Mom hasn't confirmed her morning pills") by push, or by text if they have no app; they can claim it
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

**Daily digest:** one message at the caregiver's chosen time, 3–5 lines written only from the day's logged events, with a plain template as fallback. It covers what was confirmed and when, misses and escalations, questions voice couldn't answer, and repeat-question counts. It is posted in the caregiver chat thread with a push as its preview; a caregiver without the app gets it by text.

**Fan-out:** push to the caregiver app; push updates to the widget and Live Activity. The e-ink display checks the device API over HTTPS (see Power above); a persistent connection (WebSocket or MQTT) can replace the checks later behind the same API.

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
2. On the way to the door they pass the display, whose bottom line reads "Going out? Wallet · Keys · Glasses · Phone" all day (not in night view)
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
- Schedule and event forms in the caregiver app (chat is the editing surface)

## After the pilot

These features move Sunny from reminding the senior to helping them act. None of them is built before the pilot.

**Accuracy rule for step-by-step answers:** facts come from a real source (a transit routing service with live MTA alerts, a specific recipe, a scanned document); the model only simplifies them. If the source can't confirm a step, the agent says so and offers to call family. A wrong simple answer is worse than none, because the senior can't check it. For example, the 4/5/6 doesn't stop at Times Square; from Union Square the N, Q, R or W does.

| Feature | What it does | Priority |
| --- | --- | --- |
| Step mode | Any multi-step answer becomes numbered steps shown one at a time; Done means "next step" | Nice to have |
| Step mode for recipes and home routines | Kitchen recipes on the display with built-in timers and a final "turn off the stove" step | Nice to have |
| Morning briefing | Fixed 20–30 second summary at a caregiver-set time: day, weather, pills, visitors; skippable; can start on the first button press | Nice to have |
| Evening wrap-up | Closes the day's loop and previews tomorrow: "Everything's done except your evening pills. Tomorrow, Sarah comes at 2." Optional opt-in pain check (1 to 5) logged for doctor visits | Nice to have |
| Photos for recognition | Pill photo during medication prompts; visitor's photo next to "Sarah at 2" | Nice to have |
| "Where did I put…" | The senior says where they left something; the agent recalls it when asked. Also "Remember that…" for any fact | Nice to have |
| Pinned answers and display layout | A question asked three times in a day becomes a fixed tile on the display. Today stays fixed on the top two-thirds; a slow bottom panel shows the week in the morning and family photos in the evening; anything due takes the whole screen; caregivers choose panels | Nice to have |
| Transit step mode | On the phone: current step in a Live Activity with line symbol and a check cue ("the sign says Uptown"), elevator status when needed | Later |
| Mail and document explainer | Photograph a letter; the agent explains it simply, flags likely scams, adds due dates to the schedule | Later |
| Appointment prep | Who the doctor is and when they last saw them, a leave-by time from transit, and the trip in step mode | Later |
| Support level | One caregiver setting that adjusts answer detail, escalation timing and display density as the condition changes | Later |
| Patterns for the doctor | Observations to mention at appointments ("morning pills drifted from 8:10 to 9:30 over three weeks"); never scores or anything resembling diagnosis | Later |

**Memory, two meanings:** agent memory is facts the agent knows, verified by caregivers. Family memories are photos and moments shown on the display. They are separate features.

## Build order and success metrics

Built so far (merged to `main` through PR 12, 2026-11-10):

- Backend: shared state, scheduler, escalation ladder with claim, daily digest by text, question log, household list
- Caregiver app: Home timeline with mark done, Chat with task and calendar tools, About tab (life profile, hard questions, remembered facts, messages)
- Senior phone: Today screen with Talk and one large Done (up to 60 minutes early, presses queued durably offline and recorded at the time of the press)
- iPad display: Now and Today pages, Done and Talk keys, Talk on the panel with the answer shown for 3 minutes, chime and spoken prompt at every prompt step
- Voice agent: guardrails prompt, confirm, snooze, medication facts and dose log, caregiver flags, family messages, memory, weather, the list

On 2026-11-13 pairing, the phone's Done, the display's due card and Done key, and the chat agent were checked in the iPhone and iPad simulators against the dev deployment. Not yet checked anywhere: Talk, the sound of the due cue, the offline queue, push banners and the caregiver screens. Nothing has run on a real device.

Remaining, in order:

1. Device check on a real iPhone and iPad of what the simulator cannot show: Talk and a live conversation with the voice agent, the sound of the due cue, the offline queue, push, and the caregiver screens
2. Backend foundation: device token and HTTP device API, the display rules moved into one server device state, senior undo, caregiver reopen
3. Senior surfaces offline: day view kept across a restart, due transitions and the cue on the device's own clock, display Done through the durable queue, the phone's 30-second undo
4. Caregiver alerts: push with "I'm on it", text as fallback, digest posted in the chat thread
5. iOS extension: home screen widget, lock screen widget, Live Activity, iOS 17.2 floor, Assistive Access check (runs alongside 3 and 4)
6. Frame renderer: server-drawn frames sized per device, prompt audio clips, iPad switched to frames
7. Firmware: `sunny_display/`, code and QR pairing, wifi hotspot setup, over-the-air updates, docked and battery modes, frames sent ahead for offline; then Talk on the ESP32
8. Caregiver setup by chat: knowledge and preference tools, the wording card, the settings screen, views for the list and for flags
9. Pilot readiness: metrics, export and delete, production deployment, BAAs
10. Pilot with 3–5 households

Steps 6 and 7 start when a board that can be flashed arrives (expected around 2026-11-20); if it is late, 8 goes first.

| Metric | How it's measured | Proposed target |
| --- | --- | --- |
| Confirmation rate | Instances confirmed within their window / scheduled | 80% or more |
| Caught before missed | Unconfirmed instances a caregiver resolved before the window closed / all unconfirmed | 70% or more |
| Time to confirm | Median minutes from window open to confirmation | Under 15 |
| Answer success | Questions answered without "not sure" or a caregiver correction / asked | 85% or more |
| Helpfulness to the senior | Weekly 1–5 check-in: "Is this helping you?" | Median 4 or higher |
| Caregiver alert load | Escalation alerts per caregiver per week | Falls over the pilot |
| Surface mix | Share of confirmations by button, widget and voice; questions asked per week as the adoption signal | Tracked, no target |

## Change log

- 2026-11-13: This file became the living spec. Caregiver editing is chat only, with Sunny choosing the settings; schedule and event forms dropped; knowledge and preferences by chat; a small settings screen for actions that need a tap. Senior phone gets one large Done with a 30-second undo; the display has no undo and caregivers can reopen a confirmed task. Offline devices keep their own clock and send the press time. Prompts play as local audio at every prompt step. Device token, HTTP device API and a server device state shared by every senior surface. E-ink hardware named (Waveshare 13.3 inch, ESP32-S3), server-drawn frames sized per device, docked with a battery mode, pairing by code and QR, over-the-air updates. Caregiver alerts by push with text as fallback; digest in the chat thread. Widgets and Live Activity scoped; iOS 17.2 floor. "After the pilot" section added from the newer doc export. Build order rewritten against `origin/main` as of PR 12. Missed tasks are dimmed on senior surfaces (decided after the first simulator check).
- 2026-11-14: After a reopen the ladder continues and overdue prompts and alerts go out right away. On a day with a missed task the display says "Nothing to do right now.", never that everything is done. An offline Undo is queued and judged from the tap; a press made before a take-back is ignored. Status lines updated after the first simulator check.
