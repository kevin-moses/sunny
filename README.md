# Sunny

A memory-care agent for seniors with MCI or early dementia who live alone, and the family members who coordinate their care. Caregivers set up the day; the senior confirms each task on whichever surface is closest (home display, phone, or voice); anything unconfirmed escalates to family before it is missed.

See `notes/SPEC.md` for the POC feature spec and `notes/HANDOFF.md` for how the existing code maps onto it.

## Repo layout

- `sunny_agent/` - LiveKit voice agent (Deepgram STT, Claude Haiku, Cartesia TTS), Tavily web search
- `sunny_app/` - iOS app (React Native / Expo, LiveKit React Native SDK). The senior's phone surface and the iPad home display stub; see `sunny_app/README.md`
- `supabase/` - database migrations and Edge Functions
