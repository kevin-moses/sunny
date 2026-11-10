# list_tools.py
# Purpose: Async helpers behind the household list tools (add_to_list, read_list,
# take_off_list in agent.py): "Add milk and eggs to the list", "What's on my list?", "I bought
# the milk". Every rule (one line, caps, duplicates, which item words mean) lives in the Convex
# functions agent:addListItems, agent:listItems and agent:tickListItem; these only call them and
# phrase the result for voice. The list is one shared list caregivers can see, so items read
# from it (which family may have written) reach the model in quotes, like other household text.
# Items past the tenth in one add are reported (too_many), never dropped silently.
#
# Last modified: 2026-11-09

from convex_client import ConvexClient
from tools import join_names, one_line, quoted

# A list longer than this is read as its count and the first few items.
READ_ALOUD_MAX = 6


async def db_add_to_list(
    client: ConvexClient, household_id: str, items: list[str]
) -> str:
    """
    purpose: Add one or several items to the household list (agent:addListItems).
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param items: (list[str]) The items as said, e.g. ["milk", "eggs"].
    @return: (str) What was added, what was already there, and what did not fit.
    """
    results = (
        await client.mutation(
            "agent:addListItems", {"householdId": household_id, "items": items}
        )
        or []
    )
    by_status: dict[str, list[str]] = {}
    for r in results:
        by_status.setdefault(r.get("status", ""), []).append(one_line(r.get("text")))
    parts = []
    if by_status.get("added"):
        parts.append(f"Added {join_names(by_status['added'])} to the list.")
    if by_status.get("already_on_list"):
        already = by_status["already_on_list"]
        verb = "is" if len(already) == 1 else "are"
        parts.append(f"{join_names(already)} {verb} already on the list.")
    if by_status.get("list_full"):
        parts.append(
            f"The list is full, so {join_names(by_status['list_full'])} could not be added."
        )
    if by_status.get("too_many"):
        parts.append(
            f"Only 10 items can be added at once, so {join_names(by_status['too_many'])} "
            "were not added; offer to add them next."
        )
    return " ".join(parts) or "Nothing was added: no item was named."


async def db_read_list(client: ConvexClient, household_id: str) -> str:
    """
    purpose: The open items of the household list (agent:listItems), briefly: all of a
             short list, or the count and the first few of a long one.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @return: (str) The list for voice.
    """
    items = [
        quoted(i)
        for i in (
            await client.query("agent:listItems", {"householdId": household_id}) or []
        )
    ]
    if not items:
        return "The list is empty."
    if len(items) <= READ_ALOUD_MAX:
        noun = "item" if len(items) == 1 else "items"
        return f"The list has {len(items)} {noun}: {join_names(items)}."
    return (
        f"The list has {len(items)} items. The first {READ_ALOUD_MAX}: "
        f"{join_names(items[:READ_ALOUD_MAX])}."
    )


async def db_take_off_list(client: ConvexClient, household_id: str, item: str) -> str:
    """
    purpose: Tick the item the senior means ("I bought the milk") through agent:tickListItem.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param item: (str) The words naming the item.
    @return: (str) What was taken off, or a clarifying note.
    """
    r = (
        await client.mutation(
            "agent:tickListItem", {"householdId": household_id, "item": item}
        )
        or {}
    )
    status = r.get("status")
    if status == "ticked":
        return f"Took {quoted(r.get('text'))} off the list."
    if status == "ambiguous":
        options = [quoted(o) for o in r.get("options") or []]
        return f"Several items match: {join_names(options)}. Ask which one."
    return f"{one_line(item)} is not on the list."
