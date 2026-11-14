/**
 * The owner's Approve / Reject on a bug report, decided in code.
 *
 * A press is handled by its own Slack listener (the kit listener skips
 * `jv:bug-report:`), never by a model turn: a brain turn that runs as the owner
 * in the owner's DM (a loop, a page it read) would pass every check a command
 * could make, so the bot could approve its own fix with nobody pressing. Only a
 * press carries `body.user.id` and the channel/ts of the message pressed.
 */
import {
  BUG_APPROVE_ACTION,
  BUG_REJECT_ACTION,
  approvedBrief,
  settledText,
  type BugReportInput,
} from "../domain/bugReport.ts";
import { SIGNATURES } from "../domain/messageFooter.ts";
import type { BugReport, BugReportRepo } from "../infrastructure/db/bugReportRepo.ts";
import { logAndIgnore } from "./ignoredError.ts";
import type { Clock } from "./ports.ts";
import type { SlackAdminPort } from "./slackAdmin.ts";

export type BugReportApprovalDeps = {
  bugReports: BugReportRepo;
  slack?: SlackAdminPort;
  clock: Clock;
  ownerSlackId: string;
};

export type BugPressOutcome =
  | { readonly kind: "unknown" }
  | { readonly kind: "refused"; readonly why: "not-owner" | "wrong-message"; readonly id: number }
  | { readonly kind: "decided"; readonly id: number; readonly state: BugReport["state"] }
  /** Approved just now: the owner's DM thread to run the fix in, and what to tell the turn. */
  | { readonly kind: "approved"; readonly id: number; readonly channel: string; readonly threadTs: string; readonly brief: string }
  | { readonly kind: "rejected"; readonly id: number };

const inputOf = (b: BugReport): BugReportInput => ({ thread: b.threadLink, issue: b.issue, summary: b.summary, plan: b.plan });

export const decideBugReportPress = async (
  deps: BugReportApprovalDeps,
  press: { slackUserId: string; actionId: string; value: string; channel?: string; messageTs?: string },
): Promise<BugPressOutcome> => {
  if (press.actionId !== BUG_APPROVE_ACTION && press.actionId !== BUG_REJECT_ACTION) return { kind: "unknown" };
  const id = Number(press.value);
  const b = Number.isInteger(id) ? deps.bugReports.get(id) : undefined;
  if (!b) return { kind: "unknown" };
  if (press.slackUserId !== deps.ownerSlackId) return { kind: "refused", why: "not-owner", id: b.id };
  // Only the message the question went out on: the stored channel and ts, never ones the press makes up.
  if (!b.noticeChannel || !b.noticeTs || press.channel !== b.noticeChannel || press.messageTs !== b.noticeTs) {
    return { kind: "refused", why: "wrong-message", id: b.id };
  }
  if (b.state !== "pending") return { kind: "decided", id: b.id, state: b.state };
  const kind = press.actionId === BUG_APPROVE_ACTION ? "approved" : "rejected";
  if (!deps.bugReports.decide(b.id, kind, deps.clock())) return { kind: "decided", id: b.id, state: b.state };
  await deps.slack
    ?.settleInteractive(b.noticeChannel, b.noticeTs, settledText(b.id, inputOf(b), kind, press.slackUserId), SIGNATURES.bugReport)
    .catch(logAndIgnore("bug report settle"));
  return kind === "approved"
    ? { kind: "approved", id: b.id, channel: b.noticeChannel, threadTs: b.noticeTs, brief: approvedBrief(b.id, inputOf(b)) }
    : { kind: "rejected", id: b.id };
};

/** What an owner who pressed the wrong thing is told, privately. */
export const bugPressNotice = (o: BugPressOutcome): string | undefined =>
  o.kind === "refused"
    ? o.why === "not-owner"
      ? "Only the owner decides a bug report. Nothing changed."
      : `Bug #${o.id} is decided from the DM it was asked in. Nothing changed.`
    : o.kind === "decided"
      ? `Bug #${o.id} is already ${o.state}. Nothing changed.`
      : undefined;
