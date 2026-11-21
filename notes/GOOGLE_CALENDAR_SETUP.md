# Google Calendar setup

One-time setup of the Google Cloud project behind "Connect Google Calendar" (Convex backend). Sunny asks only for `calendar.app.created` (create its own calendars and manage events in them), plus `openid email` to show which account is connected.

## 1. Project and API

1. Open https://console.cloud.google.com and create a project named **Sunny**.
2. **APIs & Services > Library**: search **Google Calendar API** and click **Enable**.

## 2. Consent screen (Google Auth Platform)

1. **Google Auth Platform > Branding** (or "OAuth consent screen", then **Get started**): app name **Sunny**, your support email, then **Audience: External**, your contact email, agree, **Create**.
2. **Audience**: leave the publishing status at **Testing** and add **test users**: every Google account that will connect (yours, and any caregiver testing with you). Unverified apps only work for listed test users.
3. **Data access > Add or remove scopes**: add `https://www.googleapis.com/auth/calendar.app.created` (filter for "calendar.app.created"), `openid` and `.../auth/userinfo.email`. Save.

In testing mode, refresh tokens expire after 7 days, so a test caregiver reconnects weekly until the app is published and verified. Calendar scopes need Google's verification before public launch.

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

`CALENDAR_TOKEN_KEY` encrypts the stored refresh tokens and also keys the phone verification codes. Keep a copy somewhere safe: stored tokens carry no key id, so rotating or losing the key makes them unreadable and every caregiver has to reconnect Google Calendar (Sunny marks such connections with a reconnect message).

## 5. Connect

```bash
cd sunny_backend
npx tsx scripts/caregiver.ts google
```

Open the printed link once, within 5 minutes, in the browser where you sign in as a test user. The link sets a cookie that the callback checks, so a different browser or a second use shows "Link expired". Allow access, and a calendar named after the senior ("Mom (Sunny)" when her preferred name is Mom) appears in Google Calendar with every Sunny event. Each event has a popup reminder at the household's event notice time on the day of the event, or an hour before it when the event starts earlier than that. Sunny pushes later edits automatically (a few seconds apart at most; repeated edits merge). The app can list the connection with `googleCalendar:myConnections` and remove it with `googleCalendar:disconnect`; the Google calendar itself is left in place.

## 6. Gmail (reading the senior's mail)

Sunny reads the senior's Gmail with the read-only scope `https://www.googleapis.com/auth/gmail.readonly`. It uses the same OAuth client and environment variables as the calendar, plus two model keys on the Convex deployment: `TYPESAFE_API_KEY` (TypeSafe's Jev judges each email) and `ANTHROPIC_API_KEY` (Claude Haiku writes the summary for caregivers; the chat agent already needs this key).

Set the TypeSafe key from `sunny_backend/` (add `--prod` for production):

```bash
npx convex env set TYPESAFE_API_KEY <key>
```

Then, in the Google Cloud console:

1. **APIs & Services > Library**: search **Gmail API** and click **Enable**.
2. **Google Auth Platform > Data access > Add or remove scopes**: add `https://www.googleapis.com/auth/gmail.readonly`. Save. This is a restricted scope; it works for test users while the app stays in **Testing**. Public use needs Google's verification and, for restricted scopes, a yearly security assessment by an assessor that Google approves.
3. **Audience**: add the senior's Google account as a test user. Test-mode refresh tokens expire after 7 days, so reconnect weekly until the app is verified.
4. Connect, signed in as the senior's Google account, in the browser that opens the link:

```bash
cd sunny_backend
npx tsx scripts/caregiver.ts gmail
```

Only a primary caregiver or member can connect. Sunny backfills the last 7 days (at most 50 messages) and then checks for new mail every 5 minutes, except while the household is paused. Connecting again replaces the grant. The app can show the mailbox with `gmail:mailboxStatus` and remove it with `gmail:disconnect`. Disconnecting revokes the grant at Google when no other Sunny connection uses that Google account.

To check that it worked: `gmail:mailboxStatus` shows `active`, and the caregiver chat has a post "Sunny now reads <address>." Sunny acts by itself on mail from senders Gmail verified. Mail it could not verify, and mail that needs a decision, arrives as a post in the chat. Reply there to add or move the appointment.
