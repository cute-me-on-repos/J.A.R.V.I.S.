/**
 * The workspace's channels and DMs, for the console sidebar's search.
 *
 * The sidebar lists what the bot is a member of (one `users.conversations`
 * page), so a channel or DM outside that page cannot be found by filtering it.
 * Typing searches here instead: `conversations.list` read page by page into
 * memory and refreshed at most every `DIRECTORY_TTL_MS` (typing does not cost a
 * sweep per keystroke; concurrent searches share one), a failed refresh keeps
 * serving the last good list. DMs are found through the people directory: a
 * person matches, and their existing DM (from the `im` list) is the result.
 */
import type { Clock } from "./ports.ts";
import { fold, type SlackMember } from "../domain/slackMembers.ts";

export const CONVERSATION_TTL_MS = 10 * 60_000;
const MAX_PAGES = 30;

/** One row of `conversations.list`. `userId` is set on a DM only. */
export type ListedConversation = {
  readonly id: string;
  readonly name: string;
  readonly kind: "channel" | "group" | "im" | "mpim";
  readonly userId?: string;
};

export type ConversationListPage = { readonly conversations: readonly ListedConversation[]; readonly nextCursor?: string };

/** What a search finds: the sidebar's own row shape. */
export type FoundConversation = { id: string; name: string; kind: ListedConversation["kind"]; lastActive: number };

export type ConversationDirectoryDeps = {
  readonly clock: Clock;
  /** One page of channels (public and private) or of DMs (`im`, `mpim`). */
  readonly listPage: (what: "channels" | "dms", cursor?: string) => Promise<ConversationListPage>;
  readonly ttlMs?: number;
};

export type ConversationDirectory = {
  /**
   * Channels whose name matches `query`, then DMs with the `people` given (the
   * members the caller already matched), best first. Throws only when no list
   * was ever read.
   */
  readonly search: (query: string, people: readonly SlackMember[], limit: number) => Promise<FoundConversation[]>;
};

const memberName = (m: SlackMember): string => m.displayName || m.realName || m.handle || m.id;

export const createConversationDirectory = (deps: ConversationDirectoryDeps): ConversationDirectory => {
  const ttl = deps.ttlMs ?? CONVERSATION_TTL_MS;
  const held = new Map<"channels" | "dms", { list: readonly ListedConversation[]; at: number }>();
  const inFlight = new Map<"channels" | "dms", Promise<readonly ListedConversation[]>>();

  const sweep = async (what: "channels" | "dms"): Promise<readonly ListedConversation[]> => {
    const all: ListedConversation[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await deps.listPage(what, cursor);
      all.push(...res.conversations);
      cursor = res.nextCursor || undefined;
      if (!cursor) break;
    }
    return all;
  };

  const current = (what: "channels" | "dms"): Promise<readonly ListedConversation[]> => {
    const hit = held.get(what);
    if (hit && deps.clock() - hit.at < ttl) return Promise.resolve(hit.list);
    let running = inFlight.get(what);
    if (!running) {
      running = sweep(what)
        .then((list) => {
          held.set(what, { list, at: deps.clock() });
          return list;
        })
        .catch((e: unknown) => {
          // Stale beats empty; only a list never read has nothing to show.
          const stale = held.get(what);
          if (!stale) throw e;
          held.set(what, { list: stale.list, at: deps.clock() });
          return stale.list;
        })
        .finally(() => {
          inFlight.delete(what);
        });
      inFlight.set(what, running);
    }
    return running;
  };

  return {
    search: async (query, people, limit) => {
      const q = fold(query).replace(/^[#@]/, "");
      if (!q) return [];
      const [channels, dms] = await Promise.all([current("channels"), people.length > 0 ? current("dms") : Promise.resolve([])]);
      const rank = (name: string): number => (fold(name) === q ? 3 : fold(name).startsWith(q) ? 2 : fold(name).includes(q) ? 1 : 0);
      const byChannel = channels
        .map((c) => ({ c, s: rank(c.name) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name))
        .map(({ c }): FoundConversation => ({ id: c.id, name: `#${c.name.replace(/^#/, "")}`, kind: c.kind, lastActive: 0 }));
      // In the people's order: the caller ranked them, the DM list has no order worth keeping.
      const dmByUser = new Map(dms.flatMap((d) => (d.userId ? [[d.userId, d] as const] : [])));
      const byDm = people.flatMap((m): FoundConversation[] => {
        const dm = dmByUser.get(m.id);
        return dm ? [{ id: dm.id, name: `@${memberName(m)}`, kind: "im", lastActive: 0 }] : [];
      });
      return [...byChannel, ...byDm].slice(0, Math.max(0, limit));
    },
  };
};
