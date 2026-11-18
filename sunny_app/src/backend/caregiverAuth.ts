import { OFFLINE_ERROR_MESSAGE } from './api';

export const EMAIL_CODE_LENGTH = 6;

const IDENTIFIER_NOT_FOUND_CODE = 'form_identifier_not_found';
const NETWORK_ERROR_CODE = 'network_error';

export const SIGN_IN_FALLBACK_MESSAGE = 'Could not sign in. Please try again.';
export const SIGN_IN_INCOMPLETE_MESSAGE =
  'Could not finish signing in. Please try again, or use a different email.';

interface ClerkErrorEntry {
  code?: unknown;
  message?: unknown;
  longMessage?: unknown;
}

export function normalizeEmail(email: string): string {
  return email.trim();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

export function cleanCode(code: string): string {
  return code.replace(/\D/g, '').slice(0, EMAIL_CODE_LENGTH);
}

export function isCompleteCode(code: string): boolean {
  return cleanCode(code).length === EMAIL_CODE_LENGTH;
}

function clerkEntries(error: unknown): ClerkErrorEntry[] {
  const entries = (error as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(entries)) return [];
  return entries.filter((e): e is ClerkErrorEntry => typeof e === 'object' && e !== null);
}

export function clerkErrorCode(error: unknown): string | null {
  const first = clerkEntries(error)[0];
  const code = first !== undefined ? first.code : (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : null;
}

export function shouldFallBackToSignUp(error: unknown): boolean {
  return clerkErrorCode(error) === IDENTIFIER_NOT_FOUND_CODE;
}

export function findEmailCodeFactorId(
  factors: readonly { strategy: string; emailAddressId?: string }[] | null,
): string | null {
  const factor = factors?.find((f) => f.strategy === 'email_code');
  return factor?.emailAddressId ?? null;
}

export function signInErrorMessage(error: unknown): string {
  if (clerkErrorCode(error) === NETWORK_ERROR_CODE) return OFFLINE_ERROR_MESSAGE;
  const first = clerkEntries(error)[0];
  for (const text of [first?.longMessage, first?.message]) {
    if (typeof text === 'string' && text.trim() !== '') return text.trim();
  }
  return SIGN_IN_FALLBACK_MESSAGE;
}
