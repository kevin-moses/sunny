import { expect } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { FLOW_COOKIE } from "./lib/oauthFlow";
import type { TestConvex } from "./testing.helpers";
import type { OAuthPurpose } from "./lib/validators";

export interface StartedFlow {
  res: Response;
  setCookie: string;
  cookie: string;
  secret: string;
  state: string;
  flowId: string;
  challenge: string;
}

export async function connectUrl(
  t: TestConvex,
  householdId: Id<"households">,
  userId = "user_a",
  purpose: OAuthPurpose = "calendar",
): Promise<URL> {
  return new URL(
    await t
      .withIdentity({ subject: userId })
      .action(api.googleOauth.connectUrl, { householdId, purpose }),
  );
}

export async function connectPath(
  t: TestConvex,
  householdId: Id<"households">,
  userId = "user_a",
  purpose: OAuthPurpose = "calendar",
): Promise<string> {
  const url = await connectUrl(t, householdId, userId, purpose);
  return `${url.pathname}${url.search}`;
}

export function startedFrom(res: Response): StartedFlow {
  expect(res.status).toBe(302);
  const consent = new URL(res.headers.get("Location")!);
  const setCookie = res.headers.get("Set-Cookie")!;
  const cookie = setCookie.split(";")[0]!;
  const state = consent.searchParams.get("state")!;
  return {
    res,
    setCookie,
    cookie,
    secret: cookie.slice(FLOW_COOKIE.length + 1),
    state,
    flowId: state.split(".")[0]!,
    challenge: consent.searchParams.get("code_challenge")!,
  };
}

export async function startFlow(
  t: TestConvex,
  householdId: Id<"households">,
  userId = "user_a",
  purpose: OAuthPurpose = "calendar",
): Promise<StartedFlow> {
  return startedFrom(await t.fetch(await connectPath(t, householdId, userId, purpose)));
}

export function finish(
  t: TestConvex,
  flow: { state: string; cookie: string | null },
  code = "c",
): Promise<Response> {
  return t.fetch(`/google/callback?code=${code}&state=${encodeURIComponent(flow.state)}`, {
    headers: flow.cookie === null ? {} : { Cookie: flow.cookie },
  });
}
