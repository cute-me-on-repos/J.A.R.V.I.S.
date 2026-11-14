import { describe, expect, test } from "bun:test";
import { mergeTimeline, oldestOnScreen, pickInternal, previewOf, PREVIEW_CHARS, KIND_META, type InternalMessage } from "../../web/src/internalTimeline.ts";

const hid = (id: string, at: number, over: Partial<InternalMessage> = {}): InternalMessage => ({ id, kind: "tell", source: "U1", text: "t", at, threadTs: "", ...over });
const slack = (ts: string) => ({ ts });

describe("console hidden-message timeline", () => {
  test("hidden messages interleave with Slack ones by time, Slack first on a tie", () => {
    const merged = mergeTimeline([slack("100.0"), slack("200.0")], [hid("a", 150_000), hid("b", 200_000), hid("c", 300_000)]);
    expect(merged.map((e) => (e.type === "slack" ? e.message.ts : e.message.id))).toEqual(["100.0", "a", "200.0", "b", "c"]);
  });

  test("every kind has an icon, a label and a hint", () => {
    for (const k of ["tell", "brief", "watch", "nudge", "orca", "loop"] as const) {
      expect(KIND_META[k].icon).toBeTruthy();
      expect(KIND_META[k].label).toBeTruthy();
      expect(KIND_META[k].hint).toBeTruthy();
    }
  });

  test("pickInternal scopes by thread, drops what predates the page, and searches text and source", () => {
    const items = [hid("a", 100, { threadTs: "1.1", text: "Deploy now" }), hid("b", 200, { threadTs: "2.2", source: "watch hand-back" }), hid("c", 300, { threadTs: "1.1" })];
    expect(pickInternal(items, { threadTs: "1.1" }).map((m) => m.id)).toEqual(["a", "c"]);
    expect(pickInternal(items, { since: 150 }).map((m) => m.id)).toEqual(["b", "c"]);
    expect(pickInternal(items, { filter: " deploy " }).map((m) => m.id)).toEqual(["a"]);
    expect(pickInternal(items, { filter: "HAND-BACK" }).map((m) => m.id)).toEqual(["b"]);
    expect(pickInternal(items, {}).length).toBe(3);
  });

  test("oldestOnScreen only matters while older pages remain", () => {
    expect(oldestOnScreen([slack("300.5"), slack("100.5")], true)).toBe(100_500);
    expect(oldestOnScreen([slack("100.5")], false)).toBeUndefined();
    expect(oldestOnScreen([], true)).toBeUndefined();
  });

  test("previewOf collapses long or multi-line text and leaves short one alone", () => {
    expect(previewOf("short")).toEqual({ shown: "short", cut: false });
    expect(previewOf("two\nlines")).toEqual({ shown: "two lines", cut: true });
    const long = previewOf("x".repeat(PREVIEW_CHARS + 10));
    expect(long.cut).toBe(true);
    expect(long.shown.length).toBe(PREVIEW_CHARS + 1);
  });
});
