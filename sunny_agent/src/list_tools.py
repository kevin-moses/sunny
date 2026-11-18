from convex_client import ConvexMutation, ConvexQuery, mutation_as, query_as
from convex_types import OPEN_LIST_ITEMS, SPOKEN_LIST_ITEMS, TICK_LIST_ITEM_RESULT
from tools import join_names, one_line, quoted

READ_ALOUD_MAX = 6


async def db_add_to_list(
    client: ConvexMutation, household_id: str, items: list[str]
) -> str:
    results = await mutation_as(
        client,
        "agent:addListItems",
        {"householdId": household_id, "items": items},
        SPOKEN_LIST_ITEMS,
    )
    by_status: dict[str, list[str]] = {}
    for r in results:
        by_status.setdefault(r["status"], []).append(one_line(r["text"]))
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


async def db_read_list(client: ConvexQuery, household_id: str) -> str:
    open_items = await query_as(
        client, "agent:listItems", {"householdId": household_id}, OPEN_LIST_ITEMS
    )
    items = [quoted(i) for i in open_items]
    if not items:
        return "The list is empty."
    if len(items) <= READ_ALOUD_MAX:
        noun = "item" if len(items) == 1 else "items"
        return f"The list has {len(items)} {noun}: {join_names(items)}."
    return (
        f"The list has {len(items)} items. The first {READ_ALOUD_MAX}: "
        f"{join_names(items[:READ_ALOUD_MAX])}."
    )


async def db_take_off_list(client: ConvexMutation, household_id: str, item: str) -> str:
    r = await mutation_as(
        client,
        "agent:tickListItem",
        {"householdId": household_id, "item": item},
        TICK_LIST_ITEM_RESULT,
    )
    status = r["status"]
    if status == "ticked":
        return f"Took {quoted(r['text'])} off the list."
    if status == "ambiguous":
        options = [quoted(o) for o in r["options"]]
        return f"Several items match: {join_names(options)}. Ask which one."
    return f"{one_line(item)} is not on the list."
