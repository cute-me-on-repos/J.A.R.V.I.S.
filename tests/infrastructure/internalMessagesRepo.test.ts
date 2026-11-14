import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createThreadBriefRepo } from "../../src/infrastructure/db/threadBriefRepo.ts";
import { cleanInboundText } from "../../src/domain/conversation.ts";
import { STEER_PREFIXES, turnToInternal } from "../../src/domain/internalMessages.ts";
import { syntheticTs } from "../../src/domain/slackLinks.ts";
import { tellPrompt } from "../../src/domain/tellPrompt.ts";

describe("hidden-message queries", () => {
  const add = (r: ReturnType<typeof createMessageRepo>, content: string, over: { role?: "user" | "assistant"; threadTs?: string; channelId?: string; at?: number; slackTs?: string } = {}) =>
    r.append({ channelId: over.channelId ?? "C1", slackUserId: "U1", role: over.role ?? "user", content, ...(over.slackTs ? { slackTs: over.slackTs } : {}), threadTs: over.threadTs ?? "" }, over.at ?? 1);

  test("userTurnsStartingWith finds user turns by prefix, per channel and optionally per thread, oldest first", () => {
    const r = createMessageRepo(openDatabase(":memory:"));
    add(r, "[loop 1] a", { threadTs: "1.1", at: 1 });
    add(r, "hello", { threadTs: "1.1", at: 2 });
    add(r, "[orca question] b", { threadTs: "2.2", at: 3 });
    add(r, "[loop 1] bot said", { role: "assistant", at: 4 });
    add(r, "[loop 1] other channel", { channelId: "C2", at: 5 });
    expect(r.userTurnsStartingWith("C1", ["[loop ", "[orca question]"], 10).map((m) => m.content)).toEqual(["[loop 1] a", "[orca question] b"]);
    expect(r.userTurnsStartingWith("C1", ["[loop ", "[orca question]"], 10, "2.2").map((m) => m.content)).toEqual(["[orca question] b"]);
    expect(r.userTurnsStartingWith("C1", ["[loop ", "[orca question]"], 1).map((m) => m.content)).toEqual(["[orca question] b"]);
    expect(r.userTurnsStartingWith("C1", [], 10)).toEqual([]);
  });

  test("a prefix matches exactly (case counts) and finds turns stored the way handleMessage stores them: cleaned text, synthetic slack_ts", () => {
    const r = createMessageRepo(openDatabase(":memory:"));
    add(r, "I stopped waiting after lunch", { at: 1 });
    add(r, "i stopped waiting after lunch", { at: 2 });
    add(r, cleanInboundText(tellPrompt("UTESTER", "restart it\nnow")), { at: 3, threadTs: "1.1", slackTs: syntheticTs(3000) });
    const found = r.userTurnsStartingWith("C1", STEER_PREFIXES, 10);
    expect(found.map((m) => m.content.slice(0, 26))).toEqual(["I stopped waiting after lu", "[tell from another thread]"]);
    expect(turnToInternal(found[1]!)).toMatchObject({ kind: "tell", source: "UTESTER", text: "restart it now" });
  });

  test("wildcard characters in a prefix match only themselves", () => {
    const r = createMessageRepo(openDatabase(":memory:"));
    add(r, "100% sure");
    add(r, "100x sure");
    add(r, "a_b");
    add(r, "axb");
    expect(r.userTurnsStartingWith("C1", ["100%"], 10).map((m) => m.content)).toEqual(["100% sure"]);
    expect(r.userTurnsStartingWith("C1", ["a_"], 10).map((m) => m.content)).toEqual(["a_b"]);
  });

  test("toChannel returns the briefs written to a channel, or to one of its threads", () => {
    const repo = createThreadBriefRepo(openDatabase(":memory:"));
    const b = (text: string, toChannel: string, toThread: string) => ({ fromChannel: "D0", fromThread: "1.1", toChannel, toThread, author: "U1", text });
    repo.add(b("one", "C1", "2.2"), 10);
    repo.add(b("two", "C1", "3.3"), 20);
    repo.add(b("other", "C9", "2.2"), 30);
    expect(repo.toChannel("C1", 10).map((x) => x.text)).toEqual(["one", "two"]);
    expect(repo.toChannel("C1", 10, "3.3").map((x) => x.text)).toEqual(["two"]);
    expect(repo.toChannel("C1", 1).map((x) => x.text)).toEqual(["two"]);
  });

  test("toChannel applies a time window before the newest-N cut, so an old window still finds its own briefs", () => {
    const repo = createThreadBriefRepo(openDatabase(":memory:"));
    const b = (text: string) => ({ fromChannel: "D0", fromThread: "1.1", toChannel: "C1", toThread: "2.2", author: "U1", text });
    for (const [text, at] of [["a", 10], ["b", 20], ["c", 30], ["d", 40]] as const) repo.add(b(text), at);
    expect(repo.toChannel("C1", 1, undefined, { before: 30 }).map((x) => x.text)).toEqual(["b"]);
    expect(repo.toChannel("C1", 10, undefined, { since: 20, before: 40 }).map((x) => x.text)).toEqual(["b", "c"]);
    expect(repo.toChannel("C1", 10, "2.2", { since: 30 }).map((x) => x.text)).toEqual(["c", "d"]);
  });

  test("a time window cuts steer turns and DB turns: since inclusive, before exclusive, newest N kept", () => {
    const r = createMessageRepo(openDatabase(":memory:"));
    add(r, "[loop 1] a", { at: 10 });
    add(r, "[loop 1] b", { at: 20 });
    add(r, "[loop 1] c", { at: 30 });
    expect(r.userTurnsStartingWith("C1", ["[loop "], 10, undefined, { since: 20 }).map((m) => m.content)).toEqual(["[loop 1] b", "[loop 1] c"]);
    expect(r.userTurnsStartingWith("C1", ["[loop "], 10, undefined, { since: 15, before: 30 }).map((m) => m.content)).toEqual(["[loop 1] b"]);
    add(r, "hi", { at: 40, slackTs: "1.1" });
    expect(r.turnsInRange("C1", 2, undefined, { since: 20 }).map((m) => m.content)).toEqual(["[loop 1] c", "hi"]);
  });

  test("turnsInRange: a channel view holds turns outside a thread and a thread's root; a thread view holds that thread only", () => {
    const r = createMessageRepo(openDatabase(":memory:"));
    add(r, "top level", { at: 1, slackTs: "5.5" });
    add(r, "root of a thread", { at: 2, slackTs: "7.7", threadTs: "7.7" });
    add(r, "reply in it", { at: 3, role: "assistant", threadTs: "7.7" });
    add(r, "other channel", { at: 4, channelId: "C2" });
    expect(r.turnsInRange("C1", 10).map((m) => m.content)).toEqual(["top level", "root of a thread"]);
    expect(r.turnsInRange("C1", 10, "7.7").map((m) => m.content)).toEqual(["root of a thread", "reply in it"]);
    expect(r.turnsInRange("C1", 10, "7.7").map((m) => m.slackUserId)).toEqual(["U1", "U1"]);
    expect(r.turnsInRange("C1", 0)).toEqual([]);
  });
});
