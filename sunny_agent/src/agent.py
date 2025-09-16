import json
import logging

from dotenv import load_dotenv
from livekit.agents import (
    NOT_GIVEN,
    Agent,
    AgentFalseInterruptionEvent,
    AgentSession,
    JobContext,
    JobProcess,
    MetricsCollectedEvent,
    RoomInputOptions,
    RunContext,
    WorkerOptions,
    cli,
    metrics,
)
from livekit.agents.llm import function_tool
from livekit.plugins import cartesia, deepgram, noise_cancellation, openai, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel
from tavily import TavilyClient

logger = logging.getLogger("agent")

load_dotenv(".env.local")


class Assistant(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions="""You are a helpful voice assistant named Sunny, here to make the user's life easier. You are a voice interface to help with more accessible phone interactions.
            You eagerly assist users with their questions by providing information from your extensive knowledge.
            Your responses are concise, to the point, and without any complex formatting or punctuation including emojis, asterisks, or other symbols.
            You are curious, friendly, and have a sense of humor.""",
        )
        self.tavliy_client = TavilyClient()  # API key is loaded from .env.local automatically

    @function_tool
    async def web_search(self, context: RunContext, query: str):
        """Use this tool to look up information on the web.
        
        Args:
            query: The search query to look up
            
        Returns:
            The search results or an error message
        """
        logger.info(f"Looking up information on {query}")
        await context.session.say("I'm looking up information on that topic. Please wait a moment.")
        try:
            response = self.tavliy_client.search(query, include_answer="basic")
            logger.info(f"Answer: {response.get('answer')}")
            return response.get("answer", "No results found for that query.")
        except Exception as e:
            logger.error(f"Error looking up information on {query}: {e}")
            return "I'm sorry, I'm having trouble with my web search right now. Please try again later."

    @function_tool
    async def create_reminder(self, context: RunContext, title: str, notes: str = "", due_date: str = ""):
        """Create a reminder in the user's Reminders app.

        Args:
            title: The title of the reminder (required)
            notes: Optional notes for the reminder
            due_date: Optional due date in format "YYYY-MM-DD HH:MM" or "YYYY-MM-DD"

        Returns:
            Confirmation message or error
        """
        logger.info(f"Creating reminder: {title}")
        await context.session.say("I'll create that reminder for you.")

        try:
            # Import get_job_context to access the room
            from livekit.agents import get_job_context

            room = get_job_context().room
            participant_identity = next(iter(room.remote_participants))

            # Prepare the reminder data
            reminder_data = {
                "title": title,
                "notes": notes,
                "due_date": due_date
            }

            # Send RPC call to the iOS app
            response = await room.local_participant.perform_rpc(
                destination_identity=participant_identity,
                method="createReminder",
                payload=json.dumps(reminder_data),
                response_timeout=10.0,
            )

            logger.info(f"Reminder creation response: {response}")
            return f"Reminder '{title}' has been created successfully."

        except Exception as e:
            logger.error(f"Error creating reminder: {e}")
            return "I'm sorry, I couldn't create that reminder. Please try again."

    @function_tool
    async def find_contact(self, context: RunContext, query: str):
        """Find contacts matching a search query.

        Args:
            query: The search string to match against contact names

        Returns:
            List of matching contacts with names and phone numbers
        """
        logger.info(f"Finding contacts for query: {query}")
        await context.session.say("Let me search your contacts.")

        try:
            # Import get_job_context to access the room
            from livekit.agents import get_job_context

            room = get_job_context().room
            participant_identity = next(iter(room.remote_participants))

            # Prepare the search data
            search_data = {
                "query": query
            }

            # Send RPC call to the iOS app
            response = await room.local_participant.perform_rpc(
                destination_identity=participant_identity,
                method="findContact",
                payload=json.dumps(search_data),
                response_timeout=10.0,
            )

            logger.info(f"Contact search response: {response}")

            # Parse the response to get contact list
            contacts = json.loads(response)

            if not contacts:
                return f"I couldn't find any contacts matching '{query}'. Please try a different name."
            elif len(contacts) == 1:
                contact = contacts[0]
                return f"I found {contact['name']} with phone number {contact['phone']}."
            else:
                contact_list = ", ".join([f"{c['name']} ({c['phone']})" for c in contacts[:3]])
                if len(contacts) > 3:
                    contact_list += f" and {len(contacts) - 3} more"
                return f"I found {len(contacts)} contacts: {contact_list}. Which one would you like to message?"

        except Exception as e:
            logger.error(f"Error finding contacts: {e}")
            return "I'm sorry, I couldn't search your contacts right now. Please try again."

    @function_tool
    async def send_message(self, context: RunContext, contact_name: str, phone_number: str, message: str):
        """Send a message to a contact.

        Args:
            contact_name: The name of the contact (for confirmation)
            phone_number: The recipient's phone number
            message: The message content to send

        Returns:
            Confirmation message or error
        """
        logger.info(f"Sending message to {contact_name} ({phone_number}): {message}")
        await context.session.say(f"I'll send that message to {contact_name}.")

        try:
            # Import get_job_context to access the room
            from livekit.agents import get_job_context

            room = get_job_context().room
            participant_identity = next(iter(room.remote_participants))

            # Prepare the message data
            message_data = {
                "contactId": "",  # Not currently used but available for future
                "phoneNumber": phone_number,
                "message": message
            }

            # Send RPC call to the iOS app
            response = await room.local_participant.perform_rpc(
                destination_identity=participant_identity,
                method="sendMessage",
                payload=json.dumps(message_data),
                response_timeout=10.0,
            )

            logger.info(f"Message send response: {response}")
            return f"I've opened the message composer to send '{message}' to {contact_name}. Please review and send."

        except Exception as e:
            logger.error(f"Error sending message: {e}")
            return "I'm sorry, I couldn't send that message. Please try again."


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


