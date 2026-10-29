// sunny_app/src/errors.ts
//
// Purpose: One place to turn any thrown value into a message that is safe to show or log,
// so catch blocks do not repeat `error instanceof Error ? error.message : ...`.
//
// Last modified: 2026-10-28

/**
 * purpose: Describe a thrown value as a message.
 * @param error: (unknown) The thrown value.
 * @param fallback: (string) Used when the value carries no message.
 * @return: (string) The Error's message, or the value itself when it is a non-empty string,
 *          otherwise the fallback.
 */
export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}
