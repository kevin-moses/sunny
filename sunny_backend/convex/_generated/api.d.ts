/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as calendar from "../calendar.js";
import type * as crons from "../crons.js";
import type * as households from "../households.js";
import type * as instances from "../instances.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_occurrences from "../lib/occurrences.js";
import type * as lib_policies from "../lib/policies.js";
import type * as lib_schedule from "../lib/schedule.js";
import type * as lib_text from "../lib/text.js";
import type * as lib_time from "../lib/time.js";
import type * as lib_today from "../lib/today.js";
import type * as lib_validators from "../lib/validators.js";
import type * as scheduler from "../scheduler.js";
import type * as tasks from "../tasks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  calendar: typeof calendar;
  crons: typeof crons;
  households: typeof households;
  instances: typeof instances;
  "lib/access": typeof lib_access;
  "lib/audit": typeof lib_audit;
  "lib/errors": typeof lib_errors;
  "lib/occurrences": typeof lib_occurrences;
  "lib/policies": typeof lib_policies;
  "lib/schedule": typeof lib_schedule;
  "lib/text": typeof lib_text;
  "lib/time": typeof lib_time;
  "lib/today": typeof lib_today;
  "lib/validators": typeof lib_validators;
  scheduler: typeof scheduler;
  tasks: typeof tasks;
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

export declare const components: {};
