import { vi } from "vitest";

export const googleMocks = {
  exchangeCode: vi.fn(),
  refreshAccessToken: vi.fn(),
  createSunnyCalendar: vi.fn(),
  calendarExists: vi.fn(),
  upsertEvent: vi.fn(),
  deleteEvent: vi.fn(),
  revokeRefreshToken: vi.fn(),
};

export const gmailMocks = {
  getProfile: vi.fn(),
  listHistory: vi.fn(),
  listRecent: vi.fn(),
  getMessage: vi.fn(),
};

export function gmailMock<T extends object>(original: T): T {
  return { ...original, ...gmailMocks };
}

export function googleMock<T extends object>(original: T): T {
  return { ...original, ...googleMocks };
}

export const googleEventMock = {
  eventSyncPayload: (event: { deletedAt?: number; title: string }) => ({
    cancelled: event.deletedAt !== undefined,
    title: event.title,
  }),
  buildGoogleEvent: (p: { title: string }) => ({ summary: p.title }),
  googleEventId: (id: string) => `g${id.toLowerCase()}`,
};

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

export function resetGoogleMocks(): void {
  for (const mock of [...Object.values(googleMocks), ...Object.values(gmailMocks)]) {
    mock.mockReset();
  }
  gmailMocks.getProfile.mockResolvedValue({ email: "margaret@example.com", historyId: "100" });
  gmailMocks.listRecent.mockResolvedValue([]);
  gmailMocks.listHistory.mockResolvedValue({ ids: [], lastHistoryId: "100", next: null });
  gmailMocks.getMessage.mockResolvedValue(null);
  googleMocks.refreshAccessToken.mockResolvedValue({
    accessToken: "access-1",
    expiresAt: Date.now() + 3_600_000,
  });
  googleMocks.upsertEvent.mockResolvedValue({ id: "gext1", etag: "etag-1", created: true });
  googleMocks.deleteEvent.mockResolvedValue(undefined);
  googleMocks.revokeRefreshToken.mockResolvedValue(true);
}
