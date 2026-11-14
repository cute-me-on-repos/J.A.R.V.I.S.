import { describe, expect, test } from "bun:test";
import { briefToInternal, classifyTurn, MAX_INTERNAL_TEXT, sortInternal, STEER_PREFIXES, turnToDbTurn, turnToInternal } from "../../src/domain/internalMessages.ts";
import { cleanInboundText } from "../../src/domain/conversation.ts";
import { steerPrompt, tellPrompt } from "../../src/domain/tellPrompt.ts";
import { nudgeText } from "../../src/domain/stalePromise.ts";
import { driftNudge } from "../../src/domain/voiceDrift.ts";
import { questionTurnText } from "../../src/domain/orcaQuestions.ts";
import { loopTurnText } from "../../src/domain/loop.ts";
import { gaveUpMessage, readyMessage, workerEventLine } from "../../src/domain/watch.ts";

const turn = (content: string, over: Partial<Parameters<typeof turnToInternal>[0]> = {}) =>
  turnToInternal({ id: 7, role: "user", content, createdAt: 1000, threadTs: "5.5", ...over });

describe("internal message classification", () => {
  test("a tell keeps the sender and only what was said, not the do-not-answer wrapper", () => {
    // what the DB holds: the prompt after `cleanInboundText` collapsed its line breaks
    const m = turn(cleanInboundText(tellPrompt("UTESTER", "restart the migration\nand report")));
    expect(m).toMatchObject({ id: "turn:7", kind: "tell", source: "UTESTER", text: "restart the migration and report", at: 1000, threadTs: "5.5" });
  });

  test("the stale-promise sweep's steer is a nudge, not a tell", () => {
    const m = turn(cleanInboundText(steerPrompt("The stale-promise sweep (a timer in the bot, not a person) sent this", nudgeText(600_000))));
    expect(m).toMatchObject({ kind: "nudge", source: "stale-promise sweep" });
    expect(m?.text).toContain("promised further work 10 minutes ago");
    expect(m?.text).not.toContain("Do NOT acknowledge");
  });

  test("a voice-drift nudge, an orca question and a loop fire each have their kind", () => {
    expect(turn(driftNudge([{ rule: "emoji", excerpt: "x" } as never]))).toMatchObject({ kind: "nudge", source: "voice-drift check" });
    const q = { id: "msg_1", runId: "run_1", dispatchId: "ctx_1", taskId: "task_1", question: "which branch?", options: ["a", "b"] };
    expect(turn(questionTurnText(q))).toMatchObject({ kind: "orca", source: "orca worker question" });
    expect(turn(loopTurnText(12, "every 1h", "check the queue", "queue"))).toMatchObject({ kind: "loop", source: "loop 12" });
  });

  test("every watch hand-back opening is a watch", () => {
    const worker = (kind: string, detail: string) => workerEventLine("ctx_abc123", { kind, detail });
    const texts = [
      readyMessage("promote it", 60_000),
      readyMessage("promote it", 60_000, worker("finished", "done")),
      readyMessage("promote it", 60_000, worker("died", "exit 1")),
      readyMessage("promote it", 60_000, worker("waiting", "needs input")),
      readyMessage("promote it", 60_000, "task_x1 blocked"),
      gaveUpMessage("promote it", 60_000, "it never became ready"),
    ];
    for (const t of texts) expect(turn(t)).toMatchObject({ kind: "watch", source: "watch hand-back" });
  });

  test("an ordinary message, an assistant turn and a look-alike are not hidden messages", () => {
    expect(turn("hey can you check the deploy")).toBeUndefined();
    expect(turn("Orca workers are great")).toBeUndefined();
    expect(turn("[tell] not the marker")).toBeUndefined();
    expect(turn(tellPrompt("U1", "x"), { role: "assistant" })).toBeUndefined();
    expect(classifyTurn("")).toBeUndefined();
  });

  test("a turn outside any thread has an empty threadTs", () => {
    expect(turn(tellPrompt("U1", "x"), { threadTs: undefined })?.threadTs).toBe("");
  });

  test("credential shapes never leave: tokens in a tell or a brief are redacted", () => {
    const m = turn(tellPrompt("U1", "use xoxb-1234567890-abcdefghij and ghp_abcdefghijklmnopqrstuv"));
    expect(m?.text).toBe("use [redacted] and [redacted]");
    const b = briefToInternal({ id: 3, fromChannel: "D1", fromThread: "1.1", toThread: "2.2", author: "U2", text: "jvwk_abcdefghijklmnopqr is the ticket", createdAt: 5 });
    expect(b.text).toBe("[redacted] is the ticket");
  });

  test("a huge text is cut, with a note", () => {
    const m = turn(tellPrompt("U1", "x".repeat(MAX_INTERNAL_TEXT + 50)));
    expect(m?.text.startsWith("x".repeat(MAX_INTERNAL_TEXT))).toBe(true);
    expect(m?.text).toContain("50 more characters cut");
  });

  test("a brief names its author and the thread it came from; sort is oldest first with stable ties", () => {
    const b = briefToInternal({ id: 1, fromChannel: "D1", fromThread: "1.1", toThread: "2.2", author: "U2", text: "note", createdAt: 500 });
    expect(b).toEqual({ id: "brief:1", kind: "brief", source: "U2", text: "note", at: 500, threadTs: "2.2", from: { channelId: "D1", threadTs: "1.1" } });
    const t = turn(tellPrompt("U1", "x"), { createdAt: 500, id: 2 });
    expect(sortInternal([t!, b, { ...b, id: "brief:0", at: 100 }]).map((m) => m.id)).toEqual(["brief:0", "brief:1", "turn:2"]);
  });

  test("every prefix the repo pre-filters on is one the classifier can accept", () => {
    expect(STEER_PREFIXES.length).toBeGreaterThan(5);
    expect(new Set(STEER_PREFIXES).size).toBe(STEER_PREFIXES.length);
  });
});

describe("turnToDbTurn: the DB copy of a message", () => {
  const stored = (over: Partial<{ role: string; content: string; slackTs: string; threadTs: string }> = {}) => ({
    id: 7,
    role: "user",
    content: "hello",
    createdAt: 5,
    slackUserId: "U1",
    ...over,
  });

  test("an ordinary turn keeps its author, ts and thread; secrets are redacted", () => {
    expect(turnToDbTurn(stored({ content: "token xoxb-1234567890-abcdefghij", slackTs: "1.5", threadTs: "1.5" }))).toEqual({
      id: "turn:7",
      role: "user",
      userId: "U1",
      text: "token [redacted]",
      at: 5,
      ts: "1.5",
      threadTs: "1.5",
    });
    expect(turnToDbTurn(stored({ role: "assistant" }))).toMatchObject({ role: "assistant", ts: "", threadTs: "" });
  });

  test("steer turns are hidden messages, not DB copies, and a NO_REPLY was never posted", () => {
    expect(turnToDbTurn(stored({ content: tellPrompt("U9", "ship it") }))).toBeUndefined();
    expect(turnToDbTurn(stored({ role: "assistant", content: "NO_REPLY" }))).toBeUndefined();
    // a person typing a look-alike in an assistant row is still the bot's text
    expect(turnToDbTurn(stored({ role: "assistant", content: tellPrompt("U9", "x") }))).toBeDefined();
  });

  test("a long turn is clipped", () => {
    expect(turnToDbTurn(stored({ content: "a".repeat(MAX_INTERNAL_TEXT + 50) }))!.text).toContain("more characters cut");
  });
});
