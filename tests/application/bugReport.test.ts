import { describe, expect, test } from "bun:test";
import { dispatchCommand, listCommandInfo, type CommandDeps } from "../../src/application/commands.ts";
import { createBugReportRepo } from "../../src/infrastructure/db/bugReportRepo.ts";
import { seededBook } from "../../src/domain/roleSeed.ts";
import { DEDUPE_MS, MAX_PER_DAY } from "../../src/domain/bugReport.ts";
import { OWNER, actor, build, db, slackCalls } from "./commandsFixture.ts";

const LINK = "https://acme.slack.com/archives/C1/p1700000000000100";
const REPORT = `bug-report --thread ${LINK} --issue "reply posted twice" --summary "the retry re-sent the message" --plan "dedupe on message ts"`;

const setup = () => {
  const base = build();
  const bugReports = createBugReportRepo(db);
  const clock = { t: 1_000_000_000 };
  const deps: CommandDeps = {
    ...base,
    bugReports,
    clock: () => clock.t,
    roles: seededBook({ commands: listCommandInfo().map((c) => ({ name: c.name, minRole: c.minRole })) }),
  };
  return { deps, bugReports, clock };
};

/** The brain's own turn, in a pal's thread unless said otherwise. */
const run = (deps: CommandDeps, line: string, who = actor({ slackId: "U0PAL000001", role: "pal" }), channel = "C1") =>
  dispatchCommand(deps, who, channel, line, { fromBrainRun: true });

describe("bug-report command", () => {
  test("DMs the owner the link, issue, cause and plan with Approve / Reject", async () => {
    const { deps, bugReports } = setup();
    const out = await run(deps, REPORT);
    expect(out).toContain("Bug #1 sent to the owner");
    expect(slackCalls.posts).toHaveLength(1);
    const post = slackCalls.posts[0]!;
    expect(post.channel).toBe(OWNER);
    expect(post.text).toContain(`<${LINK}|the thread>`);
    expect(post.text).toContain("reply posted twice");
    expect(post.text).toContain("the retry re-sent the message");
    expect(post.text).toContain("dedupe on message ts");
    expect(slackCalls.buttons).toEqual(["jv:bug-report:approve:1", "jv:bug-report:reject:1"]);
    expect(bugReports.get(1)).toMatchObject({ state: "pending", reportedIn: "C1", noticeChannel: OWNER, noticeTs: "notice-1" });
  });

  test("a typed line is refused for every role, the owner included, and sends nothing", async () => {
    const { deps, bugReports } = setup();
    for (const role of ["pal", "executer", "admin", "owner"] as const) {
      expect(await dispatchCommand(deps, actor({ slackId: `U-${role}`, role }), "C1", REPORT)).toContain("is internal");
    }
    expect(await dispatchCommand(deps, actor(), "C1", "bug-report approve 1")).toContain("is internal");
    expect(slackCalls.posts).toHaveLength(0);
    expect(bugReports.countSince(0)).toBe(0);
  });

  test("the same thread and issue is not sent twice within a day, but is again after it", async () => {
    const { deps, bugReports, clock } = setup();
    await run(deps, REPORT);
    const again = await run(deps, REPORT.replace("reply posted twice", "Reply  posted TWICE!"));
    expect(again).toContain("Already reported as bug #1");
    expect(slackCalls.posts).toHaveLength(1);
    // a different issue in the same thread is its own report
    await run(deps, REPORT.replace("reply posted twice", "wrong channel"));
    expect(slackCalls.posts).toHaveLength(2);
    clock.t += DEDUPE_MS + 1;
    await run(deps, REPORT);
    expect(slackCalls.posts).toHaveLength(3);
    expect(bugReports.countSince(0)).toBe(3);
  });

  test("a decided report still blocks a repeat inside the day", async () => {
    const { deps } = setup();
    await run(deps, REPORT);
    deps.bugReports!.decide(1, "rejected", 1);
    expect(await run(deps, REPORT)).toContain("Already reported as bug #1 (rejected)");
    expect(slackCalls.posts).toHaveLength(1);
  });

  test("past the daily cap the owner is not asked any more", async () => {
    const { deps } = setup();
    for (let i = 0; i < MAX_PER_DAY; i++) await run(deps, REPORT.replace("reply posted twice", `issue ${i}`));
    expect(slackCalls.posts).toHaveLength(MAX_PER_DAY);
    expect(await run(deps, REPORT.replace("reply posted twice", "one more"))).toContain("most bug reports");
    expect(slackCalls.posts).toHaveLength(MAX_PER_DAY);
  });

  test("needs a Slack link, an issue and a plan, and reads nothing else", async () => {
    const { deps, bugReports } = setup();
    expect(await run(deps, `bug-report --thread https://example.com/x --issue a --plan b`)).toContain("Slack link");
    expect(await run(deps, `bug-report --thread ${LINK} --plan b`)).toContain("`--issue`");
    expect(await run(deps, `bug-report --thread ${LINK} --issue a`)).toContain("`--plan`");
    expect(await run(deps, `bug-report --thread ${LINK} --issue a --plan b --bogus 1`)).toContain("do not know `--bogus`");
    expect(await run(deps, `bug-report --thread ${LINK} --issue a --plan`)).toContain("needs a value");
    expect(slackCalls.posts).toHaveLength(0);
    expect(bugReports.countSince(0)).toBe(0);
  });

  test("free text cannot mention or link: it is cleaned like a journey title", async () => {
    const { deps } = setup();
    await run(deps, `bug-report --thread <${LINK}|link> --issue "<!channel> broke <@U123>" --plan "fix it"`);
    const text = slackCalls.posts[0]!.text;
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<@U123>");
  });

  test("a DM that cannot go out leaves no record, so a retry is not called a repeat", async () => {
    const { deps, bugReports } = setup();
    const broken = { ...deps, slack: { ...deps.slack!, postDmInteractive: async () => { throw new Error("slack down"); } } };
    expect(await run(broken, REPORT)).toContain("could not DM the owner");
    expect(bugReports.countSince(0)).toBe(0);
    expect(await run(deps, REPORT)).toContain("sent to the owner");
  });
});

describe("bug-report approve / reject from a turn", () => {
  test("an owner-actor brain run in the owner's DM, with no press, cannot approve or reject", async () => {
    const { deps, bugReports } = setup();
    await run(deps, REPORT);
    for (const line of ["bug-report approve 1", "bug-report reject 1", "bug-report APPROVE 1"]) {
      expect(await run(deps, line, actor(), OWNER)).toContain("only by the owner pressing the button");
    }
    expect(bugReports.get(1)?.state).toBe("pending");
    expect(slackCalls.settled).toHaveLength(0);
  });

  test("nobody else's brain run can decide it either", async () => {
    const { deps, bugReports } = setup();
    await run(deps, REPORT);
    for (const role of ["pal", "executer", "admin"] as const) {
      expect(await run(deps, "bug-report approve 1", actor({ slackId: `U-${role}`, role }), OWNER)).toContain("pressing the button");
    }
    expect(bugReports.get(1)?.state).toBe("pending");
  });
});
