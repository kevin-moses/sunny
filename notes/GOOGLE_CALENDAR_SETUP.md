# Google Calendar setup

One-time setup of the Google Cloud project behind "Connect Google Calendar". Sunny asks only for `calendar.app.created` (create its own calendars and manage events in them), plus `openid email` to show which account is connected.

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
2. **Authorized redirect URIs**, add both:
   - `http://localhost:54321/functions/v1/google-oauth/callback` (local stack)
   - `https://rlihlcgyjqyzkpzijtsp.supabase.co/functions/v1/google-oauth/callback` (remote)
3. **Create**, then copy the **Client ID** and **Client secret**.

## 4. Secrets

Local: put them in `supabase/functions/.env` (git-ignored) as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and restart `supabase functions serve`.

Remote (when deploying):

```bash
supabase secrets set --project-ref rlihlcgyjqyzkpzijtsp GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REDIRECT_URI=https://rlihlcgyjqyzkpzijtsp.supabase.co/functions/v1/google-oauth/callback GOOGLE_OAUTH_STATE_SECRET=$(openssl rand -hex 32)
```

## 5. Connect

```bash
deno run -A --env-file=supabase/scripts/.env.local supabase/scripts/caregiver.ts google
```

Open the printed link signed in as a test user, allow access, and a calendar named "Mom (Sunny)" appears in Google Calendar with every Sunny event, each with a popup reminder on the morning of the event.
