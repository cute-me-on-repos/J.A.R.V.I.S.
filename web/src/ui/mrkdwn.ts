/**
 * Slack mrkdwn -> a small tree the Console renders as React elements.
 *
 * Pure and string-only: no HTML is ever built, so nothing in a message can
 * inject markup (React escapes text nodes). Slack sends `&`, `<` and `>` as
 * `&amp;`, `&lt;`, `&gt;` and wraps links and mentions in `<...>`, so those
 * entities are decoded exactly once, into text nodes only.
 */

export type Inline =
  | { t: "text"; text: string }
  | { t: "link"; href: string; label: string }
  | { t: "user"; id: string; label?: string }
  | { t: "channel"; id: string; label?: string }
  | { t: "special"; label: string }
  | { t: "code"; text: string }
  | { t: "bold" | "italic" | "strike"; children: Inline[] };

export type Block =
  | { t: "para"; children: Inline[] }
  | { t: "quote"; children: Inline[] }
  | { t: "pre"; text: string };

const ENTITY = /&(lt|gt|amp);/g;
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&" };
/** `&amp;lt;` is the text `&lt;`, so decode in one pass, never repeatedly. */
export const decodeEntities = (s: string): string => s.replace(ENTITY, (_m, e: string) => ENTITIES[e]!);

const USER_ID = /^[UW][A-Z0-9]+$/;
const CHANNEL_ID = /^[CGD][A-Z0-9]+$/;
const SAFE_LINK = /^(https?:\/\/|mailto:)\S+$/i;
const BARE_URL = /^https?:\/\/[^\s<>]+/i;
const SPECIALS: Record<string, string> = { here: "@here", channel: "@channel", everyone: "@everyone" };

/** Only http(s) and mailto ever become a link; `javascript:` and friends stay text. */
export const safeHref = (raw: string): string | undefined => {
  const href = decodeEntities(raw.trim());
  return SAFE_LINK.test(href) ? href : undefined;
};

/** Strip what a sentence puts after a url, so `see https://x.com/a.` links `https://x.com/a`. */
const trimUrl = (url: string): string => {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    const unbalanced = last === ")" && (u.match(/\)/g)?.length ?? 0) > (u.match(/\(/g)?.length ?? 0);
    if (last && (/[.,;:!?'"\]]/.test(last) || unbalanced)) u = u.slice(0, -1);
    else return u;
  }
};

/** What is inside one `<...>`; null when it is not a token we know (rendered as plain text). */
const token = (inner: string): Inline | null => {
  const bar = inner.indexOf("|");
  const head = bar === -1 ? inner : inner.slice(0, bar);
  const label = bar === -1 ? undefined : decodeEntities(inner.slice(bar + 1));
  if (head.startsWith("@")) {
    const id = head.slice(1);
    return USER_ID.test(id) ? { t: "user", id, label: label || undefined } : null;
  }
  if (head.startsWith("#")) {
    const id = head.slice(1);
    return CHANNEL_ID.test(id) ? { t: "channel", id, label: label || undefined } : null;
  }
  if (head.startsWith("!")) {
    const name = head.slice(1);
    const plain = SPECIALS[name];
    if (plain) return { t: "special", label: plain };
    if (name.startsWith("subteam^")) return { t: "special", label: label || "@group" };
    // `<!date^...|fallback>` and unknown commands: show what Slack gave as the fallback.
    return label ? { t: "text", text: label } : { t: "special", label: `@${name.split("^")[0]}` };
  }
  const href = safeHref(head);
  if (!href) return null;
  return { t: "link", href, label: label || decodeEntities(head.replace(/^mailto:/i, "")) };
};

const alnum = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}]/u.test(c);

/** The index of the closing `mark` for an opener at `from`, or -1: no blank edge, no newline, not glued to a word. */
const closer = (s: string, from: number, mark: string): number => {
  for (let j = from + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\n") return -1;
    if (c === mark && j > from + 1 && !/\s/.test(s[j - 1]!) && !alnum(s[j + 1]) && !(mark === "_" && s[j + 1] === "_")) return j;
  }
  return -1;
};

