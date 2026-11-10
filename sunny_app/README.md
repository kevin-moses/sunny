# sunny_app

Sunny's senior-facing iOS app: the phone's Today view with the Talk button, and the iPad
home display (standing in for the e-ink device). Built with React Native on Expo (SDK 57) and the LiveKit React Native
SDK. The backend is Convex (see `../sunny_backend`) with Clerk for sign-in.

## What it does

- **Pairing:** the device redeems a caregiver's 8-character join code at the backend's `/pair`
  HTTP endpoint and signs in to Clerk with the ticket it returns (see "How pairing works").
  The code decides whether it is the senior's phone or the home display.
- **Day clock:** both surfaces render the live `calendar.dayView` query (orientation header,
  Next up, today's tasks and events, the coming week). It is a Convex subscription, so changes
  push automatically; the app only passes the current minute so "Next up" stays current. The
  offline banner shows when the Convex socket is down.
- **Talk:** the phone joins a LiveKit room with a token from the `voice.livekitToken` action.
  The agent can call two RPCs on the phone: `findContact` (contacts search) and `sendMessage`
  (opens the SMS composer). App logs are forwarded to the agent on the `ios.log` data topic
  while a session is live.
- **Push:** the raw APNs token is registered with `households.registerPushToken`. Tapping a
  notification that carries `task_instance_id` starts a session with trigger `notification_tap`.
  The home display keeps foreground notifications out of sight and silent (its due cue covers
  the same prompts).

## Home display voice and due cue

The iPad display (`src/screens/DisplayScreen.tsx`, `src/display/`) never swaps to the phone's
conversation screen. Its voice states live on the paper panel:

- **Talk:** one press starts a session (same LiveKit session and token action as the phone).
  The voice card reads "One moment", then "Listening" once the microphone is open (LiveKit
  keeps what is said while the agent joins), "Thinking" with the question heard, then the
  agent's answer as large text while it is spoken. The card takes the Next up card's place
  beside a waiting task, or the whole body when nothing is waiting. Pressing Talk during a
  session, also while it is still connecting, ends it. A session that has not reached the
  agent in 15 s gives up ("Could not connect. Try again."); once the agent is there, the
  session ends by itself after 20 s without a question or 10 s after an answer; continuous
  "speaking" (a TV can sound like the senior) holds it open for at most 30 s. Whatever happens,
  a session ends 3 minutes after the press ("Sunny stopped listening for now."), letting an
  answer being spoken finish for at most 30 s more, so the microphone is never open longer
  than 3.5 minutes per press. Ending or cancelling a session stops and unpublishes the
  microphone track, also one that comes on after the cancel. Only an answer to a question
  counts: a line the agent says first is shown but never lingers. The last answer
  stays on the panel for 3 minutes, unless a task comes due. Failures show on the status line
  in plain words; Talk while offline says so instead of connecting. The display asks for
  microphone permission when it opens, so the senior never meets the iOS dialog. The phone's
  contact and message tools are not offered to the agent on the display.
- **Due cue:** when a timed task comes due, and on each reprompt the backend sends (the day
  view's `seniorPrompts` count), the display plays a soft chime (`assets/sounds/chime.wav`,
  synthesized by `node scripts/makeChime.js`) and speaks the task's prompt with on-device
  speech (`expo-speech`, slow rate): the caregiver's spoken prompt, or "Time for <label>, at
  <time>. Press Done when you have taken them / finished." Never during a voice session (it
  waits until 2 s after the session, and is dropped if the task was confirmed meanwhile),
  never while a task is snoozed (the day view's `snoozed`; the Now card's tab reads "Later"):
  its owed cue plays when the snooze ends, within about a minute, unless the task was
  confirmed. Two cues for one task are at least 2 minutes apart, so the snooze end and the
  backend's reprompt that may follow give one cue. Never for anytime tasks, and once per
  prompt across restarts (played cues are kept in AsyncStorage). A cue that fails to sound, or
  whose speech gets stuck, is tried once more from the line that failed. Audio uses the
  playback category, so it plays with the device muted.
