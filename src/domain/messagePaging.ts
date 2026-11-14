/**
 * Paging a conversation backward in time, for the console's infinite scroll.
 *
 * Slack's `conversations.replies` only reads forward (oldest first), so a thread
 * is read whole and cut here: the newest `limit` replies older than `before`.
 * Pure, so the cut is testable without Slack.
 */

export type ReplyPage<M> = {
  /** Oldest first. */
  readonly messages: readonly M[];
  /** More replies exist before the first one returned. */
  readonly hasMore: boolean;
};

const tsOf = (ts: string): number => Number(ts) || 0;

/**
 * The newest `limit` messages strictly older than `before` (a Slack ts; all of
 * them when omitted), oldest first. The thread's root - the first message - is
 * always part of the oldest page, never cut off on its own.
 */
export const pageReplies = <M extends { ts: string }>(all: readonly M[], limit: number, before?: string): ReplyPage<M> => {
  const size = Math.max(1, Math.floor(limit));
  const older = before === undefined ? all : all.filter((m) => tsOf(m.ts) < tsOf(before));
  const messages = older.slice(-size);
  return { messages, hasMore: older.length > messages.length };
};
