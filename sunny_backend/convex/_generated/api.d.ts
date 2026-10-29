/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as agentRequests from "../agentRequests.js";
import type * as agentRuntime from "../agentRuntime.js";
import type * as calendar from "../calendar.js";
import type * as calendarPush from "../calendarPush.js";
import type * as crons from "../crons.js";
import type * as googleCalendar from "../googleCalendar.js";
import type * as households from "../households.js";
import type * as http from "../http.js";
import type * as instances from "../instances.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_agentBriefing from "../lib/agentBriefing.js";
import type * as lib_agentConfig from "../lib/agentConfig.js";
import type * as lib_agentRequestState from "../lib/agentRequestState.js";
import type * as lib_agentTools from "../lib/agentTools.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_calendarSync from "../lib/calendarSync.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_eventNotices from "../lib/eventNotices.js";
import type * as lib_google from "../lib/google.js";
import type * as lib_googleEvent from "../lib/googleEvent.js";
import type * as lib_managedAgents from "../lib/managedAgents.js";
import type * as lib_occurrences from "../lib/occurrences.js";
import type * as lib_policies from "../lib/policies.js";
import type * as lib_schedule from "../lib/schedule.js";
import type * as lib_secretBox from "../lib/secretBox.js";
import type * as lib_text from "../lib/text.js";
import type * as lib_time from "../lib/time.js";
import type * as lib_today from "../lib/today.js";
import type * as lib_validators from "../lib/validators.js";
import type * as pairing from "../pairing.js";
import type * as scheduler from "../scheduler.js";
import type * as tasks from "../tasks.js";
import type * as voice from "../voice.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  agentRequests: typeof agentRequests;
  agentRuntime: typeof agentRuntime;
  calendar: typeof calendar;
  calendarPush: typeof calendarPush;
  crons: typeof crons;
  googleCalendar: typeof googleCalendar;
  households: typeof households;
  http: typeof http;
  instances: typeof instances;
  "lib/access": typeof lib_access;
  "lib/agentBriefing": typeof lib_agentBriefing;
  "lib/agentConfig": typeof lib_agentConfig;
  "lib/agentRequestState": typeof lib_agentRequestState;
  "lib/agentTools": typeof lib_agentTools;
  "lib/audit": typeof lib_audit;
  "lib/calendarSync": typeof lib_calendarSync;
  "lib/errors": typeof lib_errors;
  "lib/eventNotices": typeof lib_eventNotices;
  "lib/google": typeof lib_google;
  "lib/googleEvent": typeof lib_googleEvent;
  "lib/managedAgents": typeof lib_managedAgents;
  "lib/occurrences": typeof lib_occurrences;
  "lib/policies": typeof lib_policies;
  "lib/schedule": typeof lib_schedule;
  "lib/secretBox": typeof lib_secretBox;
  "lib/text": typeof lib_text;
  "lib/time": typeof lib_time;
  "lib/today": typeof lib_today;
  "lib/validators": typeof lib_validators;
  pairing: typeof pairing;
  scheduler: typeof scheduler;
  tasks: typeof tasks;
  voice: typeof voice;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
  calendarSyncPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"calendarSyncPool">;
};
