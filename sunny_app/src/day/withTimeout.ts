// sunny_app/src/day/withTimeout.ts
//
// Purpose: One helper for "wait for this, but not longer than that", shared by the pending-confirm
// queue (a send that gets no answer) and the Done button (a press that cannot be stored).
//
// Last modified: 2026-11-09

/**
 * purpose: Wait for a promise, but reject if it takes longer than `ms`. The promise itself is
 *          not cancelled: it may still settle later, and the caller decides what that means.
 * @param work: (Promise<T>) The work in progress.
 * @param ms: (number) The longest wait, in milliseconds.
 * @param message: (string) The message of the Error thrown on timeout.
 * @return: (Promise<T>) The work's result.
 * @raises: The work's error, or an Error with `message` on timeout.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
