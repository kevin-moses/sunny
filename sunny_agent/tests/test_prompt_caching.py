from unittest.mock import MagicMock

from anthropic import AsyncAnthropic
from livekit.agents import AgentSession, mock_tools
from livekit.agents.metrics import LLMMetrics
from test_agent import requires_llm

from agent import Assistant, voice_llm
from config import LLM_MODEL
from prompts import format_user_context, render_system_prompt


def _no_household_assistant() -> Assistant:
    instructions = render_system_prompt(format_user_context(None))
    return Assistant(instructions=instructions, household_id=None, convex=MagicMock())


async def _system_prompt_and_message_tokens(assistant: Assistant, message: str) -> int:
    async with AsyncAnthropic() as client:
        count = await client.messages.count_tokens(
            model=LLM_MODEL,
            system=assistant.instructions,
            messages=[{"role": "user", "content": message}],
        )
    return count.input_tokens


@requires_llm
async def test_second_turn_reads_tools_and_system_prompt_from_cache() -> None:
    assistant = _no_household_assistant()
    second_message = "Thank you"
    llm_requests: list[LLMMetrics] = []
    model = voice_llm()
    model.on("metrics_collected", llm_requests.append)
    async with model, AgentSession(llm=model) as session:
        await session.start(assistant)
        with mock_tools(Assistant, {"web_search": lambda: "No results found."}):
            await session.run(user_input="Hello")
            llm_requests.clear()
            await session.run(user_input=second_message)
    assert llm_requests, "the second turn made no LLM request"
    last_request = llm_requests[-1]
    not_read_from_cache = last_request.prompt_tokens - last_request.prompt_cached_tokens
    tokens_if_system_prompt_were_uncached = await _system_prompt_and_message_tokens(
        assistant, second_message
    )
    assert not_read_from_cache < tokens_if_system_prompt_were_uncached
