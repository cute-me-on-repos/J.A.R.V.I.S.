import { describe, expect, test } from "bun:test";
import { copyText, messagePermalink } from "../../web/src/ui/permalink.ts";

const WS = "https://acme.slack.com";

describe("messagePermalink", () => {
  test("a channel message is /archives/<channel>/p<ts without the dot>", () => {
    expect(messagePermalink(WS, { channel: "C0123ABC", ts: "1787122692.303399" })).toBe(
      "https://acme.slack.com/archives/C0123ABC/p1787122692303399",
    );
  });

  test("a thread reply carries thread_ts and cid", () => {
    expect(messagePermalink(WS, { channel: "C0123ABC", ts: "1787122700.000100", threadTs: "1787122692.303399" })).toBe(
      "https://acme.slack.com/archives/C0123ABC/p1787122700000100?thread_ts=1787122692.303399&cid=C0123ABC",
    );
  });

  test("a thread root is a plain channel link, not a reply", () => {
    expect(messagePermalink(WS, { channel: "C1", ts: "1787122692.303399", threadTs: "1787122692.303399" })).toBe(
      "https://acme.slack.com/archives/C1/p1787122692303399",
    );
  });

  test("a DM links the same way, and a trailing slash on the workspace url is dropped", () => {
    expect(messagePermalink("https://acme.slack.com/", { channel: "D9XYZ", ts: "1787122692.000001" })).toBe(
      "https://acme.slack.com/archives/D9XYZ/p1787122692000001",
    );
    expect(messagePermalink(WS, { channel: "D9XYZ", ts: "1787122700.000002", threadTs: "1787122692.000001" })).toBe(
      "https://acme.slack.com/archives/D9XYZ/p1787122700000002?thread_ts=1787122692.000001&cid=D9XYZ",
    );
  });
});

type Fake = { value: string; style: Record<string, string>; removed: boolean };
const fakeDoc = (copy: (el: Fake) => boolean) => {
  const el: Fake = { value: "", style: {}, removed: false };
  return {
    el,
    doc: {
      createElement: () => ({
        get value() { return el.value; },
        set value(v: string) { el.value = v; },
        style: el.style,
        setAttribute: () => {},
        focus: () => {},
        select: () => {},
        remove: () => { el.removed = true; },
      }),
      body: { appendChild: () => {} },
      execCommand: () => copy(el),
    },
  };
};

describe("copyText", () => {
  test("uses navigator.clipboard when there is one", async () => {
    const written: string[] = [];
    const { doc } = fakeDoc(() => { throw new Error("must not fall back"); });
    expect(await copyText("hello", { clipboard: { writeText: async (t) => void written.push(t) } }, doc)).toBe(true);
    expect(written).toEqual(["hello"]);
  });

  test("a non-secure context (no clipboard) falls back to textarea + execCommand", async () => {
    const { el, doc } = fakeDoc((e) => e.value === "hello");
    expect(await copyText("hello", {}, doc)).toBe(true);
    expect(el.removed).toBe(true);
  });

  test("a refused clipboard write also falls back, and a failed fallback says false", async () => {
    const { el, doc } = fakeDoc(() => false);
    const nav = { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } } };
    expect(await copyText("x", nav, doc)).toBe(false);
    expect(el.removed).toBe(true);
  });
});
