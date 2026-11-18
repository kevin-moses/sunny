import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { actorUserId } from "./access";
import type { Actor } from "./access";
import { audit } from "./audit";
import { appError } from "./errors";
import { oneLine, textKey } from "./text";
import { DAY_MS } from "./time";
import type { ListActorKind } from "./validators";

export const MAX_LIST_ITEM_LENGTH = 80;
export const MAX_OPEN_LIST_ITEMS = 50;
const MAX_ITEMS_PER_ADD = 10;
export const LIST_CONTEXT_MAX = 8;
const RECENT_DONE_MS = 7 * DAY_MS;
const MAX_DONE_SHOWN = 50;

export interface AddedItem {
  text: string;
  status: "added" | "already_on_list" | "list_full";
  itemId: Id<"listItems"> | null;
}

export interface SpokenItem {
  text: string;
  status: AddedItem["status"] | "too_many";
  itemId: Id<"listItems"> | null;
}

export interface ListItemView {
  id: Id<"listItems">;
  text: string;
  addedByKind: ListActorKind;
  addedByName: string | null;
  addedAt: number;
  doneAt: number | null;
  doneByKind: ListActorKind | null;
  doneByName: string | null;
}

export interface TickItemResult {
  status: "ticked" | "not_found" | "ambiguous";
  text: string | null;
  options: string[];
}

type ItemMatch =
  | { status: "found"; item: Doc<"listItems"> }
  | { status: "not_found" | "ambiguous"; options: string[] };

function listActor(actor: Actor): { kind: ListActorKind; userId: string | undefined } {
  return { kind: actor.kind === "caregiver" ? "caregiver" : "senior", userId: actorUserId(actor) };
}

function cleanItemText(text: string): string {
  const line = oneLine(text);
  if (line.length > MAX_LIST_ITEM_LENGTH) {
    throw appError("invalid", `A list item is ${MAX_LIST_ITEM_LENGTH} characters at most`);
  }
  return line;
}

export async function openListItems(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"listItems">[]> {
  return await ctx.db
    .query("listItems")
    .withIndex("by_household_done", (q) => q.eq("householdId", householdId).eq("doneAt", undefined))
    .take(MAX_OPEN_LIST_ITEMS);
}

export async function recentlyDoneItems(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<Doc<"listItems">[]> {
  return await ctx.db
    .query("listItems")
    .withIndex("by_household_done", (q) =>
      q.eq("householdId", householdId).gt("doneAt", now - RECENT_DONE_MS),
    )
    .order("desc")
    .take(MAX_DONE_SHOWN);
}

export async function addListItemsCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  texts: string[],
  now: number,
): Promise<AddedItem[]> {
  const who = listActor(actor);
  const open = await openListItems(ctx, householdId);
  const onList = new Map(open.map((item) => [textKey(item.text), item._id]));
  let openCount = open.length;
  const seen = new Set<string>();
  const results: AddedItem[] = [];
  for (const raw of texts) {
    const text = cleanItemText(raw);
    const key = textKey(text);
    if (text === "" || seen.has(key)) continue;
    seen.add(key);
    const existing = onList.get(key);
    if (existing !== undefined) {
      results.push({ text, status: "already_on_list", itemId: existing });
      continue;
    }
    if (openCount >= MAX_OPEN_LIST_ITEMS) {
      results.push({ text, status: "list_full", itemId: null });
      continue;
    }
    const itemId = await ctx.db.insert("listItems", {
      householdId,
      text,
      addedByKind: who.kind,
      addedBy: who.userId,
      addedAt: now,
    });
    openCount += 1;
    await audit(ctx, {
      householdId,
      actor,
      action: "list_add",
      entity: "listItem",
      entityId: itemId,
      detail: { text },
    });
    results.push({ text, status: "added", itemId });
  }
  return results;
}

export async function tickListItemCore(
  ctx: MutationCtx,
  actor: Actor,
  item: Doc<"listItems">,
  now: number,
): Promise<Doc<"listItems">> {
  if (item.doneAt !== undefined) return item;
  const who = listActor(actor);
  await ctx.db.patch(item._id, { doneAt: now, doneByKind: who.kind, doneBy: who.userId });
  await audit(ctx, {
    householdId: item.householdId,
    actor,
    action: "list_done",
    entity: "listItem",
    entityId: item._id,
    detail: { text: item.text },
  });
  return (await ctx.db.get(item._id))!;
}

export async function untickListItemCore(
  ctx: MutationCtx,
  actor: Actor,
  item: Doc<"listItems">,
): Promise<Doc<"listItems">> {
  if (item.doneAt === undefined) return item;
  const open = await openListItems(ctx, item.householdId);
  if (open.length >= MAX_OPEN_LIST_ITEMS) throw appError("limit", "The list is full");
  if (open.some((o) => textKey(o.text) === textKey(item.text))) {
    throw appError("invalid", "That item is already on the list");
  }
  await ctx.db.patch(item._id, { doneAt: undefined, doneByKind: undefined, doneBy: undefined });
  await audit(ctx, {
    householdId: item.householdId,
    actor,
    action: "list_undone",
    entity: "listItem",
    entityId: item._id,
    detail: { text: item.text },
  });
  return (await ctx.db.get(item._id))!;
}

export async function removeListItemCore(
  ctx: MutationCtx,
  actor: Actor,
  item: Doc<"listItems">,
): Promise<void> {
  await ctx.db.delete(item._id);
  await audit(ctx, {
    householdId: item.householdId,
    actor,
    action: "list_remove",
    entity: "listItem",
    entityId: item._id,
    detail: { text: item.text },
  });
}

function itemWords(text: string): Set<string> {
  const words = textKey(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)));
}

