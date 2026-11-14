import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  fmtSlackTs,
  get,
  post,
  type HistoryPage,
  type MemoryChannel,
  type MemoryThread,
  type SlackConversation,
  type SlackMessage,
  type ThreadPage,
} from "../api.ts";
import { Mrkdwn, useSlackNames } from "../ui/mrkdwn.tsx";
import { MessagePane } from "../ui/messagePane.tsx";
import { copyText, messagePermalink, type PermalinkRef } from "../ui/permalink.ts";
import { InternalRow } from "../internalMessages.tsx";
import { DeletedRow } from "../deletedMessages.tsx";
import { mergeTimeline, oldestOnScreen, pickInternal, type InternalMessage } from "../internalTimeline.ts";
import { deletedOnSlack, type DbTurn } from "../deletedTurns.ts";
import { consolePath, parseConsolePath } from "../consoleNav.ts";
import { KIND_LEGEND, slackKind } from "../consoleKinds.ts";
import { loadedBelow, prependOlder, replaceNewest } from "../pageMerge.ts";
import { useDbRows } from "../useDbRows.ts";

type Mode = "all" | "own" | "mentions";
type Editing = { ts: string; text: string } | null;
type OpenThread = { root: string; messages: SlackMessage[]; hasMore: boolean };

/** Messages per page, for history and thread replies alike. */
const PAGE = 50;
/** How long typing in the sidebar filter rests before Slack is asked. */
const SEARCH_DEBOUNCE_MS = 300;

const threadKey = (channel: string, root: string) => `${channel}:${root}`;
const enc = encodeURIComponent;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const historyUrl = (ch: string, before?: string) => `slack/history?channel=${enc(ch)}&limit=${PAGE}${before === undefined ? "" : `&cursor=${enc(before)}`}`;
const threadUrl = (ch: string, root: string, before?: string) =>
  `slack/thread?channel=${enc(ch)}&ts=${enc(root)}&limit=${PAGE}${before === undefined ? "" : `&before=${enc(before)}`}`;

