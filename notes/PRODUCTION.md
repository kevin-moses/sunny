# Production checklist

Work through this when Sunny is ready for real families. The dev setup (`enduring-ostrich-959`, Clerk dev instance, Google in testing mode, APNs sandbox) is described in `notes/HANDOFF.md`. Compliance research is dated 2026-10-29; items marked UNVERIFIED were not confirmed against a primary source. This is not legal advice.

## 1. Convex production deployment

- [ ] From `sunny_backend/`, logged in to Convex in your terminal: `npx convex deploy` (or use a deploy key in CI).
- [ ] Note the prod URLs: `https://<prod>.convex.cloud` (clients) and `https://<prod>.convex.site` (HTTP actions: `/pair`, `/google/callback`, `/twilio/sms`).
- [ ] Set every env var below on prod: `npx convex env set --prod NAME value`. For multi-line secrets use `--from-file`, for example `npx convex env set --prod APNS_KEY_P8 --from-file <key.p8>`. Never commit these or paste them in chat.

| Component | Variables |
| --- | --- |
| Clerk | `CLERK_JWT_ISSUER_DOMAIN` (prod instance), `CLERK_SECRET_KEY` |
| LiveKit | `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SERVER_URL` |
| Voice agent link | `SUNNY_AGENT_KEY` (new random value for prod; the Python agent must use the same one) |
| Agent runtime | `ANTHROPIC_API_KEY`, `SUNNY_AGENT_ID`, `SUNNY_ENVIRONMENT_ID`, optional `SUNNY_AGENT_SESSION_BUDGET_CENTS` |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (prod `.convex.site/google/callback`), `GOOGLE_OAUTH_STATE_SECRET`, `CALENDAR_TOKEN_KEY` |
| APNs | `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8`, `APNS_ENVIRONMENT`, optional `APNS_BUNDLE_ID` |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_URL`, optional `SMS_ALLOWED_COUNTRY_CODES` |

- [ ] Generate fresh values for prod secrets (`openssl rand -hex 32`, `openssl rand -base64 32` for `CALENDAR_TOKEN_KEY`). Keep a copy of `CALENDAR_TOKEN_KEY` somewhere safe.
- [ ] Warning: rotating or losing `CALENDAR_TOKEN_KEY` forces every caregiver to reconnect Google Calendar and invalidates pending phone verification codes (codes are HMACs keyed from it).
- [ ] Confirm the crons are running in the prod dashboard (scheduler tick every minute, sweepers).

## 2. Clerk production instance

- [ ] Create the production instance. It needs a domain you own and the DNS records Clerk lists.
- [ ] Recreate the JWT template named `convex` (audience `convex`) with the claim `"sunny_kind": "{{user.public_metadata.sunny_kind}}"`.
- [ ] Sign-in settings: username optional but enabled (Clerk refuses sign-in tickets for users with no identifier, and `/pair` creates device users with only a `device_<32 hex>` username), email optional, password off.
- [ ] Social sign-in: Google and Apple, each with your own OAuth credentials (the dev instance's shared ones do not carry over).
- [ ] Set `CLERK_JWT_ISSUER_DOMAIN` and `CLERK_SECRET_KEY` on Convex prod from this instance.
- [ ] Build the app with `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (production key) and `EXPO_PUBLIC_CONVEX_URL` (prod `.convex.cloud`) set; `EXPO_PUBLIC_CONVEX_SITE_URL` is derived unless overridden. The defaults in `sunny_app/src/config.ts` point at dev.

## 3. Voice agent