async def entrypoint(ctx: JobContext):
    # Logging setup
    # Add any other context you want in all log entries here
    ctx.log_context_fields = {
        "room": ctx.room.name,
    }

    # # Set up a voice AI pipeline using OpenAI, Cartesia, Deepgram, and the LiveKit turn detector
    # session = AgentSession(
    #     # A Large Language Model (LLM) is your agent's brain, processing user input and generating a response
    #     # See all providers at https://docs.livekit.io/agents/integrations/llm/
    #     llm=openai.LLM(model="gpt-4o-mini"),
    #     # Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
    #     # See all providers at https://docs.livekit.io/agents/integrations/stt/
    #     stt=deepgram.STT(model="nova-3", language="multi"),
    #     # Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
    #     # See all providers at https://docs.livekit.io/agents/integrations/tts/
    #     tts=cartesia.TTS(voice="6f84f4b8-58a2-430c-8c79-688dad597532"),
    #     # VAD and turn detection are used to determine when the user is speaking and when the agent should respond
    #     # See more at https://docs.livekit.io/agents/build/turns
    #     turn_detection=MultilingualModel(),
    #     vad=ctx.proc.userdata["vad"],
    #     # allow the LLM to generate a response while waiting for the end of turn
    #     # See more at https://docs.livekit.io/agents/build/audio/#preemptive-generation
    #     preemptive_generation=True,
    # )

    # To use a realtime model instead of a voice pipeline, use the following session setup instead:
    session = AgentSession(
        # See all providers at https://docs.livekit.io/agents/integrations/realtime/
        llm=openai.realtime.RealtimeModel(voice="shimmer", modalities=["text"]),
        tts=cartesia.TTS(voice="1db9bd26-cac5-41dd-bf8d-0988d1f4eb03"),
    )

    # sometimes background noise could interrupt the agent session, these are considered false positive interruptions
    # when it's detected, you may resume the agent's speech
    @session.on("agent_false_interruption")
    def _on_agent_false_interruption(ev: AgentFalseInterruptionEvent):
        logger.info("false positive interruption, resuming")
        session.generate_reply(instructions=ev.extra_instructions or NOT_GIVEN)

    # Metrics collection, to measure pipeline performance
    # For more information, see https://docs.livekit.io/agents/build/metrics/
    usage_collector = metrics.UsageCollector()

    @session.on("metrics_collected")
    def _on_metrics_collected(ev: MetricsCollectedEvent):
        metrics.log_metrics(ev.metrics)
        usage_collector.collect(ev.metrics)

    async def log_usage():
        summary = usage_collector.get_summary()
        logger.info(f"Usage: {summary}")

    ctx.add_shutdown_callback(log_usage)

    # # Add a virtual avatar to the session, if desired
    # # For other providers, see https://docs.livekit.io/agents/integrations/avatar/
    # avatar = hedra.AvatarSession(
    #   avatar_id="...",  # See https://docs.livekit.io/agents/integrations/avatar/hedra
    # )
    # # Start the avatar and wait for it to join
    # await avatar.start(session, room=ctx.room)

    # Start the session, which initializes the voice pipeline and warms up the models
    await session.start(
        agent=Assistant(),
        room=ctx.room,
        room_input_options=RoomInputOptions(
            # LiveKit Cloud enhanced noise cancellation
            # - If self-hosting, omit this parameter
            # - For telephony applications, use `BVCTelephony` for best results
            noise_cancellation=noise_cancellation.BVC(),
        ),
    )

    # Join the room and connect to the user
    await ctx.connect()


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))