const ago = (ms: number): string => {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const glyph = (c: SlackConversation) => (c.kind === "im" ? "@" : c.kind === "mpim" ? "@@" : c.kind === "group" ? "🔒" : "#");

/** The colour key: one swatch per kind of message the timeline can hold. */
function Legend() {
  return (
    <div className="legend" aria-label="message colours">
      {KIND_LEGEND.map((k) => (
        <span key={k.kind} className={`legend-item k-${k.kind}`} title={k.hint}>
          <span className="kind-dot" aria-hidden />
          {k.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The bot's own memory (its DB, not Slack) for one channel or thread: "saved"
 * with the number of stored turns, "cleared" once it was deleted here, or "not
 * in DB" when nothing was ever stored.
 */
function MemoryBadge({ count, cleared, what }: { count: number; cleared: boolean; what: string }) {
  if (count > 0) {
    return (
      <span className="badge executer" title={`the bot's DB holds ${count} stored turn${count === 1 ? "" : "s"} for this ${what}`}>
        saved · {count}
      </span>
    );
  }
  return (
    <span className="badge member" title={cleared ? `this ${what}'s stored memory was deleted` : `nothing stored in the bot's DB for this ${what}`}>
      {cleared ? "cleared" : "not in DB"}
    </span>
  );
}

/**
 * Slack console - the web port of Jarvis's terminal message manager, as a small
 * Slack: channels and DMs on the left, the conversation on the right, a thread
 * taking over the right side full width. Edit/delete the bot's own messages,
 * reply, generate an AI draft, and see - and clear - what the bot's DB remembers
 * per channel/thread. The address bar is the state: `/console/<channel>` and
 * `/console/<channel>/<thread_ts>`.
 */
export function ConsolePage() {
  const params = useParams();
  const navigate = useNavigate();
  const splat = params["*"];
  const { channel, thread: threadRoot } = useMemo(() => parseConsolePath(splat), [splat]);

  const [convos, setConvos] = useState<SlackConversation[]>([]);
  /** Conversations the search found beyond the loaded list, and every one seen, so a name survives the filter being cleared. */
  const [found, setFound] = useState<SlackConversation[]>([]);
  const [seen, setSeen] = useState<Readonly<Record<string, SlackConversation>>>({});
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [convoFilter, setConvoFilter] = useState("");
  const [messages, setMessages] = useState<SlackMessage[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [historyLoaded, setHistoryLoaded] = useState(false);
  /** Which view an older-page request is running for (`channel/thread`), so the channel's and a thread's never block each other. */
  const [olderFor, setOlderFor] = useState("");
  /** Display only: a view is still arriving. Never disables a button, so a request that is dropped cannot lock the page. */
  const [loadingChannel, setLoadingChannel] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [thread, setThread] = useState<OpenThread | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [composer, setComposer] = useState("");
  const [threadComposer, setThreadComposer] = useState("");
  const [memChannels, setMemChannels] = useState<MemoryChannel[]>([]);
  const [memThreads, setMemThreads] = useState<MemoryThread[]>([]);
  /** Messages the bot steered sessions with that never reached Slack (tell, brief, ...), from its DB. */
  /** Turns the DB holds for this channel's own messages: the copy that shows what Slack deleted. */
  /** The open thread's own hidden messages and DB copy: asked for by thread, so an old thread is not cut by the channel's window. */
  const [showInternal, setShowInternal] = useState(true);
  /** Channels/threads whose stored memory was deleted from this page, to tell "cleared" from "never stored". */
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const [memoryError, setMemoryError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  /** Bumped to re-read the DB rows next to the Slack page (after a post, an edit, a refresh). */
  const [dbTick, setDbTick] = useState(0);
  /** Bumped when the user posts, so the pane follows them to the bottom. */
  const [bottomSignal, setBottomSignal] = useState(0);
  /** The workspace url, asked of the server once (cached there too); every link is then built here. */
  const workspace = useRef<Promise<string> | undefined>(undefined);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** What is on screen now, so an answer for a channel or thread the user already left is dropped, not shown. */
  const live = useRef({ channel: "", thread: "" });
  live.current = { channel, thread: threadRoot };
  /** What is loaded now, read by the reloads (outside a state updater, which must stay pure). */
  const loaded = useRef({ messages, thread });
  loaded.current = { messages, thread };

  const go = useCallback((ch: string, root?: string) => navigate(consolePath(ch, root)), [navigate]);

  const run = useCallback(async (fn: () => Promise<void>, note = "") => {
    setError("");
    setBusy(true);
    if (note) setStatus(note);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }, []);

  const remember = useCallback((list: readonly SlackConversation[]) => {
    setSeen((cur) => ({ ...cur, ...Object.fromEntries(list.map((c) => [c.id, c])) }));
  }, []);

  // The sidebar list; with no channel in the address, the most recently active one opens.
  useEffect(() => {
    run(async () => {
      const list = await get<SlackConversation[]>("slack/conversations");
      setConvos(list);
      remember(list);
      if (!live.current.channel && list[0]) navigate(consolePath(list[0].id), { replace: true });
    });
  }, [run, remember, navigate]);

  // The sidebar filter also asks Slack: a channel or DM that was never loaded is found by name, debounced.
  useEffect(() => {
    const q = convoFilter.trim();
    setSearchError("");
    if (!q) {
      setFound([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let stale = false;
    const timer = setTimeout(() => {
      get<{ conversations: SlackConversation[] }>(`slack/search?q=${enc(q)}`)
        .then((r) => {
          if (stale) return;
          setFound(r.conversations);
          remember(r.conversations);
        })
        .catch((e: unknown) => {
          if (stale) return;
          setFound([]);
          setSearchError(errText(e));
        })
        .finally(() => {
          if (!stale) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [convoFilter, remember]);

  /** The DB badges. Never fatal: when it fails only the badges go, Slack history still renders. */
  const loadBadges = useCallback(async (ch: string, isStale: () => boolean) => {
    try {
      const [chans, threads] = await Promise.all([get<MemoryChannel[]>("memory/channels"), get<MemoryThread[]>(`memory/threads?channel=${enc(ch)}`)]);
      if (isStale()) return;
      setMemChannels(chans);
      setMemThreads(threads);
      setMemoryError("");
    } catch (e) {
      if (!isStale()) setMemoryError(errText(e));
    }
  }, []);

  // Another channel: its own newest page, nothing carried over. Opening lands on the latest message.
  useEffect(() => {
    setMessages([]);
    setCursor(undefined);
    setHistoryLoaded(false);
    setMemThreads([]);
    setEditing(null);
    setError("");
    setLoadingChannel(!!channel);
    if (!channel) return;
    let stale = false;
    get<HistoryPage>(historyUrl(channel))
      .then((page) => {
        if (stale) return;
        setMessages(page.messages);
        setCursor(page.nextCursor);
        setHistoryLoaded(true);
      })
      .catch((e: unknown) => {
        if (!stale) setError(errText(e));
      })
      .finally(() => {
        if (!stale) setLoadingChannel(false);
      });
    void loadBadges(channel, () => stale);
    return () => {
      stale = true;
    };
  }, [channel, loadBadges]);

  /** The oldest Slack message on screen while older ones remain: the DB rows below it belong to pages not loaded yet. */
  const since = oldestOnScreen(messages, !!cursor);
  // The DB rows next to the Slack page (hidden messages, the DB copy), paged with it.
  const db = useDbRows(channel, "", historyLoaded, since, dbTick);
  const internal = db.internal;
  const dbTurns = db.turns;

  /** A page of the channel's older history (the Slack cursor), prepended with the reader's place kept by the pane. */
  const loadOlder = async () => {
    const ch = channel;
    const before = cursor;
    const mine = `${ch}/`;
    if (!before || olderFor === mine) return;
    setOlderFor(mine);
    try {
      const page = await get<HistoryPage>(historyUrl(ch, before));
      if (live.current.channel !== ch) return;
      setMessages((cur) => prependOlder(cur, page.messages));
      setCursor(page.nextCursor);
    } catch (e) {
      if (live.current.channel === ch) setError(errText(e));
    } finally {
      setOlderFor((cur) => (cur === mine ? "" : cur));
    }
  };

  // A thread (from the address): its newest page, full width. A request for a thread already left is dropped.
  useEffect(() => {
    setThread(null);
    setThreadComposer("");
    setLoadingThread(!!channel && !!threadRoot);
    if (!channel || !threadRoot) return;
    let stale = false;
    get<ThreadPage>(threadUrl(channel, threadRoot))
      .then((page) => {
        if (!stale) setThread({ root: threadRoot, messages: page.messages, hasMore: page.hasMore });
      })
      .catch((e: unknown) => {
        if (!stale) setError(errText(e));
      })
      .finally(() => {
        if (!stale) setLoadingThread(false);
      });
    return () => {
      stale = true;
    };
  }, [channel, threadRoot]);

  const threadSince = thread ? oldestOnScreen(thread.messages, thread.hasMore) : undefined;
  const threadDb = useDbRows(channel, threadRoot, !!thread, threadSince, dbTick);
  const threadInternal = threadDb.internal;
  const threadTurns = threadDb.turns;
  const internalError = db.error || threadDb.error;

  const loadOlderReplies = async () => {
    const ch = channel;
    const root = threadRoot;
    const before = thread?.messages[0]?.ts;
    const mine = `${ch}/${root}`;
    if (!thread || !before || olderFor === mine) return;
    setOlderFor(mine);
    try {
      const page = await get<ThreadPage>(threadUrl(ch, root, before));
      if (live.current.channel !== ch || live.current.thread !== root) return;
      setThread((cur) => (cur && cur.root === root ? { root, messages: prependOlder(cur.messages, page.messages), hasMore: page.hasMore } : cur));
    } catch (e) {
      if (live.current.channel === ch && live.current.thread === root) setError(errText(e));
    } finally {
      setOlderFor((cur) => (cur === mine ? "" : cur));
    }
  };

  /** Re-read the newest page of the channel; older pages already scrolled through stay. */
  const reloadChannel = async (ch: string) => {
    const [page] = await Promise.all([get<HistoryPage>(historyUrl(ch)), loadBadges(ch, () => live.current.channel !== ch)]);
    if (live.current.channel !== ch) return;
    // Older pages the user already scrolled through keep their cursor; a first page that is all there is takes the new one.
    if (!loadedBelow(loaded.current.messages, page.messages)) setCursor(page.nextCursor);
    setMessages((cur) => replaceNewest(cur, page.messages));
    setDbTick((n) => n + 1);
  };

  /** Re-read the newest page of the open thread, unless the user has moved on from it meanwhile. */
  const reloadThread = async (ch: string, root: string) => {
    const page = await get<ThreadPage>(threadUrl(ch, root));
    if (live.current.channel !== ch || live.current.thread !== root) return;
    const older = loaded.current.thread?.root === root ? loaded.current.thread : null;
    const keepsOlder = !!older && loadedBelow(older.messages, page.messages);
    setThread({
      root,
      messages: older ? replaceNewest(older.messages, page.messages) : page.messages,
      hasMore: older && keepsOlder ? older.hasMore : page.hasMore,
    });
    setDbTick((n) => n + 1);
  };

  const refreshAll = async (ch: string) => {
    await reloadChannel(ch);
    const root = live.current.thread;
    if (root && live.current.channel === ch) await reloadThread(ch, root);
  };

  const refresh = () => run(() => refreshAll(channel));

  const send = (threadTs?: string) => {
    const ch = channel;
    const body = threadTs ? threadComposer : composer;
    return run(async () => {
      await post("slack/post", { channel: ch, text: body, threadTs });
      if (live.current.channel !== ch) return;
      if (threadTs) {
        setThreadComposer("");
        await reloadThread(ch, threadTs);
      } else {
        setComposer("");
      }
      await reloadChannel(ch);
      setBottomSignal((n) => n + 1);
    }, "posting...");
  };

  const draft = (threadTs?: string) => {
    const ch = channel;
    return run(async () => {
      const { draft } = await post<{ draft: string }>("slack/draft", { channel: ch, threadTs });
      if (live.current.channel !== ch) return;
      if (threadTs) {
        if (live.current.thread === threadTs) setThreadComposer(draft);
      } else {
        setComposer(draft);
      }
    }, "drafting...");
  };

  const saveEdit = () => {
    const ch = channel;
    return run(async () => {
      if (!editing) return;
      await post("slack/update", { channel: ch, ts: editing.ts, text: editing.text });
      setEditing(null);
      await refreshAll(ch);
    }, "saving...");
  };

  /** Slack's "Copy link": the real permalink to a message, built locally, with a "copied" toast. */
  const copyLink = async (ref: Omit<PermalinkRef, "channel">) => {
    setError("");
    try {
      workspace.current ??= get<{ url: string | null }>("slack/workspace").then((w) => {
        if (!w.url) throw new Error("Slack gave no workspace url");
        return w.url;
      });
      const url = messagePermalink(await workspace.current, { channel, ...ref });
      if (!(await copyText(url))) throw new Error(`Could not copy - the link is ${url}`);
      setCopied("Link copied");
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(""), 1800);
    } catch (e) {
      workspace.current = undefined; // a failed lookup is retried on the next click
      setError(errText(e));
    }
  };

  const del = (m: SlackMessage) => {
    if (!confirm("Delete this message in Slack?")) return;
    const ch = channel;
    run(async () => {
      await post("slack/delete", { channel: ch, ts: m.ts });
      await refreshAll(ch);
    }, "deleting...");
  };

  /** Forget the bot's stored turns (and the sessions that would replay them) - never a Slack message. */
  const forget = (scope: "channel" | "thread", name: string, count: number, root?: string) => {
    if (scope === "thread" && !root) return; // never fall through to a channel-wide delete
    const what = scope === "thread" ? "this thread" : `the whole of ${name} (every thread in it)`;
    if (!confirm(`Delete ${count} stored turn${count === 1 ? "" : "s"} for ${what} from the bot's DB?\n\nThe bot forgets them. Nothing in Slack is touched.`)) return;
    const ch = channel;
    run(async () => {
      await post("conversation/clear", { channel: ch, ...(scope === "thread" ? { threadTs: root } : {}) });
      setCleared((cur) => new Set([...cur, scope === "thread" && root ? threadKey(ch, root) : ch]));
      await loadBadges(ch, () => live.current.channel !== ch);
      setDbTick((n) => n + 1);
    }, "deleting from DB...");
  };

  const needle = filter.trim().toLowerCase();
  const shown = messages.filter((m) => {
    if (mode === "own" && !m.own) return false;
    if (mode === "mentions" && !m.mentionsBot) return false;
    if (needle && !m.text.toLowerCase().includes(needle)) return false;
    return true;
  });

  const channelDeleted = useMemo(() => deletedOnSlack(messages, dbTurns, since), [messages, dbTurns, since]);
  const threadDeleted = useMemo(() => (thread ? deletedOnSlack(thread.messages, threadTurns, threadSince) : []), [thread, threadTurns, threadSince]);

  // The page is whole when its Slack messages and DB rows are all in; names are then asked for once.
  const ready = historyLoaded && db.loaded && (!threadRoot || (!!thread && threadDb.loaded));
  const slackNames = useSlackNames(
    [
      ...[...messages, ...(thread?.messages ?? [])].map((m) => m.text),
      // the senders and source channels of hidden messages, and the authors of DB-only ones, so no bare id is shown
      ...[...internal, ...threadInternal].flatMap((m) => [`<@${m.source}>`, ...(m.from ? [`<#${m.from.channelId}>`] : [])]),
      ...[...channelDeleted, ...threadDeleted].flatMap((t) => [t.text, ...(t.userId && t.role === "user" ? [`<@${t.userId}>`] : [])]),
      // a channel opened from the address that the list does not hold still gets its name
      ...(channel ? [`<#${channel}>`] : []),
    ],
    ready,
  );

  const known = (id: string): SlackConversation | undefined => convos.find((c) => c.id === id) ?? seen[id];
  /** A `<#C…>` pill opens that channel only when it is one the sidebar has seen. */
  const channelLink = (id: string) => (known(id) ? () => go(id) : undefined);

  const memByChannel = useMemo(() => new Map(memChannels.map((c) => [c.channelId, c])), [memChannels]);
  const memByThread = useMemo(() => new Map(memThreads.map((t) => [t.threadTs, t])), [memThreads]);
  const channelCount = memByChannel.get(channel)?.count ?? 0;
  const current = known(channel);
  const currentName = current ? `${glyph(current)} ${current.name}` : slackNames.channels[channel] ? `# ${slackNames.channels[channel]}` : channel;
  const threadCleared = (ch: string, root: string) => cleared.has(threadKey(ch, root)) || cleared.has(ch);
  const threadCount = threadRoot ? memByThread.get(threadRoot)?.count ?? 0 : 0;

  const lower = convoFilter.trim().toLowerCase();
  const local = convos.filter((c) => c.name.toLowerCase().includes(lower));
  const visible = [...local, ...found.filter((f) => !local.some((c) => c.id === f.id))];
  const groups: { title: string; items: SlackConversation[] }[] = [
    { title: "Channels", items: visible.filter((c) => c.kind === "channel" || c.kind === "group") },
    { title: "Direct messages", items: visible.filter((c) => c.kind === "im" || c.kind === "mpim") },
  ];

  /** Slack messages with the hidden and DB-only ones interleaved by time (the hidden ones go when "show internal" is off or a mode/filter excludes them). */
  const timeline = (msgs: readonly SlackMessage[], items: readonly InternalMessage[], deleted: readonly DbTurn[], threadTs?: string, hasOlder = false) => {
    const hidden = showInternal && mode === "all" ? pickInternal(items, { threadTs, since: oldestOnScreen(msgs, hasOlder), filter }) : [];
    const gone = mode === "all" ? deleted.filter((t) => !needle || t.text.toLowerCase().includes(needle)) : [];
    return mergeTimeline(msgs, hidden, gone);
  };

  const channelTimeline = timeline(shown, internal, channelDeleted, undefined, !!cursor);
  const threadTimeline = thread ? timeline(thread.messages, threadInternal, threadDeleted, thread.root, thread.hasMore) : [];

  const marker = (m: SlackMessage) =>
    m.own ? <span className="badge assistant" title="posted by Jarvis">✎</span> : m.mentionsBot ? <span className="badge user" title="mentions you">@</span> : <span className="mk-space" />;

  const Row = (m: SlackMessage, inThread = false) => {
    const stored = memByThread.get(m.threadTs ?? m.ts)?.count ?? 0;
    return (
      <div className={`msg k-${slackKind(m)}`} key={m.ts}>
        <div className="msg-head">
          <span className="kind-dot" aria-hidden />
          {marker(m)}
          <strong>{m.userId && m.userName !== m.userId ? `${m.userName} (${m.userId})` : m.userId ? `unknown (${m.userId})` : m.userName}</strong>
          <span className="muted">{fmtSlackTs(m.ts)}</span>
          <span className="msg-actions">
            {!inThread && <button className="link" onClick={() => go(channel, m.threadTs ?? m.ts)}>reply</button>}
            <button className="link" onClick={() => copyLink({ ts: m.ts, threadTs: m.threadTs })} title="copy the Slack link to this message">copy link</button>
            {m.own && <button className="link" onClick={() => setEditing({ ts: m.ts, text: m.text })}>edit</button>}
            {m.own && <button className="link danger-link" onClick={() => del(m)}>delete</button>}
          </span>
        </div>
        {editing?.ts === m.ts ? (
          <div className="stack">
            <textarea value={editing.text} onChange={(e) => setEditing({ ts: m.ts, text: e.target.value })} rows={3} />
            <div className="row">
              <button onClick={saveEdit} disabled={busy}>save</button>
              <button className="ghost" onClick={() => setEditing(null)}>cancel</button>
            </div>
          </div>
        ) : (
          <div className="msg-body">{m.text ? <Mrkdwn text={m.text} names={slackNames} openChannel={channelLink} /> : <span className="muted">(no text)</span>}</div>
        )}
        {!inThread && (m.replyCount > 0 || stored > 0) && (
          <button className="thread-chip" onClick={() => go(channel, m.threadTs ?? m.ts)} title="open thread">
            {m.replyCount > 0 ? `${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"}` : "thread"}
            <MemoryBadge count={stored} cleared={threadCleared(channel, m.threadTs ?? m.ts)} what="thread" />
          </button>
        )}
      </div>
    );
  };

  const Composer = (value: string, set: (v: string) => void, threadTs?: string) => (
    <div className="slack-composer">
      <textarea
        placeholder={threadTs ? "reply in thread, or hit AI draft..." : `message ${currentName}, or hit AI draft...`}
        value={value}
        onChange={(e) => set(e.target.value)}
        rows={threadTs ? 3 : 4}
      />
      <div className="row">
        <button onClick={() => send(threadTs)} disabled={busy || !value.trim()}>send</button>
        <button className="ghost" onClick={() => draft(threadTs)} disabled={busy}>✨ AI draft</button>
      </div>
    </div>
  );

  return (
    <>
      <h1>Console</h1>
      <p className="muted">
        Manage the bot's live Slack messages, and see what its own DB remembers. <b>saved</b> means the bot holds stored turns
        for that channel or thread; <b>Delete in DB only</b> makes it forget them and never touches Slack.
      </p>
      {error && <div className="banner error">{error}</div>}
      {status && <div className="banner ok">{status}</div>}
      {memoryError && <div className="banner error">DB memory badges unavailable: {memoryError}</div>}
      {internalError && <div className="banner error">Hidden and deleted-on-Slack messages unavailable: {internalError}</div>}
      {copied && <div className="copy-toast" role="status">{copied}</div>}

      <div className="slack">
        <aside className="slack-side">
          <input placeholder="search channels and people..." value={convoFilter} onChange={(e) => setConvoFilter(e.target.value)} />
          <div className="slack-list">
            {groups.map((g) => g.items.length > 0 && (
              <div key={g.title}>
                <div className="slack-group">{g.title}</div>
                {g.items.map((c) => {
                  const mem = memByChannel.get(c.id);
                  return (
                    <button key={c.id} className={`slack-item${c.id === channel ? " on" : ""}`} onClick={() => go(c.id)} title={`${c.name} (${c.id})`}>
                      <span className="slack-glyph">{glyph(c)}</span>
                      <span className="slack-name">{c.name}</span>
                      {mem && <span className="mem-dot" title={`saved in the bot's DB · ${mem.count} turns`} />}
                      {c.lastActive ? <span className="muted slack-ago">{ago(c.lastActive)}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))}
            {searching && <p className="muted" style={{ padding: "6px 10px" }}>searching Slack...</p>}
            {searchError && <p className="muted" style={{ padding: "6px 10px" }}>Slack search failed: {searchError}</p>}
            {lower && !searching && !searchError && visible.length === 0 && <p className="muted" style={{ padding: 10 }}>No match.</p>}
          </div>
        </aside>

        {!channel ? (
          <section className="slack-main">
            <p className="muted" style={{ padding: 20 }}>Select a channel or DM.</p>
          </section>
        ) : threadRoot ? (
          <section className="slack-main slack-thread">
            <header className="slack-head">
              <button className="ghost" onClick={() => go(channel)} title="back to the channel">← {currentName}</button>
              <strong>Thread</strong>
              <MemoryBadge count={threadCount} cleared={threadCleared(channel, threadRoot)} what="thread" />
              <span className="slack-head-actions">
                <button
                  className="danger"
                  onClick={() => forget("thread", currentName, threadCount, threadRoot)}
                  disabled={busy || threadCount === 0}
                  title="forget the bot's stored turns for this thread only; Slack is not touched"
                >
                  Delete in DB only
                </button>
                <button className="link" onClick={() => copyLink({ ts: threadRoot })} title="copy the Slack link to the thread's first message">copy link</button>
                <button className="ghost" onClick={refresh} disabled={busy}>refresh</button>
              </span>
            </header>
            <Legend />
            <MessagePane
              resetKey={`${channel}/${threadRoot}`}
              bottomSignal={bottomSignal}
              hasOlder={!!thread?.hasMore}
              loadingOlder={olderFor === `${channel}/${threadRoot}`}
              onLoadOlder={loadOlderReplies}
            >
              {!thread && <p className="muted" style={{ padding: 16 }}>{loadingThread ? "Loading thread..." : "Thread not loaded."}</p>}
              {thread && threadTimeline.length === 0 && <p className="muted" style={{ padding: 16 }}>No messages.</p>}
              {threadTimeline.map((e) =>
                e.type === "slack" ? Row(e.message, true) : e.type === "internal" ? <InternalRow key={e.message.id} m={e.message} names={slackNames} /> : <DeletedRow key={e.message.id} m={e.message} names={slackNames} />,
              )}
            </MessagePane>
            {Composer(threadComposer, setThreadComposer, threadRoot)}
          </section>
        ) : (
          <section className="slack-main">
            <header className="slack-head">
              <strong>{currentName}</strong>
              <MemoryBadge count={channelCount} cleared={cleared.has(channel)} what="channel" />
              <span className="slack-head-actions">
                <button className="ghost" onClick={refresh} disabled={busy}>refresh</button>
                <button
                  className="danger"
                  onClick={() => forget("channel", currentName, channelCount)}
                  disabled={busy || channelCount === 0}
                  title="forget the bot's stored turns for this channel (every thread); Slack is not touched"
                >
                  Delete in DB only
                </button>
              </span>
            </header>
            <div className="slack-tools">
              <input placeholder="search messages..." value={filter} onChange={(e) => setFilter(e.target.value)} />
              <div className="seg">
                {(["all", "own", "mentions"] as Mode[]).map((m) => (
                  <button key={m} className={mode === m ? "seg-on" : ""} onClick={() => setMode(m)}>{m}</button>
                ))}
              </div>
              <label className="toggle" title="tell / brief / watch / nudge messages the bot stored but never posted to Slack (read-only)">
                <input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} />
                show internal{internal.length > 0 ? ` (${internal.length})` : ""}
              </label>
            </div>
            <Legend />
            <MessagePane
              resetKey={channel}
              bottomSignal={bottomSignal}
              hasOlder={!!cursor}
              loadingOlder={olderFor === `${channel}/`}
              onLoadOlder={loadOlder}
            >
              {channelTimeline.length === 0 && <p className="muted" style={{ padding: 16 }}>{loadingChannel ? "Loading..." : "No messages."}</p>}
              {channelTimeline.map((e) =>
                e.type === "slack" ? (
                  Row(e.message)
                ) : e.type === "internal" ? (
                  <InternalRow key={e.message.id} m={e.message} names={slackNames} onOpenThread={(root) => go(channel, root)} />
                ) : (
                  <DeletedRow key={e.message.id} m={e.message} names={slackNames} />
                ),
              )}
            </MessagePane>
            {Composer(composer, setComposer)}
          </section>
        )}
      </div>
    </>
  );
}
