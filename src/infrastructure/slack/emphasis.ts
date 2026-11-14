/**
 * Streaming emphasis normaliser.
 *
 * `markdown_text` is parsed as standard Markdown, where the model's mrkdwn
 * `*bold*` would render italic. `toSlackMarkdown` rewrites it to `**bold**`, but
 * text arrives in deltas, so a pair can be split across them ("*nh" then
 * "ip:*"). This holds back only what it must - from an opener that has no
 * closer yet, or an unclosed backtick, to the end of what has arrived - and
 * everything before it goes out at once, so streaming still feels live. A
 * newline settles a line (emphasis never spans one). Fenced code passes through
 * untouched; run it after the fence normaliser, which puts every ``` on its
 * own line.
 */
import { toSlackMarkdown } from "../../domain/slackFormat.ts";

export type EmphasisNormalizer = {
  /** Feed a delta, get back the text that is safe to send now (may be ""). */
  push: (delta: string) => string;
  /** Emit whatever is still held back, at the end of the turn. */
  flush: () => string;
};

/**
 * A marker that could open emphasis. Per marker, with the same lookarounds as
 * `BOLD` and `STRIKE` in `toSlackMarkdown`, so `*~x~*` is held like the whole
 * text converts it.
 */
const OPENER = /(?<![*\\\p{L}\p{N}])\*(?![\s*])|(?<![~\\\p{L}\p{N}])~(?![\s~])/gu;

/** Where a completed run starting at `i` ends, or -1 when it has no closer yet. */
const closedAt = (s: string, i: number): number => {
  const m = s[i];
  const re = new RegExp(`[${m}](?![\\s${m}])[^${m}\\n]*?[^\\s${m}][${m}](?![${m}\\p{L}\\p{N}])`, "uy");
  re.lastIndex = i;
  const hit = re.exec(s);
  return hit ? i + hit[0].length : -1;
};

/**
 * How much of an unfinished line is safe to send. Everything before the first
 * unclosed backtick or opener-without-closer; a run that closes exactly at the
 * end is held too, since the next character may still extend it (`**`, a letter).
 */
const safeLength = (rest: string, ctx: string): number => {
  // Judged with the stand-in for the char already sent, so a marker at the
  // start of `rest` is read the way the whole line reads it.
  const line = ctx + rest;
  // Whole code spans and Slack <links> are opaque; whatever backtick or `<` is
  // left is unclosed, and held.
  const masked = line
    .replace(/`[^`\n]*`/g, (c) => "\u0001".repeat(c.length))
    .replace(/<[^<>\s][^<>\n]*>/g, (c) => "\u0001".repeat(c.length));
  const open = [masked.indexOf("`"), masked.search(/<(?!\s)/)].filter((i) => i !== -1);
  const limit = open.length > 0 ? Math.min(...open) : line.length;
  // The closer of a run that already closed can look like an opener too
  // (`*Status:*,`), so a marker inside a closed run of its own kind is skipped.
  // A cut inside a closed run would split it, so the cut moves to its start.
  const closed: { marker: string; start: number; end: number }[] = [];
  const cutAt = (i: number): number =>
    Math.max(0, Math.min(i, ...closed.filter((r) => r.start < i && i < r.end).map((r) => r.start)) - ctx.length);
  OPENER.lastIndex = 0;
  for (const m of masked.matchAll(OPENER)) {
    if (m.index >= limit) break;
    if (closed.some((r) => r.marker === m[0] && m.index < r.end)) continue;
    const end = closedAt(masked, m.index);
    if (end === -1 || end >= masked.length) return cutAt(m.index);
    closed.push({ marker: m[0], start: m.index, end });
  }
  return cutAt(limit);
};

export const createEmphasisNormalizer = (): EmphasisNormalizer => {
  let buf = "";
  let inFence = false;
  let atLineStart = true;
  // The last raw char sent on the current line: `BOLD`/`STRIKE` judge a marker
  // by the char before it, and that char may have gone out in an earlier chunk.
  let prev = "";

  /**
   * Convert the rest of a line with the char before it in mind. A char those
   * lookbehinds reject (`\\`, a letter, a digit, a marker) is stood in for by a
   * plain letter, which can never pair with anything itself.
   */
  const context = (): string => (/[\\\p{L}\p{N}*~]/u.test(prev) ? "a" : "");
  const convert = (chunk: string): string => {
    const ctx = context();
    prev = chunk.endsWith("\n") ? "" : (chunk.slice(-1) || prev);
    return toSlackMarkdown(ctx + chunk).slice(ctx.length);
  };

  const run = (final: boolean): string => {
    let out = "";
    const emit = (text: string): void => {
      if (!text) return;
      out += text;
      atLineStart = text.endsWith("\n");
    };
    for (;;) {
      if (!buf) break;
      const nl = buf.indexOf("\n");
      // A line that opens or closes a fence has to be seen whole, and a lone
      // run of backticks at a line start may still become one.
      if (atLineStart && !final && nl === -1 && /^`{1,3}/.test(buf) && (buf.length < 3 || buf.startsWith("```"))) break;
      if (nl !== -1) {
        const line = buf.slice(0, nl + 1);
        buf = buf.slice(nl + 1);
        const fenceLine = atLineStart && line.startsWith("```");
        if (fenceLine) inFence = !inFence;
        if (inFence || fenceLine) {
          prev = "";
          emit(line);
        } else emit(convert(line));
        continue;
      }
      if (inFence) {
        emit(buf);
        buf = "";
        break;
      }
      const cut = final ? buf.length : safeLength(buf, context());
      emit(convert(buf.slice(0, cut)));
      buf = buf.slice(cut);
      break;
    }
    return out;
  };

  return {
    push: (delta: string) => {
      buf += delta;
      return run(false);
    },
    flush: () => {
      const text = run(true);
      buf = "";
      inFence = false;
      atLineStart = true;
      prev = "";
      return text;
    },
  };
};
