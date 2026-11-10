// convex/lists.ts
// Purpose: The household list for the apps (the voice agent's functions are in agent.ts; both
// write through lib/householdList.ts, which audits every change). Access (lib/access.ts):
// - get: any caregiver of the household sees the open items and those ticked in the last 7
//   days; the household's paired devices see the open items only.
// - add, untick, remove: editor caregivers (primary, member).
// - tick: editor caregivers, and the household's paired devices (so a display or phone can
//   show the list and tick an item); viewers cannot.
// Functions taking an item id load the item first and check access against the item's own
// household, so an id from another household is forbidden.
//
// Last modified: 2026-11-09

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { EDITOR_ROLES, memberNames, requireEditor, requireReader } from "./lib/access";
import type { CaregiverActor, DeviceActor } from "./lib/access";
import { appError } from "./lib/errors";
import {
  addListItemsCore,
  listItemViews,
  openListItems,
  recentlyDoneItems,
  removeListItemCore,
  tickListItemCore,
  untickListItemCore,
} from "./lib/householdList";
import type { ListItemView } from "./lib/householdList";

/** The list as the apps read it. */
export interface ListView {
  open: ListItemView[];
  /** Ticked in the last 7 days, newest first; always empty for a device. */
  done: ListItemView[];
}

/**
 * purpose: Load a list item.
 * @param ctx: (QueryCtx) Context.
 * @param itemId: (Id<"listItems">) The item.
 * @return: (Promise<Doc<"listItems">>) The row.
 * @raises not_found when it does not exist.
 */
async function loadItem(ctx: QueryCtx, itemId: Id<"listItems">): Promise<Doc<"listItems">> {
  const item = await ctx.db.get(itemId);
  if (!item) throw appError("not_found", "List item not found");
  return item;
}

/**
 * purpose: The household's list. Caregivers of any role; devices see open items only.
 * @param householdId: (Id<"households">) Household.
 * @return: (ListView) Open items in the order added, and recently ticked ones.
 */
export const get = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<ListView> => {
    const actor = await requireReader(ctx, args.householdId);
    const names = await memberNames(ctx, args.householdId);
    const open = listItemViews(await openListItems(ctx, args.householdId), names);
    if (actor.kind === "senior_device") return { open, done: [] };
    const done = await recentlyDoneItems(ctx, args.householdId, Date.now());
    return { open, done: listItemViews(done, names) };
  },
});

/**
 * purpose: Add one item. Editor caregivers only.
 * @param householdId: (Id<"households">) Household.
 * @param text: (string) The item; one line of at most 80 characters.
 * @return: ({status, itemId}) added, or already_on_list with the open item's id.
 * @raises invalid for blank or over-long text; limit when the list has 50 open items.
 */
export const add = mutation({
  args: { householdId: v.id("households"), text: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: "added" | "already_on_list"; itemId: Id<"listItems"> }> => {
    const actor = await requireEditor(ctx, args.householdId);
    const [result] = await addListItemsCore(ctx, actor, args.householdId, [args.text], Date.now());
    if (!result) throw appError("invalid", "A list item cannot be blank");
    if (result.status === "list_full") throw appError("limit", "The list is full");
    return { status: result.status, itemId: result.itemId! };
  },
});

/**
 * purpose: Tick an item. Editor caregivers and the household's paired devices.
 * @param itemId: (Id<"listItems">) The item.
 * @return: (ListItemView) The item after the call (unchanged when already ticked).
 * @raises forbidden for viewers and anyone outside the item's household.
 */
export const tick = mutation({
  args: { itemId: v.id("listItems") },
  handler: async (ctx, args): Promise<ListItemView> => {
    const item = await loadItem(ctx, args.itemId);
    const actor: CaregiverActor | DeviceActor = await requireReader(ctx, item.householdId);
    if (actor.kind === "caregiver" && !EDITOR_ROLES.includes(actor.role)) {
      throw appError("forbidden", "Not allowed");
    }
    const after = await tickListItemCore(ctx, actor, item, Date.now());
    return listItemViews([after], await memberNames(ctx, item.householdId))[0]!;
  },
});

/**
 * purpose: Reopen a ticked item. Editor caregivers only.
 * @param itemId: (Id<"listItems">) The item.
 * @return: (ListItemView) The item after the call.
 * @raises forbidden for anyone else; limit or invalid when it cannot go back on the list.
 */
export const untick = mutation({
  args: { itemId: v.id("listItems") },
  handler: async (ctx, args): Promise<ListItemView> => {
    const item = await loadItem(ctx, args.itemId);
    const actor = await requireEditor(ctx, item.householdId);
    const after = await untickListItemCore(ctx, actor, item);
    return listItemViews([after], await memberNames(ctx, item.householdId))[0]!;
  },
});

/**
 * purpose: Delete an item. Editor caregivers only.
 * @param itemId: (Id<"listItems">) The item.
 * @return: (null)
 * @raises forbidden for anyone else.
 */
export const remove = mutation({
  args: { itemId: v.id("listItems") },
  handler: async (ctx, args): Promise<null> => {
    const item = await loadItem(ctx, args.itemId);
    const actor = await requireEditor(ctx, item.householdId);
    await removeListItemCore(ctx, actor, item);
    return null;
  },
});
