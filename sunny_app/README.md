# sunny_app

Sunny's senior-facing iOS app: the phone's Today view with the Talk button, and the iPad
home display stub. Built with React Native on Expo (SDK 57) and the LiveKit React Native
SDK. The backend is Supabase (see `../supabase`).

## What it does

- **Pairing:** a device signs in anonymously with Supabase Auth and redeems a caregiver's
  8-character join code. The code decides whether it is the senior's phone or the home display.
- **Day clock:** both surfaces render `get_day_view` (orientation header, Next up, today's
  tasks and events, the coming week), refreshed every 30 seconds and on returning to the foreground.
- **Talk:** the phone joins a LiveKit room with a token from the `livekit-token` Edge Function.
  The agent can call two RPCs on the phone: `findContact` (contacts search) and `sendMessage`
  (opens the SMS composer). App logs are forwarded to the agent on the `ios.log` data topic
  while a session is live.
- **Push:** the raw APNs token is stored in `push_tokens`. Tapping a notification that carries
  `task_instance_id` starts a session with trigger `notification_tap`.

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

The Supabase URL and publishable key default to the hosted project (public values set in
`src/config.ts`), so no env file is needed. To use the local Supabase stack, put overrides in
a git-ignored `.env.local`:

```
EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
EXPO_PUBLIC_SUPABASE_KEY=<PUBLISHABLE_KEY from `supabase status`>
```

## Checks

```bash
npm run typecheck
npm run lint
npm test
```

Pre-commit (repo root) runs prettier, eslint and tsc on this folder.
