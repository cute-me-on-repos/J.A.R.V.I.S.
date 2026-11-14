import { describe, expect, test } from "bun:test";
import { pageReplies } from "../../src/domain/messagePaging.ts";

const thread = ["1.0", "2.0", "3.0", "4.0", "5.0"].map((ts) => ({ ts }));

describe("pageReplies", () => {
  test("the newest page first, oldest first inside it, with a flag when older ones remain", () => {
    expect(pageReplies(thread, 2)).toEqual({ messages: [{ ts: "4.0" }, { ts: "5.0" }], hasMore: true });
  });

  test("`before` takes the next older page, and the last page has no more", () => {
    expect(pageReplies(thread, 2, "4.0")).toEqual({ messages: [{ ts: "2.0" }, { ts: "3.0" }], hasMore: true });
    expect(pageReplies(thread, 2, "2.0")).toEqual({ messages: [{ ts: "1.0" }], hasMore: false });
  });

  test("a small thread comes back whole; a size below one still returns one message", () => {
    expect(pageReplies(thread, 50)).toEqual({ messages: thread, hasMore: false });
    expect(pageReplies(thread, 0).messages).toEqual([{ ts: "5.0" }]);
    expect(pageReplies([], 5)).toEqual({ messages: [], hasMore: false });
  });

  test("ts compare as numbers, not text (10.0 is newer than 9.0)", () => {
    expect(pageReplies([{ ts: "9.0" }, { ts: "10.0" }], 5, "10.0").messages).toEqual([{ ts: "9.0" }]);
  });
});
