import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { ChoiceQuestion, NoulQuestion } from "@typesafe-ai/sdk";
import { ConfigError } from "./errors";
import type { JevAnswer, JevAnswers, Usage } from "./mailTypes";

export const JEV_MODEL = "jev-1.14.0";

const JEV_TIMEOUT_MS = 20_000;

export type JevState = {
  email: Record<string, string>;
};

type JevQuestions = Record<string, NoulQuestion | ChoiceQuestion>;

interface JevRequest {
  model: string;
  state: JevState;
  questions: JevQuestions;
}

export interface JevReply {
  answers: JevAnswers;
  usage: Usage;
  model: string;
}

export type AskJev = (request: JevRequest) => Promise<JevReply>;

export class JevAnswerError extends Error {
  override name = "JevAnswerError";
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function compactAnswer(
  name: string,
  question: NoulQuestion | ChoiceQuestion,
  raw: unknown,
): JevAnswer {
  if (typeof raw !== "object" || raw === null || !("type" in raw)) {
    throw new JevAnswerError(`Jev returned no answer for ${name}`);
  }
  if (question.type === "noul") {
    if (raw.type === "noul" && "noul" in raw && isProbability(raw.noul)) return raw.noul;
    throw new JevAnswerError(`Jev returned no Noul probability for ${name}`);
  }
  if (
    raw.type === "choice" &&
    "choice" in raw &&
    typeof raw.choice === "string" &&
    Object.hasOwn(question.criteria, raw.choice) &&
    "probabilities" in raw &&
    typeof raw.probabilities === "object" &&
    raw.probabilities !== null
  ) {
    const choice = raw.choice;
    const probability: unknown = Object.entries(raw.probabilities).find(
      ([label]) => label === choice,
    )?.[1];
    if (isProbability(probability)) return { choice, probability };
  }
  throw new JevAnswerError(`Jev returned no Choice probability for ${name}`);
}

export function compactAnswers(raw: Record<string, unknown>, questions: JevQuestions): JevAnswers {
  return Object.fromEntries(
    Object.entries(questions).map(([name, question]) => [
      name,
      compactAnswer(name, question, raw[name]),
    ]),
  );
}

export const askJev: AskJev = async (request) => {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new ConfigError("Missing env var TYPESAFE_API_KEY");
  const client = new TypeSafeClient({
    apiKey,
    timeout: JEV_TIMEOUT_MS,
    retry: { maxRetries: 1 },
    compression: false,
  });
  const response = await client.systemOne(request);
  const inputTokens = response.usage.input_tokens;
  if (inputTokens === null) throw new JevAnswerError("Jev returned no input token count");
  return {
    answers: compactAnswers(response.answers, request.questions),
    usage: { inputTokens, outputTokens: response.usage.output_tokens ?? 0, cacheReadTokens: 0 },
    model: response.model,
  };
};
