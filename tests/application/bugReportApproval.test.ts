import { describe, expect, test } from "bun:test";
import { dispatchCommand, listCommandInfo, type CommandDeps } from "../../src/application/commands.ts";
import { bugPressNotice, decideBugReportPress, type BugReportApprovalDeps } from "../../src/application/bugReportApproval.ts";
import { BUG_APPROVE_ACTION, BUG_REJECT_ACTION } from "../../src/domain/bugReport.ts";
import { seededBook } from "../../src/domain/roleSeed.ts";
import { createBugReportRepo } from "../../src/infrastructure/db/bugReportRepo.ts";
import { OWNER, actor, build, db, slackCalls } from "./commandsFixture.ts";

const LINK = "https://acme.slack.com/archives/C1/p1700000000000100";
const REPORT = `bug-report --thread ${LINK} --issue "reply posted twice" --summary "the retry re-sent it" --plan "dedupe on message ts"`;

const setup = async () => {
  const base = build();
  const bugReports = createBugReportRepo(db);
  const deps: CommandDeps = {
    ...base,
    bugReports,
    clock: () => 1_000_000_000,
    roles: seededBook({ commands: listCommandInfo().map((c) => ({ name: c.name, minRole: c.minRole })) }),
  };
  await dispatchCommand(deps, actor({ slackId: "U0PAL000001", role: "pal" }), "C1", REPORT, { fromBrainRun: true });
  const approval: BugReportApprovalDeps = { bugReports, slack: deps.slack, clock: () => 2_000_000_000, ownerSlackId: OWNER };
  return { deps, bugReports, approval };
};

const press = (over: Partial<Parameters<typeof decideBugReportPress>[1]> = {}) => ({
  slackUserId: OWNER,
  actionId: BUG_APPROVE_ACTION,
  value: "1",
  channel: OWNER,
  messageTs: "notice-1",
  ...over,
});

describe("decideBugReportPress", () => {
  test("the owner's approve press settles the message and hands back the fix for the notice's thread", async () => {
    const { bugReports, approval } = await setup();
    const out = await decideBugReportPress(approval, press());
    expect(out).toMatchObject({ kind: "approved", id: 1, channel: OWNER, threadTs: "notice-1" });
    if (out.kind !== "approved") throw new Error("not approved");
    expect(out.brief).toContain("approved by the owner");
    expect(out.brief).toContain(LINK);
    expect(out.brief).toContain("dedupe on message ts");
    expect(bugReports.get(1)).toMatchObject({ state: "approved", decidedAt: 2_000_000_000 });
    expect(slackCalls.settled).toHaveLength(1);
    expect(slackCalls.settled[0]).toMatchObject({ channel: OWNER, ts: "notice-1" });
    expect(slackCalls.settled[0]!.text).toContain("approved by");
  });

  test("the owner's reject press settles the message and starts nothing", async () => {
    const { bugReports, approval } = await setup();
    expect(await decideBugReportPress(approval, press({ actionId: BUG_REJECT_ACTION }))).toEqual({ kind: "rejected", id: 1 });
    expect(bugReports.get(1)?.state).toBe("rejected");
    expect(slackCalls.settled[0]!.text).toContain("rejected by");
  });

  test("a press by anyone but the owner is refused and changes nothing", async () => {
    const { bugReports, approval } = await setup();
    for (const slackUserId of ["U0PAL000001", "U-admin", "U-executer"]) {
      const out = await decideBugReportPress(approval, press({ slackUserId }));
      expect(out).toEqual({ kind: "refused", why: "not-owner", id: 1 });
      expect(bugPressNotice(out)).toContain("Only the owner");
    }
    expect(bugReports.get(1)?.state).toBe("pending");
    expect(slackCalls.settled).toHaveLength(0);
  });

  test("a press from another channel or message ts is refused", async () => {
    const { bugReports, approval } = await setup();
    for (const over of [{ channel: "C1" }, { messageTs: "other-ts" }, { channel: undefined }, { messageTs: undefined }]) {
      const out = await decideBugReportPress(approval, press(over));
      expect(out).toEqual({ kind: "refused", why: "wrong-message", id: 1 });
      expect(bugPressNotice(out)).toContain("decided from the DM");
    }
    expect(bugReports.get(1)?.state).toBe("pending");
    expect(slackCalls.settled).toHaveLength(0);
  });

  test("an already decided report refuses a second press, either way, and settles once", async () => {
    const { bugReports, approval } = await setup();
    await decideBugReportPress(approval, press());
    const again = await decideBugReportPress(approval, press({ actionId: BUG_REJECT_ACTION }));
    expect(again).toEqual({ kind: "decided", id: 1, state: "approved" });
    expect(bugPressNotice(again)).toContain("already approved");
    expect(await decideBugReportPress(approval, press())).toMatchObject({ kind: "decided" });
    expect(bugReports.get(1)?.state).toBe("approved");
    expect(slackCalls.settled).toHaveLength(1);
  });

  test("an unknown id, a non-numeric value or another action id is ignored", async () => {
    const { approval } = await setup();
    expect(await decideBugReportPress(approval, press({ value: "9" }))).toEqual({ kind: "unknown" });
    expect(await decideBugReportPress(approval, press({ value: "x" }))).toEqual({ kind: "unknown" });
    expect(await decideBugReportPress(approval, press({ actionId: "jv:other" }))).toEqual({ kind: "unknown" });
    expect(slackCalls.settled).toHaveLength(0);
  });
});
