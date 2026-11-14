import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createThreadBriefRepo } from "../../src/infrastructure/db/threadBriefRepo.ts";

describe("hidden-message queries", () => {
  const add = (r: ReturnType<typeof createMessageRepo>, content: string, over: { role?: "user" | "assistant"; threadTs?: string; channelId?: string; at?: number } = {}) =>
    r.append({ channelId: over.channelId ?? "C1", slackUserId: "U1", role: over.role ?? "user", content, threadTs: over.threadTs ?? "" }, over.at ?? 1);

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

  test("LIKE wildcards in a prefix match only themselves", () => {
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
});
