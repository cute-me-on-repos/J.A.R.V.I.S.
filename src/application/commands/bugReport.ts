/** `bug-report`: the bot tells its owner about a bug in itself. See domain/bugReport.ts. */

import {
  BUG_APPROVE_ACTION,
  BUG_REJECT_ACTION,
  DEDUPE_MS,
  MAX_PER_DAY,
  approvalText,
  fingerprintOf,
  parseReport,
} from "../../domain/bugReport.ts";
import { SIGNATURES } from "../../domain/messageFooter.ts";
import { logAndIgnore } from "../ignoredError.ts";
import { type CommandDef } from "./shared.ts";

export const BUG_REPORT_COMMANDS: readonly CommandDef[] = [
  {
    name: "bug-report",
    // Mine alone: refused unless the brain runs it in its own turn, so no role or grant is involved.
    internal: true,
    minRole: "pal",
    usage: '--thread <slack link> --issue "<what is wrong>" --summary "<the cause>" --plan "<how to fix>"',
    summary: "tell the owner about a bug in myself and ask whether to fix it",
    run: async ({ deps, channelId, rest, prefix }) => {
      const repo = deps.bugReports;
      if (!repo) return "I have nowhere to keep bug reports right now.";
      const now = deps.clock();
      const word = rest.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

      // Approve / Reject are the owner's button presses, decided in code (application/bugReportApproval.ts):
      // a command run in a turn cannot tell a press from an owner turn in the same DM, so it refuses both.
      if (word === "approve" || word === "reject") {
        return "A bug report is approved or rejected only by the owner pressing the button on the DM I sent. Nothing changed.";
      }

      const read = parseReport(rest);
      if (!read.ok) return `${read.error}. \`${prefix} bug-report --thread <link> --issue "..." --summary "..." --plan "..."\``;
      const input = read.input;
      const fingerprint = fingerprintOf(input);
      const since = now - DEDUPE_MS;
      const twin = repo.recent(fingerprint, since);
      if (twin) return `Already reported as bug #${twin.id} (${twin.state}): the owner is not asked twice. Tell the person the owner was asked.`;
      if (repo.countSince(since) >= MAX_PER_DAY) return "I have already sent the owner the most bug reports I send in a day, so this one was not sent.";
      if (!deps.slack?.postDmInteractive) return "I cannot DM the owner from here, so the bug report was not sent.";

      const b = repo.add({ fingerprint, threadLink: input.thread, issue: input.issue, summary: input.summary, plan: input.plan, reportedIn: channelId }, now);
      const notice = await deps.slack
        .postDmInteractive(
          deps.ownerSlackId,
          approvalText(b.id, input),
          [
            { actionId: BUG_APPROVE_ACTION, label: "Approve", value: String(b.id), style: "primary" },
            { actionId: BUG_REJECT_ACTION, label: "Reject", value: String(b.id), style: "danger" },
          ],
          SIGNATURES.bugReport,
        )
        .catch(logAndIgnore("bug report post"));
      if (!notice) {
        repo.discard(b.id);
        return "I could not DM the owner, so the bug report was not sent.";
      }
      repo.setNotice(b.id, notice.channel, notice.ts);
      return `Bug #${b.id} sent to the owner for approval. Do not fix it yourself until they approve.`;
    },
  },
];
