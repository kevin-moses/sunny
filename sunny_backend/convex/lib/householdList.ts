// lib/householdList.ts
// Purpose: The household's one shared list (spec "Small errands": "Add milk to the list"
// becomes a senior-created item caregivers can see). The single write path for listItems,
// shared by the voice agent (agent.ts), the caregiver functions (lists.ts) and the senior's
// devices. Every change writes an audit row (list_add, list_done, list_undone, list_remove).
//
// Rules:
// - Item text is one trimmed line of at most MAX_LIST_ITEM_LENGTH (80) characters.
// - At most MAX_OPEN_LIST_ITEMS (50) open items; past that an add reports list_full.
// - Adding text already open on the list (case-insensitive, whitespace collapsed) adds nothing
//   and reports already_on_list; the same text twice in one add counts once.
// - Ticking marks an item done (doneAt, doneByKind, doneBy); ticking a done item changes
//   nothing. Unticking (caregivers) reopens it, subject to the open cap and the duplicate rule.
// - The voice agent finds an item by words: an open item whose text equals them, else the open
//   items whose words include all of the spoken words, or whose words are all among them. Words
//   are whole words (a plural "s" ignored), so "steak" never means "tea" and "eggs" never
//   means "eggplant"; no match or several ask.
// - One voice add carries at most MAX_ITEMS_PER_ADD items; the rest are reported too_many.
//
// Last modified: 2026-11-09

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { actorUserId } from "./access";
import type { Actor } from "./access";
import { audit } from "./audit";
import { appError } from "./errors";
import { oneLine, textKey } from "./text";
import { DAY_MS } from "./time";
import type { ListActorKind } from "./validators";

/** Longest list item, after collapsing whitespace. */
export const MAX_LIST_ITEM_LENGTH = 80;
/** Open items a household list may hold. */
export const MAX_OPEN_LIST_ITEMS = 50;
/** Items one voice add may carry ("milk, eggs and bread"). */
const MAX_ITEMS_PER_ADD = 10;
/** Open items the voice agent's context lists; a longer list gives only the count. */
export const LIST_CONTEXT_MAX = 8;
/** Ticked items caregivers see: those ticked within this long (ms)... */
const RECENT_DONE_MS = 7 * DAY_MS;
/** ...at most this many. */
const MAX_DONE_SHOWN = 50;

/** What happened to one item of an add. */
export interface AddedItem {
  text: string;
  status: "added" | "already_on_list" | "list_full";
  itemId: Id<"listItems"> | null;
}

/** What happened to one item of a voice add: as AddedItem, or too_many (past the items one
 * voice add may carry; not added). */
export interface SpokenItem {
  text: string;
  status: AddedItem["status"] | "too_many";
  itemId: Id<"listItems"> | null;
}

/** A list item as the apps read it (absent values are null). */
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

/** What ticking by spoken words did. */
export interface TickItemResult {
  status: "ticked" | "not_found" | "ambiguous";
  text: string | null;
  options: string[];
}

/** Which open item some words mean. */
type ItemMatch =
  | { status: "found"; item: Doc<"listItems"> }
  | { status: "not_found" | "ambiguous"; options: string[] };

/**
 * purpose: Who an actor is on the list: a caregiver, or the senior (a device or the voice
 *          agent).
 * @param actor: (Actor) The actor.
 * @return: ({kind, userId}) The list actor kind and the user id to record, if any.
 */
function listActor(actor: Actor): { kind: ListActorKind; userId: string | undefined } {
  return { kind: actor.kind === "caregiver" ? "caregiver" : "senior", userId: actorUserId(actor) };
}

/**
 * purpose: Item text as stored: one trimmed line.
 * @param text: (string) Raw text.
 * @return: (string) The text, "" when blank.
 * @raises invalid when longer than MAX_LIST_ITEM_LENGTH.
 */
function cleanItemText(text: string): string {
  const line = oneLine(text);
  if (line.length > MAX_LIST_ITEM_LENGTH) {
    throw appError("invalid", `A list item is ${MAX_LIST_ITEM_LENGTH} characters at most`);
  }
  return line;
}

/**
 * purpose: The household's open items in the order added.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"listItems">[]>) At most MAX_OPEN_LIST_ITEMS rows.
 */
