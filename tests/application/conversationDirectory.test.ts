import { describe, expect, test } from "bun:test";
import { createConversationDirectory, type ConversationListPage } from "../../src/application/conversationDirectory.ts";
import type { SlackMember } from "../../src/domain/slackMembers.ts";

const person = (id: string, name: string): SlackMember => ({ id, handle: name.toLowerCase(), realName: name, displayName: "", title: "", email: "", avatar: "", deleted: false, isBot: false });

const channels: ConversationListPage[] = [
  { conversations: [{ id: "C1", name: "ops", kind: "channel" }], nextCursor: "p2" },
  { conversations: [{ id: "C2", name: "dev-ops", kind: "channel" }, { id: "G1", name: "secret", kind: "group" }] },
];
const dms: ConversationListPage = { conversations: [{ id: "D1", name: "", kind: "im", userId: "U1" }, { id: "D2", name: "", kind: "im", userId: "U2" }] };

const setup = (opts: { fail?: () => boolean } = {}) => {
  let now = 0;
  const calls: string[] = [];
  const dir = createConversationDirectory({
    clock: () => now,
    ttlMs: 1000,
    listPage: async (what, cursor) => {
      calls.push(`${what}:${cursor ?? ""}`);
      if (opts.fail?.()) throw new Error("slack down");
      return what === "dms" ? dms : channels[cursor ? 1 : 0]!;
    },
  });
  return { dir, calls, tick: (ms: number) => (now += ms) };
};

describe("conversation directory", () => {
  test("finds channels on every page, name starts first, with the # and kind", async () => {
    const { dir } = setup();
    expect(await dir.search("ops", [], 10)).toEqual([
      { id: "C1", name: "#ops", kind: "channel", lastActive: 0 },
      { id: "C2", name: "#dev-ops", kind: "channel", lastActive: 0 },
    ]);
    expect((await dir.search("#sec", [], 10)).map((c) => [c.id, c.kind])).toEqual([["G1", "group"]]);
  });

  test("finds the DM of each matching person, in the people's order, and none for a person without a DM", async () => {
    const { dir } = setup();
    const found = await dir.search("a", [person("U2", "Bea"), person("U9", "Nodm"), person("U1", "Ann")], 10);
    expect(found.filter((c) => c.kind === "im").map((c) => [c.id, c.name])).toEqual([["D2", "@Bea"], ["D1", "@Ann"]]);
  });

  test("a blank query finds nothing and reads nothing; the limit cuts", async () => {
    const { dir, calls } = setup();
    expect(await dir.search("  #", [], 10)).toEqual([]);
    expect(calls).toEqual([]);
    expect(await dir.search("ops", [], 1)).toHaveLength(1);
  });

  test("lists are held until the ttl, then read again; channels only read DMs when there are people", async () => {
    const { dir, calls, tick } = setup();
    await dir.search("ops", [], 10);
    await dir.search("dev", [], 10);
    expect(calls).toEqual(["channels:", "channels:p2"]);
    tick(1001);
    await dir.search("ops", [person("U1", "Ann")], 10);
    expect(calls.slice(2).sort()).toEqual(["channels:", "channels:p2", "dms:"]);
  });

  test("concurrent searches share one sweep, and a failed refresh keeps serving the last good list", async () => {
    let down = false;
    const { dir, calls, tick } = setup({ fail: () => down });
    await Promise.all([dir.search("ops", [], 10), dir.search("dev", [], 10)]);
    expect(calls).toEqual(["channels:", "channels:p2"]);
    tick(1001);
    down = true;
    expect((await dir.search("ops", [], 10)).map((c) => c.id)).toEqual(["C1", "C2"]);
  });

  test("a list that was never read throws", async () => {
    const { dir } = setup({ fail: () => true });
    await expect(dir.search("ops", [], 10)).rejects.toThrow("slack down");
  });
});
