import { describe, expect, test } from "bun:test";
import { loadedBelow, nearBottom, nearTop, prependOlder, replaceNewest } from "../../web/src/pageMerge.ts";

const m = (ts: string, text = ts) => ({ ts, text });
const tss = (xs: readonly { ts: string }[]) => xs.map((x) => x.ts);

describe("page merging", () => {
  test("an older page goes in front, in time order, a message in both kept once", () => {
    const cur = [m("30.0"), m("40.0")];
    expect(tss(prependOlder(cur, [m("10.0"), m("20.0"), m("30.0", "stale copy")]))).toEqual(["10.0", "20.0", "30.0", "40.0"]);
    expect(prependOlder(cur, [m("30.0", "stale copy")])[0]!.text).toBe("30.0");
    expect(prependOlder([], [m("2.0"), m("1.0")]).map((x) => x.ts)).toEqual(["1.0", "2.0"]);
  });

  test("ts order is numeric: 9.5 comes before 10.0", () => {
    expect(tss(prependOlder([m("10.0")], [m("9.5")]))).toEqual(["9.5", "10.0"]);
  });

  test("the newest page read again replaces what it covers and keeps the older pages", () => {
    const cur = [m("10.0"), m("20.0"), m("30.0"), m("40.0")];
    // 30.0 was deleted in Slack, 50.0 is new, 40.0 was edited
    expect(replaceNewest(cur, [m("40.0", "edited"), m("50.0")])).toEqual([m("10.0"), m("20.0"), m("30.0"), m("40.0", "edited"), m("50.0")]);
    expect(tss(replaceNewest(cur, [m("20.0"), m("40.0")]))).toEqual(["10.0", "20.0", "40.0"]);
    expect(replaceNewest(cur, [])).toEqual([]);
  });

  test("loadedBelow says whether older pages are loaded under the newest page", () => {
    expect(loadedBelow([m("10.0"), m("20.0")], [m("20.0"), m("30.0")])).toBe(true);
    expect(loadedBelow([m("20.0")], [m("20.0"), m("30.0")])).toBe(false);
    expect(loadedBelow([m("20.0")], [])).toBe(false);
    expect(loadedBelow([], [m("1.0")])).toBe(false);
  });

  test("the bottom and the top are a little forgiving", () => {
    expect(nearBottom(900, 100, 1000)).toBe(true);
    expect(nearBottom(860, 100, 1000)).toBe(true);
    expect(nearBottom(500, 100, 1000)).toBe(false);
    expect(nearBottom(0, 500, 400)).toBe(true); // nothing to scroll: always at the bottom
    expect(nearTop(0)).toBe(true);
    expect(nearTop(80)).toBe(true);
    expect(nearTop(400)).toBe(false);
  });
});