export async function openListItems(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"listItems">[]> {
  return await ctx.db
    .query("listItems")
    .withIndex("by_household_done", (q) => q.eq("householdId", householdId).eq("doneAt", undefined))
    .take(MAX_OPEN_LIST_ITEMS);
}

/**
 * purpose: Items ticked within RECENT_DONE_MS, newest first.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"listItems">[]>) At most MAX_DONE_SHOWN rows.
 */
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

/**
 * purpose: Add items to the list (see the header for the rules); each added item is audited.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) Who adds: a caregiver, a device or the voice agent.
 * @param householdId: (Id<"households">) Household.
 * @param texts: (string[]) The items; blank ones are skipped.
 * @param now: (number) Epoch ms.
 * @return: (Promise<AddedItem[]>) One result per non-blank, distinct item, in order.
 * @raises invalid for an item over MAX_LIST_ITEM_LENGTH characters.
 */
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

/**
 * purpose: Tick an item ("I bought the milk"); an item already done is returned unchanged.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) Who ticks.
 * @param item: (Doc<"listItems">) The item (its household already checked by the caller).
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"listItems">>) The item after the call.
 */
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

/**
 * purpose: Reopen a ticked item; an open item is returned unchanged.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) Who unticks (an editor caregiver; checked by the caller).
 * @param item: (Doc<"listItems">) The item.
 * @return: (Promise<Doc<"listItems">>) The item after the call.
 * @raises limit when the list already has MAX_OPEN_LIST_ITEMS open items; invalid when the
 *         same text is already open.
 */
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

/**
 * purpose: Delete an item, open or done.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) Who removes (an editor caregiver; checked by the caller).
 * @param item: (Doc<"listItems">) The item.
 * @return: (Promise<void>) Resolves when deleted and audited.
 */
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

/**
 * purpose: The whole words of a text for matching: lower case, letters and digits only, a
 *          plural "s" dropped from words longer than three letters.
 * @param text: (string) The text.
 * @return: (Set<string>) The words.
 */
function itemWords(text: string): Set<string> {
  const words = textKey(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)));
}

/**
 * purpose: Whether every word of one set is in another.
 * @param part: (Set<string>) The words that must all be present.
 * @param whole: (Set<string>) The words to look in.
 * @return: (boolean) True when part is non-empty and inside whole.
 */
function allIn(part: Set<string>, whole: Set<string>): boolean {
  return part.size > 0 && [...part].every((w) => whole.has(w));
}

/**
 * purpose: The open item some spoken words mean (see the header).
 * @param open: (Doc<"listItems">[]) The open items.
 * @param words: (string) What the senior said, e.g. "the milk".
 * @return: (ItemMatch) found, or not_found / ambiguous with the candidates' text.
 */
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

/**
 * purpose: Add the items the senior named by voice ("add milk and eggs"): each cut to one line
 *          of MAX_LIST_ITEM_LENGTH (spoken items are never refused for length), at most
 *          MAX_ITEMS_PER_ADD of them; the rest are reported too_many, not dropped silently.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) The voice agent.
 * @param householdId: (Id<"households">) Household.
 * @param items: (string[]) The items as said.
 * @param now: (number) Epoch ms.
 * @return: (Promise<SpokenItem[]>) Per item: added, already_on_list, list_full or too_many.
 */
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

/**
 * purpose: Tick the open item the senior's words mean ("I bought the milk").
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) The voice agent.
 * @param householdId: (Id<"households">) Household.
 * @param words: (string) The words naming the item.
 * @param now: (number) Epoch ms.
 * @return: (Promise<TickItemResult>) ticked with the item's text, or not_found / ambiguous.
 */
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

/**
 * purpose: The apps' view of list items, with caregivers' names.
 * @param rows: (Doc<"listItems">[]) The items.
 * @param names: (Map<string, string>) Caregiver display names by user id.
 * @return: (ListItemView[]) The views, in the same order.
 */
export function listItemViews(
  rows: Doc<"listItems">[],
  names: Map<string, string>,
): ListItemView[] {
  /**
   * purpose: A caregiver's name for a list actor, null for the senior.
   * @param kind: (ListActorKind | undefined) Who.
   * @param userId: (string | undefined) Their user id.
   * @return: (string | null) The caregiver's name, or null.
   */
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
