# Sunny

A memory-care agent for seniors with MCI or early dementia who live alone, and the family members who coordinate their care. Caregivers set up the day; the senior confirms each task on whichever surface is closest (home display, phone, or voice); anything unconfirmed escalates to family before it is missed.

See `notes/SPEC.md` for the POC feature spec and `notes/HANDOFF.md` for how the existing code maps onto it.

## Repo layout

- `sunny_agent/` - LiveKit voice agent (Deepgram STT, Claude Haiku, Cartesia TTS), Tavily web search
- `sunny_app/` - iOS app (SwiftUI). The `sunny` target is the senior's phone surface; a caregiver target will be added to the same project
- `supabase/` - database migrations and Edge Functions
