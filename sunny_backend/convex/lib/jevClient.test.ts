import { APIError } from "@typesafe-ai/sdk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jevAnswers, jevCalls, jevSays } from "../mailMocks.helpers";
import { JEV_MODEL, JevAnswerError, askJev, compactAnswers } from "./jevClient";
import { triageEmail } from "./mailJudge";
import { CLOCK, EYE_EXAM, QUESTIONS, email } from "./mailFixtures.helpers";

describe("compacting Jev's answers", () => {
  test.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01])(
    "a Noul of %d is an error, not an answer",
    (noul) => {
      const raw = { ...jevAnswers(EYE_EXAM, QUESTIONS), bulk_mail: { type: "noul", noul } };
      expect(() => compactAnswers(raw, QUESTIONS)).toThrow(JevAnswerError);
    },
  );

  test.each([Number.NaN, -0.5, 2])("a chosen option with probability %d is an error", (p) => {
    const raw = {
      ...jevAnswers(EYE_EXAM, QUESTIONS),
      when_day: { type: "choice", choice: "10", confidence: 1, probabilities: { "10": p } },
    };
    expect(() => compactAnswers(raw, QUESTIONS)).toThrow(JevAnswerError);
  });

  test("a missing answer is an error, not a no", () => {
    const { addresses_assistant: _, ...rest } = jevAnswers(EYE_EXAM, QUESTIONS);
    expect(() => compactAnswers(rest, QUESTIONS)).toThrow(/addresses_assistant/);
  });

  test("a pick outside the question's options is an error", () => {
    const raw = {
      ...jevAnswers(EYE_EXAM, QUESTIONS),
      when_month: { type: "choice", choice: "Smarch", confidence: 1, probabilities: { Smarch: 1 } },
    };
    expect(() => compactAnswers(raw, QUESTIONS)).toThrow(/when_month/);
  });
});

describe("askJev through triage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    jevCalls.length = 0;
  });

  test("returns a verdict built by Sunny with the rule and the answers that decided it", async () => {
    jevSays(EYE_EXAM);
    const triaged = await triageEmail(email(), CLOCK, null, askJev);
    expect(triaged).toMatchObject({
      rule: "confirmed-appointment",
      summary: "The email confirms an appointment.",
      classifier: {
        name: JEV_MODEL,
        usage: { inputTokens: 4200, outputTokens: 310, cacheReadTokens: 0 },
      },
      verdict: {
        kind: "appointment",
        change: "new",
        appointment: {
          kind: "eye_doctor",
          date: "2026-12-10",
          time: "14:15",
          durationMinutes: null,
        },
      },
    });
    expect(triaged.answers).toMatchObject({
      confirms_appointment: 0.95,
      appointment_kind: { choice: "eye_doctor", probability: 0.95 },
    });
    expect(jevCalls).toHaveLength(1);
  });

  test("mail the gate settles never reaches Jev", async () => {
    jevSays(EYE_EXAM);
    const triaged = await triageEmail(email({ labels: ["SPAM"] }), CLOCK, null, askJev);
    expect(triaged).toMatchObject({ rule: "gate:label:SPAM", answers: null });
    expect(jevCalls).toHaveLength(0);
  });

  test("a refused API call rejects with the API's status instead of answering", async () => {
    jevSays({ status: 401 });
    await expect(triageEmail(email(), CLOCK, null, askJev)).rejects.toBeInstanceOf(APIError);
  });

  test("a response missing an answer rejects", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const { confirms_appointment: _, ...partial } = jevAnswers(EYE_EXAM, QUESTIONS);
        return new Response(
          JSON.stringify({ model: JEV_MODEL, answers: partial, usage: { input_tokens: 1 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    await expect(triageEmail(email(), CLOCK, null, askJev)).rejects.toThrow(/confirms_appointment/);
  });
});
