import { describe, expect, test } from "bun:test";
import { consolePath, loadedFor, parseConsolePath } from "../../web/src/consoleNav.ts";

describe("console urls", () => {
  test("a channel, and a thread in it, are read from the path after /console/", () => {
    expect(parseConsolePath("C0ABC123")).toEqual({ channel: "C0ABC123", thread: "" });
    expect(parseConsolePath("D012AB/1700000000.123456")).toEqual({ channel: "D012AB", thread: "1700000000.123456" });
    expect(parseConsolePath("G01/1700000000.000100/")).toEqual({ channel: "G01", thread: "1700000000.000100" });
  });

  test("nothing, or something that is not a conversation, reads as no channel; a bad thread is dropped, not guessed", () => {
    expect(parseConsolePath(undefined)).toEqual({ channel: "", thread: "" });
    expect(parseConsolePath("")).toEqual({ channel: "", thread: "" });
    expect(parseConsolePath("general")).toEqual({ channel: "", thread: "" });
    expect(parseConsolePath("c0abc123")).toEqual({ channel: "", thread: "" });
    expect(parseConsolePath("C0ABC123/notatimestamp")).toEqual({ channel: "C0ABC123", thread: "" });
    expect(parseConsolePath("C0ABC123/1700000000.123456/extra")).toEqual({ channel: "C0ABC123", thread: "1700000000.123456" });
    expect(parseConsolePath("general/1700000000.123456")).toEqual({ channel: "", thread: "" });
  });

  test("a location writes back to the same path it reads from", () => {
    expect(consolePath("")).toBe("/console");
    expect(consolePath("C0ABC123")).toBe("/console/C0ABC123");
    expect(consolePath("C0ABC123", "1700000000.123456")).toBe("/console/C0ABC123/1700000000.123456");
    expect(parseConsolePath(consolePath("D012AB", "1.5").replace("/console/", ""))).toEqual({ channel: "D012AB", thread: "1.5" });
  });

  test("data loaded for the view just left is not the new view's: nothing is seeded from it", () => {
    expect(loadedFor("C1/", "C1")).toBe(true);
    expect(loadedFor("C1/", "C2")).toBe(false); // switched channel, old history still in state for one render
    expect(loadedFor("", "C1")).toBe(false);
    expect(loadedFor("C1/1.5", "C1", "1.5")).toBe(true);
    expect(loadedFor("C1/1.5", "C1", "2.5")).toBe(false); // thread to thread
    expect(loadedFor("C1/1.5", "C1")).toBe(false); // thread back to channel
    expect(loadedFor("C1/", "", "")).toBe(false);
  });
});
