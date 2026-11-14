/**
 * Messages the bot's DB still holds that Slack no longer has: a turn stored in
 * memory whose Slack message was deleted. Pure: the Slack page and the DB copy
 * go in, the turns Slack lacks come out.
 *
 * A person's turn is stored with the ts of the Slack message it came from, so it
 * is found by ts. The bot's own replies are not stored with one, so a reply is
 * found by its words (letters and digits only, the opening of it, link targets
 * dropped on both sides: Slack's mrkdwn conversion, the footer and emoji must
 * not matter; the server computes the stored side before redacting). A reply edited in
 * Slack after the fact reads as a different message, and a turn stored under a
 * synthetic ts (a continued turn, say) never had a Slack message: both show as
 * deleted. That is the honest limit of a DB that does not keep the reply's ts.
 */

/** What `/api/memory/turns` returns: one ordinary stored turn. */
export type DbTurn = {
  id: string;
  role: "user" | "assistant";
  userId: string;
  text: string;
  at: number;
  ts: string;
  threadTs: string;
  /** A reply's opening as letters, worked out by the server from the raw (unredacted) text; "" for a person's turn. */
  opening: string;
};

type OnSlack = { ts: string; text: string; own: boolean };

const tsMs = (ts: string): number => Number(ts) * 1000 || 0;

/**
 * A reply is stored when its turn ENDS but posted when it STARTS streaming, so
 * its Slack message can sit just past the oldest page loaded: a reply this close
 * to the edge is not judged.
 */
const EDGE_MARGIN_MS = 10 * 60_000;

/** The letters of a text with what Slack rewrites left out: the same steps as the server's `lettersOf` (src/domain/internalMessages.ts) - change both together. */
export const letters = (s: string): string =>
  s
    .replace(/\[([^\]]*)\]\([^)\s]*\)/g, "$1")
    .replace(/<[^<>|\s]+\|([^<>]*)>/g, "$1")
    .replace(/<(?:https?:|mailto:)[^<>\s]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/https?:\/\/\S+/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * The DB turns Slack does not have. `since` (ms) is the oldest message on screen
 * while older ones remain unloaded - a turn before it may simply be on a page not
 * fetched yet, so it is never judged.
 */
export const deletedOnSlack = (slack: readonly OnSlack[], turns: readonly DbTurn[], since?: number): DbTurn[] => {
  const tsSet = new Set(slack.map((m) => m.ts));
  const ownText = slack.filter((m) => m.own).map((m) => letters(m.text));
  return turns.filter((t) => {
    if (since !== undefined && (t.ts ? tsMs(t.ts) : t.at) < since + (t.role === "assistant" ? EDGE_MARGIN_MS : 0)) return false;
    if (t.role === "user") return !!t.ts && !tsSet.has(t.ts);
    const opening = t.opening;
    return opening.length > 0 && !ownText.some((text) => text.includes(opening));
  });
};

/** When a DB turn happened, for placing it on the timeline: its Slack message's time, else when it was stored. */
export const turnTime = (t: DbTurn): number => (t.ts ? tsMs(t.ts) : t.at);
