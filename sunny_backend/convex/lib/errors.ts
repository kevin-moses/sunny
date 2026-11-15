import { ConvexError } from "convex/values";

export type AppErrorCode = "unauthenticated" | "forbidden" | "not_found" | "invalid" | "limit";

export type AppErrorData = {
  code: AppErrorCode;
  message: string;
};

export function appError(code: AppErrorCode, message: string): ConvexError<AppErrorData> {
  return new ConvexError({ code, message });
}

export function isAppError(e: unknown, code: AppErrorCode): boolean {
  return e instanceof ConvexError && (e.data as Partial<AppErrorData> | undefined)?.code === code;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
