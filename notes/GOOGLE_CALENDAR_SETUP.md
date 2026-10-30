# Google Calendar setup

One-time setup of the Google Cloud project behind "Connect Google Calendar" (Convex backend). Sunny asks only for `calendar.app.created` (create its own calendars and manage events in them), plus `openid email` to show which account is connected.

## 1. Project and API

1. Open https://console.cloud.google.com and create a project named **Sunny**.
2. **APIs & Services > Library**: search **Google Calendar API** and click **Enable**.

## 2. Consent screen (Google Auth Platform)

1. **Google Auth Platform > Branding** (or "OAuth consent screen", then **Get started**): app name **Sunny**, your support email, then **Audience: External**, your contact email, agree, **Create**.
2. **Audience**: leave the publishing status at **Testing** and add **test users**: every Google account that will connect (yours, and any caregiver testing with you). Unverified apps only work for listed test users.
3. **Data access > Add or remove scopes**: add `https://www.googleapis.com/auth/calendar.app.created` (filter for "calendar.app.created"), `openid` and `.../auth/userinfo.email`. Save.

Testing-mode limits: refresh tokens expire after 7 days, so a test caregiver reconnects weekly until the app is published and verified (calendar scopes need Google's verification before public launch).

## 3. OAuth client

1. **Google Auth Platform > Clients > Create client**, type **Web application**, name **Sunny backend**.
2. **Authorized redirect URIs**, add: `https://enduring-ostrich-959.convex.site/google/callback` (the dev deployment's HTTP actions URL, `.convex.site`, not `.convex.cloud`). A production deployment has its own `.convex.site` URL; add it too when you deploy.
3. **Create**, then copy the **Client ID** and **Client secret**.

## 4. Environment variables

Set them on the Convex deployment from `sunny_backend/` (add `--prod` for production). Sunny does not need a `.env` file for these:

```bash
npx convex env set GOOGLE_CLIENT_ID <client id>
npx convex env set GOOGLE_CLIENT_SECRET <client secret>
npx convex env set GOOGLE_REDIRECT_URI https://enduring-ostrich-959.convex.site/google/callback
npx convex env set GOOGLE_OAUTH_STATE_SECRET "$(openssl rand -hex 32)"
npx convex env set CALENDAR_TOKEN_KEY "$(openssl rand -base64 32)"
```

`CALENDAR_TOKEN_KEY` encrypts the stored refresh tokens. Keep a copy somewhere safe: stored tokens carry no key id, so rotating or losing the key makes them unreadable and every caregiver has to reconnect Google Calendar (Sunny marks such connections with a reconnect message).

## 5. Connect

```bash
cd sunny_backend
npx tsx scripts/caregiver.ts google
```

Open the printed link signed in as a test user, allow access, and a calendar named "Mom (Sunny)" appears in Google Calendar with every Sunny event, each with a popup reminder on the morning of the event. Later edits are pushed automatically (a few seconds apart at most; repeated edits merge). The app can list the connection with `googleCalendar:myConnections` and remove it with `googleCalendar:disconnect`; the Google calendar itself is left in place.
