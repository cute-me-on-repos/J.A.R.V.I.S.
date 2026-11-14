/**
 * The console's hidden-message timeline: what `/api/memory/internal` returns
 * (messages the bot steered sessions with that never reached Slack), and how
 * they interleave with a Slack history by time. Pure, so it is testable
 * without a browser.
 */

export type InternalKind = "tell" | "brief" | "watch" | "nudge" | "orca" | "loop";

/** One hidden message, as the server sends it (`at` in ms, `threadTs` is the thread it went into). */
export type InternalMessage = {
  id: string;
  kind: InternalKind;
  source: string;
  text: string;
  at: number;
  threadTs: string;
  from?: { channelId: string; threadTs: string };
};

/** What each kind is called on screen, and what it is. */
export const KIND_META: Record<InternalKind, { icon: string; label: string; hint: string }> = {
  tell: { icon: "📨", label: "tell", hint: "an internal steer another thread sent into this one's session" },
  brief: { icon: "📎", label: "brief", hint: "a note another thread left, read on this thread's next turn" },
  watch: { icon: "👁", label: "watch", hint: "a watch handing the thread back to its session" },
  nudge: { icon: "🫧", label: "nudge", hint: "the bot nudging this thread's session (stale promise or voice drift)" },
  orca: { icon: "🐋", label: "orca question", hint: "an Orca worker's question put to this thread's session" },
  loop: { icon: "🔁", label: "loop", hint: "a scheduled loop's run" },
};

/** Collapsed preview length of a hidden message's text. */
export const PREVIEW_CHARS = 220;

export const previewOf = (text: string): { shown: string; cut: boolean } => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? { shown: `${flat.slice(0, PREVIEW_CHARS)}…`, cut: true } : { shown: flat, cut: text.includes("\n") };
};

export type TimelineEntry<M extends { ts: string }> =
  | { type: "slack"; at: number; message: M }
  | { type: "internal"; at: number; message: InternalMessage };

const tsMs = (ts: string): number => Number(ts) * 1000 || 0;

/**
 * The hidden messages to put on a timeline. `threadTs` limits it to one thread;
 * `since` (ms) drops anything older than the oldest Slack message on screen
 * while more history is still to load, so a note never floats above a page it
 * does not belong to; `filter` is the console's text search.
 */
export const pickInternal = (
  items: readonly InternalMessage[],
  opts: { threadTs?: string; since?: number; filter?: string },
): InternalMessage[] => {
  const needle = opts.filter?.trim().toLowerCase() ?? "";
  return items.filter(
    (m) =>
      (opts.threadTs === undefined || m.threadTs === opts.threadTs) &&
      (opts.since === undefined || m.at >= opts.since) &&
      (!needle || m.text.toLowerCase().includes(needle) || m.source.toLowerCase().includes(needle)),
  );
};

/** Slack messages and hidden ones in one time order; on a tie the Slack message comes first. */
export const mergeTimeline = <M extends { ts: string }>(messages: readonly M[], internal: readonly InternalMessage[]): TimelineEntry<M>[] => {
  const all: TimelineEntry<M>[] = [
    ...messages.map((message): TimelineEntry<M> => ({ type: "slack", at: tsMs(message.ts), message })),
    ...internal.map((message): TimelineEntry<M> => ({ type: "internal", at: message.at, message })),
  ];
  // Array#sort is stable: equal times keep Slack ahead of hidden, each in its own order.
  return all.sort((a, b) => a.at - b.at);
};

/** Where a message from this thread sits: the oldest Slack message's time on the page, when older pages remain. */
export const oldestOnScreen = (messages: readonly { ts: string }[], hasOlder: boolean): number | undefined =>
  hasOlder && messages.length > 0 ? Math.min(...messages.map((m) => tsMs(m.ts))) : undefined;
