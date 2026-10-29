// testing.helpers.ts
// Purpose: Shared helpers for the backend tests (agentRequests, agentRuntime, agentTools):
// the convex-test harness with every backend module and the workflow component registered,
// creating a household through the real households.create, and inserting agent request rows.
// The name has two dots, so Convex does not treat this file as a function module.
//
// Last modified: 2026-10-29

import workflowTest from "@convex-dev/workflow/test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import type { AgentRequestStatus } from "./lib/validators";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./**/*.helpers.ts"]);

/**
 * purpose: A fresh in-memory backend with the workflow component registered.
 * @return: The convex-test harness typed with the schema.
 */
export function makeBackend() {
  const t = convexTest(schema, modules);
  workflowTest.register(t);
  return t;
}

/** The convex-test harness type, with the schema's table types. */
export type TestConvex = ReturnType<typeof makeBackend>;

/**
 * purpose: Create a household through the real households.create.
 * @param t: (TestConvex) Harness.
 * @param options: ({ subject, seniorName, caregiverName, timezone }) Who creates it and its
 *        details; defaults to user_a, Margaret, Anna and America/New_York.
 * @return: (Promise<Id<"households">>) The household.
 */
export async function createHousehold(
  t: TestConvex,
  options: {
    subject?: string;
    seniorName?: string;
    caregiverName?: string;
    timezone?: string;
  } = {},
): Promise<Id<"households">> {
  return await t
    .withIdentity({ subject: options.subject ?? "user_a" })
    .mutation(api.households.create, {
      seniorPreferredName: options.seniorName ?? "Margaret",
      timezone: options.timezone ?? "America/New_York",
      caregiverDisplayName: options.caregiverName ?? "Anna",
    });
}

/**
 * purpose: Insert an agent request row directly.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param fields: (object) Overrides for status, sessionId, reply, error and finishedAt.
 * @return: (Promise<Id<"agentRequests">>) The request.
 */
export async function insertRequest(
  t: TestConvex,
  householdId: Id<"households">,
  fields: Partial<{
    status: AgentRequestStatus;
    sessionId: string;
    reply: string;
    error: string;
    finishedAt: number;
  }> = {},
): Promise<Id<"agentRequests">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("agentRequests", {
      householdId,
      requestedBy: "user_a",
      message: "hello",
      status: "queued",
      ...fields,
    });
  });
}
