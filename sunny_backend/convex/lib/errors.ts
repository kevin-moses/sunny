// lib/errors.ts
// Purpose: Application errors with a stable machine-readable code, replacing the Postgres
// errcodes the SQL functions raised. Clients branch on `data.code`; the message is safe to
// show. Codes: "unauthenticated" (no signed-in user), "forbidden" (was 42501), "not_found"
// (was P0002), "invalid" (was 22023) and "limit" (was 54000). ConfigError marks a permanent
// configuration problem for background work.
//
// Last modified: 2026-10-29

import { ConvexError } from "convex/values";

export type AppErrorCode = "unauthenticated" | "forbidden" | "not_found" | "invalid" | "limit";

/** Payload carried by every application error (a type alias so it is a Convex Value). */
export type AppErrorData = {
  code: AppErrorCode;
  message: string;
};

/**
 * purpose: Build an application error to throw from a query or mutation.
 * @param code: (AppErrorCode) Machine-readable category.
 * @param message: (string) Human-readable explanation.
 * @return: (ConvexError<AppErrorData>) The error to throw.
 */
export function appError(code: AppErrorCode, message: string): ConvexError<AppErrorData> {
  return new ConvexError({ code, message });
}

/**
 * purpose: True when a caught value is an application error with the given code.
 * @param e: (unknown) Caught value.
 * @param code: (AppErrorCode) Code to match.
 * @return: (boolean) Whether e is a ConvexError carrying that code.
 */
export function isAppError(e: unknown, code: AppErrorCode): boolean {
  return e instanceof ConvexError && (e.data as Partial<AppErrorData> | undefined)?.code === code;
}

/**
 * A permanent configuration problem (a missing or malformed environment variable). Retrying
 * cannot fix it, so background work treats it as non-retryable.
 */
export class ConfigError extends Error {
  /**
   * purpose: Build a configuration error.
   * @param message: (string) What is missing or wrong.
   */
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
