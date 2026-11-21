import { describe, expect, test } from "vitest";
import { WIDGET_REFRESH_GAP_MS, refreshDecision } from "./widgetRefresh";

const T0 = Date.parse("2026-11-13T13:00:00Z");

const MIN = 60_000;

describe("refreshDecision", () => {
  test("the gap is ten minutes", () => {
    expect(WIDGET_REFRESH_GAP_MS).toBe(10 * MIN);
  });

  test("a phone that was never refreshed is sent to at once", () => {
    expect(refreshDecision(undefined, T0)).toEqual({ kind: "send" });
  });

  test("a change inside the gap is held for one send when the gap ends", () => {
    expect(refreshDecision({ sentAt: T0, trailingAt: null }, T0 + 1)).toEqual({
      kind: "trail",
      state: { sentAt: T0, trailingAt: T0 + 10 * MIN },
    });
    expect(refreshDecision({ sentAt: T0, trailingAt: null }, T0 + 10 * MIN - 1).kind).toBe("trail");
  });

  test("further changes while a send is held are folded into it", () => {
    const held = { sentAt: T0, trailingAt: T0 + 10 * MIN };
    expect(refreshDecision(held, T0 + 2 * MIN)).toEqual({ kind: "fold" });
    expect(refreshDecision(held, T0 + 10 * MIN)).toEqual({ kind: "fold" });
  });

  test("a change once the gap has passed is sent at once", () => {
    expect(refreshDecision({ sentAt: T0, trailingAt: null }, T0 + 10 * MIN)).toEqual({
      kind: "send",
    });
  });

  test("a held send that never ran does not block later changes", () => {
    const stuck = { sentAt: T0, trailingAt: T0 + 10 * MIN };
    expect(refreshDecision(stuck, T0 + 10 * MIN + 1)).toEqual({ kind: "send" });
  });
});
