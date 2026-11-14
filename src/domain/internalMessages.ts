/**
 * The messages the bot steers sessions with that never reach Slack, as the
 * console's timeline shows them.
 *
 * Two stores hold them. Every internal TURN (`tell`, a stale-promise or drift
 * nudge, a watch hand-back, an Orca worker's question, a scheduled loop) goes
 * through `respond` like a typed message, so `handleMessage` stores its prompt
 * as a `user` row in `messages`: nothing marks the row, so a kind is told apart
 * by the prompt's own opening, the same constants the senders build it from.
 * A `brief` has its own table (`thread_briefs`). Not stored anywhere: a
 * `mindful reply|continue` (the text is the person's own, or the failed turn's
 * request, so it reads like a typed message) and what the steered turn answers
 * (a `NO_REPLY` is an ordinary assistant row).
 *
 * Pure: the repos find the rows, this decides what they are and what is safe
 * to show.
 */
import { DRIFT_NUDGE_MARK } from "./voiceDrift.ts";
import { ORCA_QUESTION_TAG } from "./orcaQuestions.ts";
import { TELL_PREFIX } from "./tellPrompt.ts";
import { redactSecrets } from "./toolVisibility.ts";

export type InternalKind = "tell" | "brief" | "watch" | "nudge" | "orca" | "loop";

/** One hidden message. `at` is when it was stored (ms); `id` is stable per source row. */
export type InternalMessage = {
  readonly id: string;
  readonly kind: InternalKind;
  /** Who or what sent it: a Slack id, or the part of the bot that did. */
  readonly source: string;
  /** What it said, secrets redacted and clipped. */
  readonly text: string;
  readonly at: number;
  /** The thread it went into (`""` for a turn outside any thread). */
  readonly threadTs: string;
  /** A brief only: the thread that wrote it. */
  readonly from?: { readonly channelId: string; readonly threadTs: string };
};

/** One message is never worth more than this on screen; the rest is cut. */
export const MAX_INTERNAL_TEXT = 8_000;

const LOOP_TAG = /^\[loop (\d+)\]/;
const TELL_SENDER = /^\[tell from another thread\] <@([A-Z0-9]+)> sent this/;
const STALE_SENDER = "The stale-promise sweep";
const STEER_TAIL = "\n\n- Act on it.";

/** A watch hand-back's openings: `readyMessage` (plain, or led by the worker's state) and `gaveUpMessage`. */
const WATCH_OPENINGS: readonly RegExp[] = [
  /^The thing you were waiting for is ready \(after /,
  /^Orca worker ctx_[A-Za-z0-9_-]+ (FINISHED|DIED|is IDLE|is WAITING FOR INPUT) after /,
  /^Orca shows task_[A-Za-z0-9_-]+(, task_[A-Za-z0-9_-]+)* as BLOCKED/,
  /^I stopped waiting after /,
];

/** The prompts' openings, for a repo to pre-filter rows with before `classifyTurn` decides. */
export const STEER_PREFIXES: readonly string[] = [
  TELL_PREFIX,
  ORCA_QUESTION_TAG,
  "[loop ",
  DRIFT_NUDGE_MARK,
  "The thing you were waiting for is ready (after ",
  "Orca worker ctx_",
  "Orca shows task_",
  "I stopped waiting after ",
];

const clip = (s: string): string => (s.length > MAX_INTERNAL_TEXT ? `${s.slice(0, MAX_INTERNAL_TEXT)}\n... (${s.length - MAX_INTERNAL_TEXT} more characters cut)` : s);

/** What a person (or the bot) said inside a steer prompt, without the "do not answer it in Slack" wrapper. */
const steerBody = (content: string): string => {
  const start = content.indexOf("\n\n");
  const end = content.lastIndexOf(STEER_TAIL);
  return start >= 0 && end > start ? content.slice(start + 2, end) : content;
};

/** The kind and sender of a stored user turn, or undefined for an ordinary message. */
export const classifyTurn = (content: string): { kind: InternalKind; source: string; text: string } | undefined => {
  const c = content.trimStart();
  if (c.startsWith(TELL_PREFIX)) {
    const body = steerBody(c);
    if (c.slice(TELL_PREFIX.length).trimStart().startsWith(STALE_SENDER)) return { kind: "nudge", source: "stale-promise sweep", text: body };
    return { kind: "tell", source: TELL_SENDER.exec(c)?.[1] ?? "another thread", text: body };
  }
  if (c.startsWith(DRIFT_NUDGE_MARK)) return { kind: "nudge", source: "voice-drift check", text: c };
  if (c.startsWith(ORCA_QUESTION_TAG)) return { kind: "orca", source: "orca worker question", text: c };
  const loop = LOOP_TAG.exec(c);
  if (loop) return { kind: "loop", source: `loop ${loop[1]}`, text: c };
  if (WATCH_OPENINGS.some((re) => re.test(c))) return { kind: "watch", source: "watch hand-back", text: c };
  return undefined;
};

export type StoredTurn = { readonly id: number; readonly role: string; readonly content: string; readonly createdAt: number; readonly threadTs?: string };

/** A stored turn as a hidden message; undefined when it is an ordinary one. */
export const turnToInternal = (m: StoredTurn): InternalMessage | undefined => {
  if (m.role !== "user") return undefined;
  const found = classifyTurn(m.content);
  if (!found) return undefined;
  return {
    id: `turn:${m.id}`,
    kind: found.kind,
    source: found.source,
    text: clip(redactSecrets(found.text)),
    at: m.createdAt,
    threadTs: m.threadTs ?? "",
  };
};

export type StoredBrief = {
  readonly id: number;
  readonly fromChannel: string;
  readonly fromThread: string;
  readonly toThread: string;
  readonly author: string;
  readonly text: string;
  readonly createdAt: number;
};

export const briefToInternal = (b: StoredBrief): InternalMessage => ({
  id: `brief:${b.id}`,
  kind: "brief",
  source: b.author || "unknown",
  text: clip(redactSecrets(b.text)),
  at: b.createdAt,
  threadTs: b.toThread,
  from: { channelId: b.fromChannel, threadTs: b.fromThread },
});

/** Oldest first, ties by id so the order never flickers between reloads. */
export const sortInternal = (items: readonly InternalMessage[]): InternalMessage[] =>
  [...items].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
