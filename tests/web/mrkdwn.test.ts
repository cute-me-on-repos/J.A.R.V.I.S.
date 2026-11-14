import { describe, expect, test } from "bun:test";
import { decodeEntities, mrkdwnRefs, parseInline, parseMrkdwn, safeHref } from "../../web/src/ui/mrkdwn.ts";

describe("links", () => {
  test("labelled, bare and mailto tokens become links", () => {
    expect(parseInline("<https://x.dev/a?b=1&amp;c=2|the doc>")).toEqual([{ t: "link", href: "https://x.dev/a?b=1&c=2", label: "the doc" }]);
    expect(parseInline("<https://x.dev>")).toEqual([{ t: "link", href: "https://x.dev", label: "https://x.dev" }]);
    expect(parseInline("<mailto:a@b.co|mail me>")).toEqual([{ t: "link", href: "mailto:a@b.co", label: "mail me" }]);
    expect(parseInline("<mailto:a@b.co>")).toEqual([{ t: "link", href: "mailto:a@b.co", label: "a@b.co" }]);
  });

  test("a bare url links without the punctuation that ends the sentence", () => {
    expect(parseInline("see https://x.dev/a.")).toEqual([
      { t: "text", text: "see " },
      { t: "link", href: "https://x.dev/a", label: "https://x.dev/a" },
      { t: "text", text: "." },
    ]);
    expect(parseInline("(https://x.dev/a_b_c)")).toEqual([
      { t: "text", text: "(" },
      { t: "link", href: "https://x.dev/a_b_c", label: "https://x.dev/a_b_c" },
      { t: "text", text: ")" },
    ]);
  });

  test("only http(s) and mailto are links - javascript: stays text", () => {
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("data:text/html,x")).toBeUndefined();
    expect(parseInline("<javascript:alert(1)|click>")).toEqual([{ t: "text", text: "<javascript:alert(1)|click>" }]);
  });
});

describe("mentions", () => {
  test("user and channel tokens keep the id and the inline label", () => {
    expect(parseInline("<@U123> <@W9A|kai> <#C123|ops> <#C456>")).toEqual([
      { t: "user", id: "U123", label: undefined },
      { t: "text", text: " " },
      { t: "user", id: "W9A", label: "kai" },
      { t: "text", text: " " },
      { t: "channel", id: "C123", label: "ops" },
      { t: "text", text: " " },
      { t: "channel", id: "C456", label: undefined },
    ]);
  });

  test("broadcasts and user groups are readable", () => {
    expect(parseInline("<!here> <!channel> <!everyone> <!subteam^S01|@devs> <!subteam^S02>")).toEqual([
      { t: "special", label: "@here" },
      { t: "text", text: " " },
      { t: "special", label: "@channel" },
      { t: "text", text: " " },
      { t: "special", label: "@everyone" },
      { t: "text", text: " " },
      { t: "special", label: "@devs" },
      { t: "text", text: " " },
      { t: "special", label: "@group" },
    ]);
  });

  test("a malformed mention is text, never a crash", () => {
    expect(parseInline("<@not an id> <#> <@>")).toEqual([{ t: "text", text: "<@not an id> <#> <@>" }]);
  });

  test("refs lists each mentioned id once, including inside styling, not inside code", () => {
    expect(mrkdwnRefs(["hi <@U1> and *<@U2>* in <#C1|a>", "<@U1> <#C2> `<@U3>`", "```<@U4>```"])).toEqual({
      users: ["U1", "U2"],
      channels: ["C1", "C2"],
    });
  });
});

describe("styling", () => {
  test("bold, italic, strike and code", () => {
    expect(parseInline("*b* _i_ ~s~ `c`")).toEqual([
      { t: "bold", children: [{ t: "text", text: "b" }] },
      { t: "text", text: " " },
      { t: "italic", children: [{ t: "text", text: "i" }] },
      { t: "text", text: " " },
      { t: "strike", children: [{ t: "text", text: "s" }] },
      { t: "text", text: " " },
      { t: "code", text: "c" },
    ]);
  });

  test("styling nests and wraps a mention", () => {
    expect(parseInline("*hi <@U1>*")).toEqual([{ t: "bold", children: [{ t: "text", text: "hi " }, { t: "user", id: "U1", label: undefined }] }]);
  });

  test("snake_case, math and lone markers are not styling", () => {
    expect(parseInline("a_b_c 2 * 3 * 4 *x")).toEqual([{ t: "text", text: "a_b_c 2 * 3 * 4 *x" }]);
  });

  test("code is literal: no styling and no mentions inside", () => {
    expect(parseInline("`*not bold* <@U1>`")).toEqual([{ t: "code", text: "*not bold* <@U1>" }]);
  });

  test("fences and quotes are blocks; line breaks around a fence are dropped", () => {
    expect(parseMrkdwn("before\n```\nlet a = 1 &lt; 2\n```\nafter")).toEqual([
      { t: "para", children: [{ t: "text", text: "before" }] },
      { t: "pre", text: "let a = 1 < 2\n" },
      { t: "para", children: [{ t: "text", text: "after" }] },
    ]);
    expect(parseMrkdwn("&gt; one\n&gt; two\nplain")).toEqual([
      { t: "quote", children: [{ t: "text", text: "one\ntwo" }] },
      { t: "para", children: [{ t: "text", text: "plain" }] },
    ]);
    expect(parseMrkdwn("x\n&gt;&gt;&gt; a\nb")).toEqual([
      { t: "para", children: [{ t: "text", text: "x" }] },
      { t: "quote", children: [{ t: "text", text: "a\nb" }] },
    ]);
  });
});

describe("escaping", () => {
  test("entities decode once, into text only", () => {
    expect(decodeEntities("&lt;b&gt; &amp;amp; &quot;")).toBe("<b> &amp; &quot;");
    expect(parseInline("a &lt;script&gt;alert(1)&lt;/script&gt; &amp; b")).toEqual([
      { t: "text", text: "a <script>alert(1)</script> & b" },
    ]);
  });

  test("raw html a message carries stays a text node", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([{ t: "text", text: "<img src=x onerror=alert(1)>" }]);
  });

  test("an empty message has no blocks", () => {
    expect(parseMrkdwn("")).toEqual([]);
  });
});
