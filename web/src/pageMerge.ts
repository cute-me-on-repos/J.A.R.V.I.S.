/**
 * Merging pages of a conversation as they arrive: an older page when the user
 * scrolls up, the newest page again on a refresh. Pure; messages are told
 * apart by their Slack `ts`, which is unique per conversation.
 */

const tsOf = (m: { ts: string }): number => Number(m.ts) || 0;

/** An older page in front of what is loaded; a message in both is kept once (the loaded copy). */
export const prependOlder = <M extends { ts: string }>(current: readonly M[], older: readonly M[]): M[] => {
  const have = new Set(current.map((m) => m.ts));
  return [...older.filter((m) => !have.has(m.ts)), ...current].sort((a, b) => tsOf(a) - tsOf(b));
};

/**
 * The newest page read again. Everything the page covers is replaced by it (so a
 * message deleted in Slack leaves, an edited one is updated); older pages the
 * user already scrolled through stay. An empty page is an empty conversation:
 * nothing is kept.
 */
export const replaceNewest = <M extends { ts: string }>(current: readonly M[], newest: readonly M[]): M[] => {
  if (newest.length === 0) return [];
  const from = Math.min(...newest.map(tsOf));
  return [...current.filter((m) => tsOf(m) < from), ...newest].sort((a, b) => tsOf(a) - tsOf(b));
};

/** True when older pages are loaded below the newest page: messages that page does not cover. */
export const loadedBelow = (current: readonly { ts: string }[], newest: readonly { ts: string }[]): boolean =>
  newest.length > 0 && current.some((m) => tsOf(m) < Math.min(...newest.map(tsOf)));

/** True when a scroll position is close enough to the bottom to count as "following the conversation". */
export const nearBottom = (scrollTop: number, clientHeight: number, scrollHeight: number, slack = 48): boolean =>
  scrollHeight - (scrollTop + clientHeight) <= slack;

/** True when a scroll position has reached the top, where older messages are fetched. */
export const nearTop = (scrollTop: number, slack = 80): boolean => scrollTop <= slack;

/** Rows (hidden messages, DB turns) by id, in time order: `add` joins `current`, an id in both keeps the newer copy. */
export const mergeRows = <R extends { id: string; at: number }>(current: readonly R[], add: readonly R[]): R[] => {
  const byId = new Map(current.map((r) => [r.id, r]));
  for (const r of add) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
};

/**
 * The newest window read again: rows from `head` on are replaced by `fresh` (a
 * row that vanished is dropped), older windows already loaded stay. `head`
 * undefined means the window was everything, so everything is replaced.
 */
export const replaceFrom = <R extends { id: string; at: number }>(current: readonly R[], fresh: readonly R[], head: number | undefined): R[] =>
  mergeRows(head === undefined ? [] : current.filter((r) => r.at < head), fresh);
