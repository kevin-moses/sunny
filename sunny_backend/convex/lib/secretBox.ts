// lib/secretBox.ts
// STUB: minimal exports matching the part B contract so calendar sync (part C) compiles and
// its tests can mock this module. The lead replaces this file with part B's real encryption
// at merge. This stub does NOT encrypt (it prefixes the text); never deploy it.
//
// Last modified: 2026-10-29

/**
 * purpose: STUB. "Encrypt" a secret.
 * @param plain: (string) Secret.
 * @return: (Promise<string>) Boxed string.
 */
export async function encryptSecret(plain: string): Promise<string> {
  return `stub-box:${plain}`;
}

/**
 * purpose: STUB. "Decrypt" a boxed secret.
 * @param box: (string) Boxed string.
 * @return: (Promise<string>) Secret.
 */
export async function decryptSecret(box: string): Promise<string> {
  return box.replace(/^stub-box:/, "");
}
