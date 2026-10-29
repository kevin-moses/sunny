# sunny_app

Sunny's senior-facing iOS app: the phone's Today view with the Talk button, and the iPad
home display stub. Built with React Native on Expo (SDK 57) and the LiveKit React Native
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
   Convex auth and the `households.mine` query (`usePairing` / `decidePairing`). The pairing
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
