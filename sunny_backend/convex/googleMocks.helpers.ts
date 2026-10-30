// googleMocks.helpers.ts
// Purpose: Shared vitest mocks for the Google Calendar tests (calendarQueue.test.ts,
// calendarPush.test.ts, googleCalendar.test.ts), so Google is never called. Each test file
// registers them with vi.mock, whose factories import from here:
//   vi.mock("./lib/google", async (orig) => (await import("./googleMocks.helpers")).googleMock(await orig()));
//   vi.mock("./lib/googleEvent", async () => (await import("./googleMocks.helpers")).googleEventMock);
//   vi.mock("./lib/secretBox", async (orig) => (await import("./googleMocks.helpers")).secretBoxMock(await orig()));
// The name has two dots, so Convex does not treat this file as a function module.
//
// Last modified: 2026-10-29

import { vi } from "vitest";

/** The mocked Google functions, shared by the test file and the mocked module. */
export const googleMocks = {
  exchangeCode: vi.fn(),
  refreshAccessToken: vi.fn(),
  createSunnyCalendar: vi.fn(),
  calendarExists: vi.fn(),
  upsertEvent: vi.fn(),
  deleteEvent: vi.fn(),
  verifyState: vi.fn(),
  signState: vi.fn(),
  revokeRefreshToken: vi.fn(),
};

/**
 * purpose: The lib/google module with its network functions replaced (error classes and the
 *          scope constant stay real).
 * @param original: (object) The real module.
 * @return: (object) The mocked module.
 */
export function googleMock<T extends object>(original: T): T {
  return {
    ...original,
    ...googleMocks,
    consentUrl: (state: string) => `https://consent.test/?state=${state}`,
  };
}

/** The lib/googleEvent module with simple, deterministic mappings. */
export const googleEventMock = {
  eventSyncPayload: (event: { deletedAt?: number; title: string }) => ({
    cancelled: event.deletedAt !== undefined,
    title: event.title,
  }),
  buildGoogleEvent: (p: { title: string }) => ({ summary: p.title }),
  googleEventId: (id: string) => `g${id.toLowerCase()}`,
};

/**
 * purpose: The lib/secretBox module with a reversible, visible prefix instead of encryption. A
 *          box without the prefix is unreadable, as a real box under a wrong key would be.
 * @param original: (object) The real module (for its SecretUnreadable class).
 * @return: (object) The mocked module.
 */
export function secretBoxMock<T extends object>(original: T): T {
  const Unreadable = (original as unknown as { SecretUnreadable: new (m: string) => Error })
    .SecretUnreadable;
  return {
    ...original,
    encryptSecret: async (plain: string) => `box:${plain}`,
    decryptSecret: async (box: string) => {
      if (!box.startsWith("box:")) throw new Unreadable("Could not decrypt secret");
      return box.slice(4);
    },
  };
}

/**
 * purpose: Reset every Google mock and give the happy-path defaults: a token refresh that
 *          yields "access-1" valid for an hour, upserts that create "gext1", deletes that
 *          succeed, a state signer and a revoke that succeeds.
 * @return: (void)
 */
export function resetGoogleMocks(): void {
  for (const mock of Object.values(googleMocks)) mock.mockReset();
  googleMocks.refreshAccessToken.mockResolvedValue({
    accessToken: "access-1",
    expiresAt: Date.now() + 3_600_000,
  });
  googleMocks.upsertEvent.mockResolvedValue({ id: "gext1", etag: "etag-1", created: true });
  googleMocks.deleteEvent.mockResolvedValue(undefined);
  googleMocks.signState.mockImplementation(
    async (userId: string, householdId: string, nonce: string) =>
      `${userId}~${householdId}~${nonce}`,
  );
  googleMocks.revokeRefreshToken.mockResolvedValue(true);
}
