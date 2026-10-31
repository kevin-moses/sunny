// sunny_app/src/backend/caregiverAuth.ts
//
// Purpose: The pure parts of the caregiver email-code sign-in (CaregiverSignInScreen): email and
// code validation, reading the error code out of a Clerk error, deciding whether a failed
// sign-in means "no such account yet" (so the screen falls back to sign-up), and turning any
// thrown value into a short message that is safe to show, and picking the email-code first
// factor out of the ones a sign-in supports. Clerk API errors are recognized by
// shape (an `errors` array whose entries carry `code` and `message`/`longMessage`), so this
// module needs no Clerk import and can be tested without mocks.
//
// Last modified: 2026-10-30

/** Length of the email verification code Clerk sends. */
export const EMAIL_CODE_LENGTH = 6;

/** Clerk's error code for a sign-in identifier (email) that has no account. */
const IDENTIFIER_NOT_FOUND_CODE = 'form_identifier_not_found';
/** Clerk's runtime error code when a request never reached Clerk. */
const NETWORK_ERROR_CODE = 'network_error';

/** Shown when nothing safe and specific can be said about a failure. */
export const SIGN_IN_FALLBACK_MESSAGE = 'Could not sign in. Please try again.';
/** Shown when the request never reached Clerk. */
export const SIGN_IN_OFFLINE_MESSAGE = 'Could not reach Sunny. Check the internet connection.';
/** Shown when the sign-in or sign-up ends in a state this screen cannot continue from. */
export const SIGN_IN_INCOMPLETE_MESSAGE =
  'Could not finish signing in. Please try again, or use a different email.';

/** The fields of one Clerk API error that this module reads. */
interface ClerkErrorEntry {
  code?: unknown;
  message?: unknown;
  longMessage?: unknown;
}

/**
 * purpose: Trim an email the user typed.
 * @param email: (string) The raw text.
 * @return: (string) The email without surrounding whitespace.
 */
export function normalizeEmail(email: string): string {
  return email.trim();
}

/**
 * purpose: Check that text looks like an email address (one @, a dot in the domain, no spaces).
 *          Clerk makes the final decision; this only keeps obvious typos from being sent.
 * @param email: (string) The raw text.
 * @return: (boolean) True when the trimmed text looks like an email address.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

/**
 * purpose: Keep only the digits of a typed code.
 * @param code: (string) The raw text.
 * @return: (string) The digits, at most EMAIL_CODE_LENGTH of them.
 */
export function cleanCode(code: string): string {
  return code.replace(/\D/g, '').slice(0, EMAIL_CODE_LENGTH);
}

/**
 * purpose: Check that a typed code is complete.
 * @param code: (string) The raw text.
 * @return: (boolean) True when it holds exactly EMAIL_CODE_LENGTH digits.
 */
export function isCompleteCode(code: string): boolean {
  return cleanCode(code).length === EMAIL_CODE_LENGTH;
}

/**
 * purpose: Read the entries of a Clerk API error.
 * @param error: (unknown) The thrown value.
 * @return: (ClerkErrorEntry[]) The entries of its `errors` array; empty for anything else.
 */
function clerkEntries(error: unknown): ClerkErrorEntry[] {
  const entries = (error as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(entries)) return [];
  return entries.filter((e): e is ClerkErrorEntry => typeof e === 'object' && e !== null);
}

/**
 * purpose: Read the code of the first Clerk error in a thrown value.
 * @param error: (unknown) The thrown value.
 * @return: (string | null) The code of the first entry of a Clerk API error, the code of a
 *          Clerk runtime error (such as network_error), or null when there is none.
 */
export function clerkErrorCode(error: unknown): string | null {
  const first = clerkEntries(error)[0];
  const code = first !== undefined ? first.code : (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : null;
}

/**
 * purpose: Decide whether a failed sign-in attempt means the email has no account yet, so the
 *          screen should fall back to creating one.
 * @param error: (unknown) The error thrown by the sign-in attempt.
 * @return: (boolean) True only for Clerk's "identifier not found" error.
 */
export function shouldFallBackToSignUp(error: unknown): boolean {
  return clerkErrorCode(error) === IDENTIFIER_NOT_FOUND_CODE;
}

/**
 * purpose: Find the email address id of the email_code first factor of a sign-in attempt, which
 *          prepareFirstFactor needs to send the code.
 * @param factors: (readonly { strategy: string; emailAddressId?: string }[] | null) The
 *        sign-in's supportedFirstFactors.
 * @return: (string | null) The email address id, or null when email code is not supported.
 */
export function findEmailCodeFactorId(
  factors: readonly { strategy: string; emailAddressId?: string }[] | null,
): string | null {
  const factor = factors?.find((f) => f.strategy === 'email_code');
  return factor?.emailAddressId ?? null;
}

/**
 * purpose: Turn a thrown value into a message that is safe to show under the form.
 * @param error: (unknown) The thrown value.
 * @return: (string) The long message (or message) of a Clerk API error's first entry; the
 *          offline message for a Clerk network error; otherwise a calm generic message.
 */
export function signInErrorMessage(error: unknown): string {
  if (clerkErrorCode(error) === NETWORK_ERROR_CODE) return SIGN_IN_OFFLINE_MESSAGE;
  const first = clerkEntries(error)[0];
  for (const text of [first?.longMessage, first?.message]) {
    if (typeof text === 'string' && text.trim() !== '') return text.trim();
  }
  return SIGN_IN_FALLBACK_MESSAGE;
}
