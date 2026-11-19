import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getMessage, getProfile, hasSentTo, listHistory, listRecent } from "./gmailApi";
import { GoogleApiError } from "./google";

const fetchMock = vi.fn();

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requested(call = 0): URL {
  return new URL(String(fetchMock.mock.calls[call]![0]));
}

function authorization(call = 0): string {
  return (fetchMock.mock.calls[call]![1] as { headers: Record<string, string> }).headers
    .Authorization!;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected rejection");
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getProfile", () => {
  test("reads the address and the current history id with the bearer token", async () => {
    fetchMock.mockResolvedValue(json(200, { emailAddress: "m@example.com", historyId: "42" }));
    expect(await getProfile("tok")).toEqual({ email: "m@example.com", historyId: "42" });
    expect(requested().origin + requested().pathname).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    );
    expect(authorization()).toBe("Bearer tok");
  });

  test("an answer without a history id is an error, not a silent empty cursor", async () => {
    fetchMock.mockResolvedValue(json(200, { emailAddress: "m@example.com" }));
    expect(await rejection(getProfile("tok"))).toBeInstanceOf(GoogleApiError);
  });

  test("a failure carries Google's status", async () => {
    fetchMock.mockResolvedValue(json(401, { error: "bad" }));
    expect(await rejection(getProfile("tok"))).toMatchObject({ status: 401 });
  });
});

describe("listHistory", () => {
  test("asks for added inbox messages after the cursor and dedupes ids", async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        history: [
          { id: "11", messagesAdded: [{ message: { id: "a" } }, { message: { id: "b" } }] },
          { id: "12", messagesAdded: [{ message: { id: "a" } }] },
        ],
        historyId: "99",
      }),
    );
    const page = await listHistory("tok", "10");
    const params = requested().searchParams;
    expect(requested().pathname).toBe("/gmail/v1/users/me/history");
    expect(params.get("startHistoryId")).toBe("10");
    expect(params.get("historyTypes")).toBe("messageAdded");
    expect(params.get("labelId")).toBe("INBOX");
    expect(params.has("pageToken")).toBe(false);
    expect(page).toEqual({ ids: ["a", "b"], lastHistoryId: "99", next: null });
  });

  test("with more pages the cursor is the last record read, not the mailbox's current id", async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        history: [{ id: "11", messagesAdded: [{ message: { id: "a" } }] }, { id: "15" }],
        nextPageToken: "tok2",
        historyId: "99",
      }),
    );
    expect(await listHistory("tok", "10", "tok1")).toEqual({
      ids: ["a"],
      lastHistoryId: "15",
      next: "tok2",
    });
    expect(requested().searchParams.get("pageToken")).toBe("tok1");
  });

  test("a page with no record while more pages remain does not move the cursor", async () => {
    fetchMock.mockResolvedValue(json(200, { nextPageToken: "tok2", historyId: "99" }));
    expect(await listHistory("tok", "10", "tok1")).toEqual({
      ids: [],
      lastHistoryId: null,
      next: "tok2",
    });
  });

  test("an empty answer yields no ids and the current history id", async () => {
    fetchMock.mockResolvedValue(json(200, { historyId: "99" }));
    expect(await listHistory("tok", "10")).toEqual({ ids: [], lastHistoryId: "99", next: null });
  });

  test("a 404 means the cursor expired", async () => {
    fetchMock.mockResolvedValue(
      json(404, { error: { message: "Requested entity was not found." } }),
    );
    expect(await listHistory("tok", "1")).toBe("expired");
  });

  test("other failures are errors", async () => {
    fetchMock.mockResolvedValue(json(500));
    expect(await rejection(listHistory("tok", "1"))).toMatchObject({
      status: 500,
      retryable: true,
    });
  });
});

describe("listRecent", () => {
  test("lists the inbox newer than the window, rounded up to whole days", async () => {
    fetchMock.mockResolvedValue(json(200, { messages: [{ id: "a" }, { id: "b" }] }));
    const since = Date.now() - 2.5 * 24 * 60 * 60 * 1000;
    expect(await listRecent("tok", since, 50)).toEqual(["a", "b"]);
    const params = requested().searchParams;
    expect(requested().pathname).toBe("/gmail/v1/users/me/messages");
    expect(params.get("labelIds")).toBe("INBOX");
    expect(params.get("q")).toBe("newer_than:3d");
    expect(params.get("maxResults")).toBe("50");
  });

  test("follows pages until the cap and never returns more than the cap", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(200, { messages: [{ id: "a" }, { id: "b" }], nextPageToken: "p2" }),
      )
      .mockResolvedValueOnce(
        json(200, { messages: [{ id: "c" }, { id: "d" }], nextPageToken: "p3" }),
      );
    expect(await listRecent("tok", Date.now() - 1000, 3)).toEqual(["a", "b", "c"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requested(1).searchParams.get("pageToken")).toBe("p2");
    expect(requested(1).searchParams.get("maxResults")).toBe("1");
  });

  test("an empty inbox is an empty list", async () => {
    fetchMock.mockResolvedValue(json(200, { resultSizeEstimate: 0 }));
    expect(await listRecent("tok", Date.now(), 10)).toEqual([]);
  });
});

describe("getMessage", () => {
  test("fetches the full format and returns the raw JSON", async () => {
    fetchMock.mockResolvedValue(json(200, { id: "a/b", payload: {} }));
    expect(await getMessage("tok", "a/b")).toEqual({ id: "a/b", payload: {} });
    expect(requested().pathname).toBe("/gmail/v1/users/me/messages/a%2Fb");
    expect(requested().searchParams.get("format")).toBe("full");
  });

  test("a message Gmail no longer has is null", async () => {
    fetchMock.mockResolvedValue(json(404));
    expect(await getMessage("tok", "gone")).toBeNull();
  });

  test("other failures are errors", async () => {
    fetchMock.mockResolvedValue(json(403));
    expect(await rejection(getMessage("tok", "a"))).toMatchObject({ status: 403 });
  });
});

describe("hasSentTo", () => {
  test("is true when one sent message to the address exists", async () => {
    fetchMock.mockResolvedValue(json(200, { messages: [{ id: "s1" }] }));
    expect(await hasSentTo("tok", "pat@example.com")).toBe(true);
    const params = requested().searchParams;
    expect(params.get("labelIds")).toBe("SENT");
    expect(params.get("q")).toBe("to:pat@example.com");
    expect(params.get("maxResults")).toBe("1");
  });

  test("is false when none exists", async () => {
    fetchMock.mockResolvedValue(json(200, { resultSizeEstimate: 0 }));
    expect(await hasSentTo("tok", "pat@example.com")).toBe(false);
  });

  test("an address that could change the search is never sent to Google", async () => {
    expect(await hasSentTo("tok", 'x@example.com OR in:anywhere "')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
