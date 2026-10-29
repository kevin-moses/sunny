// lib/digestModel.ts
// Purpose: The one network call of the daily digest: ask Claude Haiku to write the digest from
// the rendered facts under the strict prompt in digestText.ts. Constructs the Anthropic client
// with a short timeout (DIGEST_TIMEOUT_MS) and a single SDK retry. It returns the raw reply;
// validation and the template fallback are the caller's (digest.ts), which treats any thrown
// error the same way. Tests replace this module wholesale. Env: ANTHROPIC_API_KEY.
//
// Last modified: 2026-10-29

import Anthropic from "@anthropic-ai/sdk";
import { DIGEST_SYSTEM_PROMPT } from "./digestText";

/** The model that writes the digest. */
export const DIGEST_MODEL = "claude-haiku-5-5";

/** Per-attempt timeout of the request. */
const DIGEST_TIMEOUT_MS = 20_000;

/** Output budget; 5 short lines need far less. */
const MAX_OUTPUT_TOKENS = 300;

/**
 * purpose: Ask the model for the digest text.
 * @param factsMessage: (string) The facts rendered by factsForPrompt.
 * @param apiKey: (string | undefined) Defaults to ANTHROPIC_API_KEY.
 * @return: (Promise<string>) The model's text reply.
 * @raises Error when no key is set, the request fails, or the reply has no text.
 */
export async function composeWithClaude(
  factsMessage: string,
  apiKey: string | undefined = process.env.ANTHROPIC_API_KEY,
): Promise<string> {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey, timeout: DIGEST_TIMEOUT_MS, maxRetries: 1 });
  const response = await client.messages.create({
    model: DIGEST_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: DIGEST_SYSTEM_PROMPT,
    messages: [{ role: "user", content: factsMessage }],
  });
  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  if (text === "") throw new Error("The model returned no text");
  return text;
}