- **Tuning:** every timing and the speech rate live in `src/display/tuning.ts` (default,
  unit, allowed range and step for each). On a debug build, hold the DEV pill on the display
  for 2 seconds to open the developer sheet: its "Home display" section edits each value
  within its range, saves it on the device and applies it at once, resets to the defaults,
  and has "Play due cue now" (played by the display's cue owner: refused, with the reason,
  during a voice session or while a cue plays; stopped when the sheet closes) and "Show sample
  answer" for quick checks. Release builds have no sheet and ignore saved values.

`expo-audio`, `expo-speech` and `expo-asset` are native modules: after pulling them, rebuild
the development client with `npm run ios -- --device`.

## How pairing works

1. `pair(code)` (`src/backend/pairing.ts`) POSTs `{ code, pairingNonce }` to
   `<CONVEX_SITE_URL>/pair`. The nonce is a random UUID from `expo-crypto`, created
   when a code is first tried and kept with the code in AsyncStorage until pairing succeeds.
   If a response is lost and the same code is submitted again within 10 minutes, the same
   nonce is resent and the server returns a fresh ticket for the same device.
2. The 200 body `{ ticket, householdId, deviceId, kind }` carries a Clerk sign-in ticket.
   The app calls `clerk.client.signIn.create({ strategy: 'ticket', ticket })` and
   `clerk.setActive({ session })`; from then on Convex calls are authenticated as the device.
   The Clerk session is kept in the Keychain through `@clerk/expo/token-cache`.
3. Nothing about the pairing is stored locally. The app derives it from the Clerk session,
   Convex auth and the `households.mine` query, which also reports the account kind (`useSession` / `decideSession`). The pairing
   screen shows only when Clerk has loaded and has no session. A device is paired when `mine`
   has an entry with a `deviceKind`. Signed in but no such entry (the device was removed, or a
   caregiver account is signed in) means removed: the app unregisters its push token and signs
   out, retrying with a capped backoff until the session is gone. If Clerk has a session but
   Convex cannot authenticate (offline, network error), the app keeps the last device seen in
   this run, or shows "Connecting..." with a short notice when the backend cannot be reached.
   An offline cold start therefore stays on "Connecting..." until Clerk and Convex answer
   (there is no cached home screen).
4. Errors come back as `{ error: { code, message } }`; the message is shown. Convex function
   errors (`ConvexError` with `{ code, message }`) become a `BackendError` with a status
   (forbidden 403, unauthenticated 401, not_found 404, invalid 400, limit 429, otherwise 0).

## Setup

Requirements: Node 20+, Xcode, CocoaPods (`brew install cocoapods`), and a physical iPhone for
voice (the iOS Simulator cannot publish microphone audio with the LiveKit React Native SDK).
Expo Go does not work; the app needs a development build because LiveKit ships native code.

```bash
npm install
npm run ios -- --device
```

`npm run ios` runs `expo run:ios`, which generates `ios/` (git-ignored, regenerated from
`app.json`) and builds the development client. After the first build, start Metro with
`npm start`. Rebuild with `npm run ios` whenever `app.json`, a config plugin, or a native
dependency changes.

### Configuration

All values are public client values with defaults (the hosted Convex deployment and the Clerk
dev instance), so no env file is needed. Optional overrides go in a git-ignored `.env.local`:

```
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
EXPO_PUBLIC_CONVEX_URL=https://enduring-ostrich-959.convex.cloud
EXPO_PUBLIC_CONVEX_SITE_URL=https://enduring-ostrich-959.convex.site
```

The site URL is derived from the Convex URL unless overridden. An empty
`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` shows a configuration error screen. The Clerk instance needs a JWT template named `convex` (the
backend's auth config expects it). Restart Metro with `npx expo start -c` after changing env
values. `@clerk/expo` and `convex` add native modules, so rebuild the development client
(`npm run ios`) after the first install.

### Backend api types

`src/backend/convexApi.ts` exports `api` as Convex's `anyApi` proxy at runtime, cast to the
backend's generated `api` type imported with `import type` from
`../../sunny_backend/convex/_generated/api`. The import is erased at build time, so Metro
never resolves or bundles backend files (and never sees a second copy of `convex`), while
TypeScript follows the real function signatures: `FunctionReturnType<typeof
api.calendar.dayView>` defines the day types in `src/day/types.ts`. After changing backend
functions, regenerate `sunny_backend/convex/_generated` (`npx convex dev` / `npx convex
codegen`) so the app's types update.

## Checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
```

Pre-commit (repo root) runs prettier, eslint and tsc on this folder.
