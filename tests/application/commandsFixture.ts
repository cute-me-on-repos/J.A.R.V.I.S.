/** Shared deps and fakes for the command tests, split across several files. */

import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import type { ClaudeTokenPort } from "../../src/application/claudeTokens.ts";
import { type CommandDeps } from "../../src/application/commands.ts";
import { adapterDepsOf } from "../../src/application/commands/shared.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import type { LlmPort } from "../../src/application/ports.ts";
import type { InteractiveAction, SlackAdminPort, SlackMessage } from "../../src/application/slackAdmin.ts";
import { noticeFingerprint } from "../../src/domain/noticeFingerprint.ts";

export const OWNER = "U0OWNER0001";

export let db: DbClient;
export const actor = (over: Partial<AllowedUser> = {}): AllowedUser => ({
  slackId: OWNER,
  role: "owner",
  displayName: "Kai",
  addedBy: "system",
  createdAt: 0,
  ...over,
});

export const llm: LlmPort = { complete: async () => "drafted answer" };

export type SlackCalls = {
  posts: { channel: string; text: string; threadTs?: string; by?: string }[];
  reactions: string[];
  removed: { channel: string; ts: string }[];
  buttons: string[];
  settled: { channel: string; ts: string; text: string }[];
  /** `updateInteractive`: a notice rewritten with its buttons kept, as `actionId:label`. */
  updated: { channel: string; ts: string; text: string; buttons: string[] }[];
  /** The blocks each interactive message currently shows, by `channel:ts`, shaped as the real adapter writes them. */
  blocks: Record<string, unknown[]>;
  removeError?: Error;
};

/** The blocks the real adapter posts for a notice: a section, its buttons, the signature footer. */
export const noticeBlocks = (text: string, actions: readonly InteractiveAction[]): unknown[] => [
  { type: "section", text: { type: "mrkdwn", text } },
  {
    type: "actions",
    elements: actions.map((a) => ({ type: "button", action_id: a.actionId, text: { type: "plain_text", text: a.label }, value: a.value })),
  },
  { type: "context", elements: [{ type: "mrkdwn", text: "signature" }] },
];

export const fakeSlack = (calls: SlackCalls, thread: SlackMessage[] = []): SlackAdminPort => ({
  listConversations: async () => [],
  history: async () => ({ messages: [] }),
  replies: async () => thread,
  update: async () => {},
  remove: async (channel, ts) => {
    if (calls.removeError) throw calls.removeError;
    calls.removed.push({ channel, ts });
  },
  post: async (channel, text, threadTs) => {
    calls.posts.push({ channel, text, threadTs });
  },
  postDm: async (userId, text) => {
    calls.posts.push({ channel: userId, text });
    return { channel: userId, ts: `dm-${calls.posts.length}` };
  },
  postDmInteractive: async (userId, text, actions) => {
    calls.posts.push({ channel: userId, text });
    calls.buttons.push(...actions.map((a) => `${a.actionId}:${a.value}`));
    const blocks = noticeBlocks(text, actions);
    const ts = `notice-${calls.posts.length}`;
    calls.blocks[`${userId}:${ts}`] = blocks;
    return { channel: userId, ts, fingerprint: noticeFingerprint(blocks) };
  },
  postInteractive: async (channel, text, actions, threadTs, by) => {
    calls.posts.push({ channel, text, threadTs, ...(by ? { by } : {}) });
    calls.buttons.push(...actions.map((a) => `${a.actionId}:${a.value}`));
    const blocks = noticeBlocks(text, actions);
    const ts = `interactive-${calls.posts.length}`;
    calls.blocks[`${channel}:${ts}`] = blocks;
    return { channel, ts, fingerprint: noticeFingerprint(blocks) };
  },
  postMenu: async () => undefined,
  settleInteractive: async (channel, ts, text) => {
    calls.settled.push({ channel, ts, text });
  },
  updateInteractive: async (channel, ts, text, actions) => {
    calls.updated.push({ channel, ts, text, buttons: actions.map((a) => `${a.actionId}:${a.label}`) });
    const blocks = noticeBlocks(text, actions);
    calls.blocks[`${channel}:${ts}`] = blocks;
    return noticeFingerprint(blocks);
  },
  addReactions: async (_c, _ts, names) => {
    calls.reactions.push(...names);
    return names.length;
  },
  botUserId: async () => "UBOT",
  resolveNames: async () => ({}),
});

export let slackCalls: SlackCalls;

export const threadMsg = (text: string): SlackMessage => ({
  ts: "1.1",
  userId: "U1",
  userName: "Kai",
  text,
  replyCount: 0,
  own: false,
  mentionsBot: false,
});

/**
 * Everyone has a Claude token, so tests about review mechanics are not all
 * about the token gate. The gate has its own describe block, with its own store.
 */
export const everyoneHasToken = (): ClaudeTokenPort => ({
  get: () => `sk-ant-oat01-${"t".repeat(48)}`,
  has: () => true,
  set: () => {},
  remove: () => {},
  count: () => 1,
  list: () => [],
  asked: () => false,
  markAsked: () => {},
});

export const build = (thread: SlackMessage[] = [threadMsg("hi there")]): CommandDeps => {
  db = openDatabase(":memory:");
  slackCalls = { posts: [], reactions: [], removed: [], buttons: [], settled: [], updated: [], blocks: {} };
  const deps: CommandDeps = {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    learnings: createLearningsRepo(db),
    llm,
    promptContext: () => ({ botName: "Jarvis", learnings: [] }),
    botInfo: () => ({ botName: "Jarvis", model: "claude-cli (opus)" }),
    clock: () => 42,
    ownerSlackId: OWNER,
    slack: fakeSlack(slackCalls, thread),
    draft: async () => "an AI-drafted reply",
    claudeTokens: everyoneHasToken(),
  };
  // The adapter is read per call, so a test that sets `adapterStore` after `build` is honoured.
  deps.learningApproval = {
    learnings: deps.learnings!,
    adapter: () => adapterDepsOf(deps),
    slack: deps.slack,
    clock: deps.clock,
    ownerSlackId: OWNER,
  };
  return deps;
};