- [ ] Run the agent with `CONVEX_URL` (prod `.convex.cloud`) and `SUNNY_AGENT_KEY` equal to the prod value, plus its LiveKit, Anthropic, Deepgram, Cartesia and Tavily keys.
- [ ] Deploy it to LiveKit (`livekit.toml`; the template's CI check that blocks committing it must be removed first) or run the `sunny_agent/Dockerfile` elsewhere.
- [ ] The LiveKit project behind `LIVEKIT_SERVER_URL` must be the one the agent registers with.

## 4. Managed Agents

- [ ] Run `scripts/setup_managed_agent.ts` against the production Anthropic organization (or reuse the existing agent): `npx tsx --env-file=.env.local scripts/setup_managed_agent.ts`. The env file needs the production `ANTHROPIC_API_KEY`.
- [ ] Set the printed `SUNNY_AGENT_ID` and `SUNNY_ENVIRONMENT_ID` on Convex prod.
- [ ] Read section 8 first: Claude Managed Agents is not covered by Anthropic's BAA.

## 5. Google Calendar

- [ ] Publish the OAuth consent screen and complete Google's verification for the `calendar.app.created` scope. In testing mode refresh tokens expire after 7 days.
- [ ] Add the prod redirect URI (`https://<prod>.convex.site/google/callback`) to the OAuth client and set `GOOGLE_REDIRECT_URI` to match.
- [ ] Setup details: `notes/GOOGLE_CALENDAR_SETUP.md`.

## 6. APNs

- [ ] Set `APNS_ENVIRONMENT=production` on prod for TestFlight and App Store builds (development is only for Xcode dev builds).
- [ ] The same key (`APNS_KEY_ID`, `APNS_KEY_P8`) works for both environments.

## 7. Twilio

- [ ] Complete A2P 10DLC or toll-free verification (pending as of 2026-10-29).
- [ ] Point the inbound SMS webhook at `https://<prod>.convex.site/twilio/sms` and set `TWILIO_WEBHOOK_URL` to exactly that string.
- [ ] `TWILIO_FROM_NUMBER` must be the Twilio number.
- [ ] Test end to end: caregiver phone verification, an alert, and replying "1" to claim.

## 8. Compliance

### Applicability (needs a lawyer)

- A direct-to-family consumer app is likely not a HIPAA covered entity or business associate. It becomes a business associate if sold to agencies or clinics.
- The FTC Health Breach Notification Rule (2024 update) likely applies as a personal health record vendor. A breach includes unauthorized disclosure. Notify individuals within 60 days and the FTC; notify media if 500 or more people in a state are affected.
- State laws (for example Washington My Health My Data) were not researched.

### BAA table

| Vendor | BAA? | Notes and source |
| --- | --- | --- |
| Convex | Yes | Professional ($25 per developer per month, per the pricing page) and up; contact Convex. convex.dev/pricing, convex.dev/security |
| Clerk | Yes, Enterprise only | clerk.com/security, clerk.com/legal/dpa |
| Twilio | Yes, Security or Enterprise Edition | Eligible products only. SMS reaches handsets outside Twilio's control, so keep texts minimal-PHI. twilio.com/en-us/hipaa. Eligible-product list and SMS caveats UNVERIFIED |
| Anthropic | Yes | Self-serve in the Console Data retention page or via sales; org-wide and permanent. Messages API is eligible. Claude Managed Agents is NOT eligible (also excluded: code execution, web fetch, Files, Batch, Console, Claude Code). HIPAA readiness replaces ZDR. Do not put PHI in JSON schemas or strict tool definitions. platform.claude.com/docs/en/manage-claude/api-and-data-retention, the Managed Agents overview, privacy.claude.com article 8114513 |
| LiveKit Cloud | Yes, on Scale, Enterprise or the Startup program | Contact support with the entity, signer and project ids. Plugins are not covered. docs.livekit.io/deploy/admin/hipaa/ |
| Deepgram | Yes, on request | developers.deepgram.com/docs/data-privacy-compliance. Which plan UNVERIFIED |
| Cartesia | Depends on plan | trust.cartesia.ai. UNVERIFIED |
| Resend | No | resend.com/security (currently unused by Sunny) |
| Google Calendar | Not for personal accounts | A Workspace BAA does not cover personal accounts; treat caregiver calendars as outside any BAA |
| APNs | No BAA found | UNVERIFIED |

### If HIPAA applies, Sunny must change

- [ ] Household agent: move from Managed Agents to the Messages API with our own tool loop, or keep PHI out of it.
- [ ] SMS wording: minimal PHI ("Check Sunny for an update") instead of medication names.
- [ ] Google event titles: generic or opt-in.
- [ ] No PHI in Clerk metadata or JWT claims (device users are already pseudonymous).
- [ ] Keep PHI out of third-party logging sinks.

## 9. Decommission the old Supabase project

- [ ] Only after the cleanup PR merges and nothing uses the project (user action in the Supabase dashboard).
- [ ] Nothing was planned for migration (no pilot data). If you are unsure, export first: any tables with real data, and note that Google tokens lived in Vault and cannot be moved (caregivers reconnect).