function allIn(part: Set<string>, whole: Set<string>): boolean {
  return part.size > 0 && [...part].every((w) => whole.has(w));
}

function matchOpenItem(open: Doc<"listItems">[], words: string): ItemMatch {
  const key = textKey(words).replace(/^(the|my|some)\s+/, "");
  if (key === "") return { status: "not_found", options: [] };
  const exact = open.filter((i) => textKey(i.text) === key);
  const said = itemWords(key);
  const matches =
    exact.length > 0
      ? exact
      : open.filter((i) => {
          const item = itemWords(i.text);
          return allIn(said, item) || allIn(item, said);
        });
  if (matches.length === 1) return { status: "found", item: matches[0]! };
  if (matches.length === 0) return { status: "not_found", options: [] };
  return { status: "ambiguous", options: matches.map((i) => i.text) };
}

export async function addSpokenItemsCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  items: string[],
  now: number,
): Promise<SpokenItem[]> {
  const texts = items.map((t) => oneLine(t).slice(0, MAX_LIST_ITEM_LENGTH).trim());
  const added = await addListItemsCore(
    ctx,
    actor,
    householdId,
    texts.slice(0, MAX_ITEMS_PER_ADD),
    now,
  );
  const tooMany: SpokenItem[] = texts
    .slice(MAX_ITEMS_PER_ADD)
    .filter((text) => text !== "")
    .map((text) => ({ text, status: "too_many", itemId: null }));
  return [...added, ...tooMany];
}

export async function tickItemByWordsCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  words: string,
  now: number,
): Promise<TickItemResult> {
  const match = matchOpenItem(await openListItems(ctx, householdId), words);
  if (match.status !== "found") return { status: match.status, text: null, options: match.options };
  await tickListItemCore(ctx, actor, match.item, now);
  return { status: "ticked", text: match.item.text, options: [] };
}

export function listItemViews(
  rows: Doc<"listItems">[],
  names: Map<string, string>,
): ListItemView[] {
  const nameOf = (kind: ListActorKind | undefined, userId: string | undefined): string | null =>
    kind === "caregiver" && userId !== undefined ? (names.get(userId) ?? null) : null;
  return rows.map((r) => ({
    id: r._id,
    text: r.text,
    addedByKind: r.addedByKind,
    addedByName: nameOf(r.addedByKind, r.addedBy),
    addedAt: r.addedAt,
    doneAt: r.doneAt ?? null,
    doneByKind: r.doneByKind ?? null,
    doneByName: nameOf(r.doneByKind, r.doneBy),
  }));
}