const MARKS: Record<string, "bold" | "italic" | "strike"> = { "*": "bold", _: "italic", "~": "strike" };

export const parseInline = (src: string): Inline[] => {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", text: decodeEntities(buf) });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const before = src[i - 1];
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1 && !src.slice(i + 1, end).includes("\n")) {
        flush();
        out.push({ t: "code", text: decodeEntities(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    } else if (c === "<") {
      const m = /^<([^<>\n]+)>/.exec(src.slice(i));
      const tok = m ? token(m[1]!) : null;
      if (m && tok) {
        flush();
        out.push(tok);
        i += m[0].length;
        continue;
      }
    } else if (MARKS[c] && !alnum(before) && !(c === "_" && (before === "_" || src[i + 1] === "_")) && i + 1 < src.length && !/\s/.test(src[i + 1]!)) {
      const end = closer(src, i, c);
      if (end > 0) {
        flush();
        out.push({ t: MARKS[c]!, children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    } else if ((c === "h" || c === "H") && !alnum(before)) {
      const m = BARE_URL.exec(src.slice(i));
      const url = m ? trimUrl(m[0]) : "";
      const href = url ? safeHref(url) : undefined;
      if (href) {
        flush();
        out.push({ t: "link", href, label: decodeEntities(url) });
        i += url.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
};

const QUOTE = /^(?:&gt;|>) ?/;
const QUOTE_REST = /^(?:&gt;&gt;&gt;|>>>) ?/;

/** Quotes (`> line`, `>>> to the end`) and plain paragraphs of one fence-free stretch of text. */
const parseLines = (text: string): Block[] => {
  const blocks: Block[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ t: "para", children: parseInline(para.join("\n")) });
    para = [];
  };
  const flushQuote = () => {
    if (quote.length) blocks.push({ t: "quote", children: parseInline(quote.join("\n")) });
    quote = [];
  };
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (QUOTE_REST.test(line)) {
      flushPara();
      flushQuote();
      blocks.push({ t: "quote", children: parseInline([line.replace(QUOTE_REST, ""), ...lines.slice(n + 1)].join("\n")) });
      return blocks;
    }
    if (QUOTE.test(line)) {
      flushPara();
      quote.push(line.replace(QUOTE, ""));
    } else {
      flushQuote();
      para.push(line);
    }
  }
  flushPara();
  flushQuote();
  return blocks;
};

/** A whole message: ``` fences first, then quotes and paragraphs between them. */
export const parseMrkdwn = (text: string): Block[] => {
  const blocks: Block[] = [];
  const fence = /```([\s\S]*?)```/g;
  let last = 0;
  // A fence is a block of its own: the line break on each side of it is not text.
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    blocks.push(...parseLines(text.slice(last, m.index).replace(/^\n/, "").replace(/\n$/, "")));
    blocks.push({ t: "pre", text: decodeEntities(m[1]!.replace(/^\n/, "")) });
    last = m.index + m[0].length;
  }
  blocks.push(...parseLines(text.slice(last).replace(/^\n/, "")));
  return blocks.filter((b) => b.t === "pre" || b.children.length > 0);
};

export type MrkdwnRefs = { users: string[]; channels: string[] };

const walk = (nodes: readonly Inline[], refs: { users: Set<string>; channels: Set<string> }): void => {
  for (const n of nodes) {
    if (n.t === "user") refs.users.add(n.id);
    else if (n.t === "channel") refs.channels.add(n.id);
    else if (n.t === "bold" || n.t === "italic" || n.t === "strike") walk(n.children, refs);
  }
};

/** The user and channel ids the given messages mention, for one batch name lookup. */
export const mrkdwnRefs = (texts: readonly string[]): MrkdwnRefs => {
  const refs = { users: new Set<string>(), channels: new Set<string>() };
  for (const text of texts) {
    for (const b of parseMrkdwn(text)) if (b.t !== "pre") walk(b.children, refs);
  }
  return { users: [...refs.users], channels: [...refs.channels] };
};
