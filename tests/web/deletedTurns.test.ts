import { describe, expect, test } from "bun:test";
import { deletedOnSlack, turnTime, type DbTurn } from "../../web/src/deletedTurns.ts";
import { KIND_LEGEND, slackKind } from "../../web/src/consoleKinds.ts";
import { mergeTimeline } from "../../web/src/internalTimeline.ts";

const turn = (over: Partial<DbTurn> & { id: string }): DbTurn => ({ role: "user", userId: "U1", text: "x", at: 1_000_000, ts: "", threadTs: "", ...over });
const slack = (ts: string, text: string, own = false) => ({ ts, text, own });

describe("deleted on Slack", () => {
  test("a person's turn is found by its Slack ts: on the page it is fine, off the page it is deleted", () => {
    const page = [slack("100.1", "kept")];
    const turns = [turn({ id: "a", ts: "100.1", text: "kept" }), turn({ id: "b", ts: "100.2", text: "gone" })];
    expect(deletedOnSlack(page, turns).map((t) => t.id)).toEqual(["b"]);
  });

  test("a user turn with no ts cannot be judged and is left alone", () => {
    expect(deletedOnSlack([], [turn({ id: "a", ts: "" })])).toEqual([]);
  });

  test("the bot's reply is found by its opening words, however Slack shows them (mrkdwn, footer, case, emoji)", () => {
    const text = "**Done.** The deploy went out at 10:42, see <https://x.dev|the run> for details and logs.";
    const page = [slack("5.0", "*Done.* The deploy went out at 10:42, see <https://x.dev|the run> for details and logs.\n_Jarvis · updated 10:42_", true)];
    expect(deletedOnSlack(page, [turn({ id: "r", role: "assistant", userId: "assistant", text })])).toEqual([]);
  });

  test("a reply nobody posted any more is deleted, and only the bot's own Slack messages count as its reply", () => {
    const text = "Here is the long answer you asked about earlier today";
    const reply = turn({ id: "r", role: "assistant", userId: "assistant", text });
    expect(deletedOnSlack([slack("5.0", "something else", true)], [reply]).map((t) => t.id)).toEqual(["r"]);
    expect(deletedOnSlack([slack("5.0", text, false)], [reply]).map((t) => t.id)).toEqual(["r"]);
    expect(deletedOnSlack([slack("5.0", text, true)], [reply])).toEqual([]);
  });

  test("a reply with no words to compare is not called deleted", () => {
    expect(deletedOnSlack([], [turn({ id: "r", role: "assistant", text: "👍 ..." })])).toEqual([]);
  });

  test("nothing older than the oldest message on screen is judged while older pages remain", () => {
    const since = 200_000; // ms
    const turns = [
      turn({ id: "old-user", ts: "150.0", at: 250_000 }), // its message is on a page not loaded yet
      turn({ id: "old-reply", role: "assistant", text: "an answer from the past", at: 150_000 }),
      turn({ id: "new-user", ts: "300.0", at: 300_500 }),
    ];
    expect(deletedOnSlack([], turns, since).map((t) => t.id)).toEqual(["new-user"]);
    expect(deletedOnSlack([], turns).map((t) => t.id)).toEqual(["old-user", "old-reply", "new-user"]);
  });

  test("a turn is placed by its Slack message's time, else by when it was stored", () => {
    expect(turnTime(turn({ id: "a", ts: "100.5", at: 999 }))).toBe(100_500);
    expect(turnTime(turn({ id: "b", ts: "", at: 999 }))).toBe(999);
  });

  test("deleted turns take their place on the timeline between Slack and hidden messages", () => {
    const merged = mergeTimeline([slack("100.0", "a"), slack("300.0", "c")], [], [turn({ id: "d", ts: "200.0" })]);
    expect(merged.map((e) => e.type)).toEqual(["slack", "deleted", "slack"]);
    expect(mergeTimeline([slack("1.0", "a")], []).map((e) => e.type)).toEqual(["slack"]);
  });
});

describe("message kinds", () => {
  test("Jarvis, other bots and people are told apart; Jarvis wins over the bot flag", () => {
    expect(slackKind({ own: true, bot: true })).toBe("jarvis");
    expect(slackKind({ own: false, bot: true })).toBe("bot");
    expect(slackKind({ own: false })).toBe("person");
  });

  test("the legend names every kind once", () => {
    expect(KIND_LEGEND.map((k) => k.kind).sort()).toEqual(["bot", "deleted", "internal", "jarvis", "person"]);
    expect(new Set(KIND_LEGEND.map((k) => k.label)).size).toBe(KIND_LEGEND.length);
  });
});
