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

export interface ListView {
  open: ListItemView[];
  done: ListItemView[];
}

async function loadItem(ctx: QueryCtx, itemId: Id<"listItems">): Promise<Doc<"listItems">> {
  const item = await ctx.db.get(itemId);
  if (!item) throw appError("not_found", "List item not found");
  return item;
}

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

export const untick = mutation({
  args: { itemId: v.id("listItems") },
  handler: async (ctx, args): Promise<ListItemView> => {
    const item = await loadItem(ctx, args.itemId);
    const actor = await requireEditor(ctx, item.householdId);
    const after = await untickListItemCore(ctx, actor, item);
    return listItemViews([after], await memberNames(ctx, item.householdId))[0]!;
  },
});

export const remove = mutation({
  args: { itemId: v.id("listItems") },
  handler: async (ctx, args): Promise<null> => {
    const item = await loadItem(ctx, args.itemId);
    const actor = await requireEditor(ctx, item.householdId);
    await removeListItemCore(ctx, actor, item);
    return null;
  },
});
