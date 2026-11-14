import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fmtSlackTs,
  get,
  post,
  type MemoryChannel,
  type MemoryThread,
  type SlackConversation,
  type SlackMessage,
} from "../api.ts";
import { Mrkdwn, useSlackNames } from "../ui/mrkdwn.tsx";
import { copyText, messagePermalink, type PermalinkRef } from "../ui/permalink.ts";
import { InternalRow } from "../internalMessages.tsx";
import { mergeTimeline, oldestOnScreen, pickInternal, type InternalMessage } from "../internalTimeline.ts";

type Mode = "all" | "own" | "mentions";
type Editing = { ts: string; text: string } | null;
type OpenThread = { root: string; messages: SlackMessage[] };

const threadKey = (channel: string, root: string) => `${channel}:${root}`;

const ago = (ms: number): string => {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const glyph = (c: SlackConversation) => (c.kind === "im" ? "@" : c.kind === "mpim" ? "@@" : c.kind === "group" ? "🔒" : "#");

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
 * Slack: channels and DMs on the left, the conversation in the middle, a thread
 * in a right pane. Edit/delete the bot's own messages, reply, generate an AI
 * draft, and see - and clear - what the bot's DB remembers per channel/thread.
 */
export function ConsolePage() {
  const [convos, setConvos] = useState<SlackConversation[]>([]);
  const [channel, setChannel] = useState("");
  const [convoFilter, setConvoFilter] = useState("");
  const [messages, setMessages] = useState<SlackMessage[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [limit, setLimit] = useState(30);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [thread, setThread] = useState<OpenThread | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [composer, setComposer] = useState("");
  const [threadComposer, setThreadComposer] = useState("");
  const [memChannels, setMemChannels] = useState<MemoryChannel[]>([]);
  const [memThreads, setMemThreads] = useState<MemoryThread[]>([]);
  /** Messages the bot steered sessions with that never reached Slack (tell, brief, ...), from its DB. */
  const [internal, setInternal] = useState<InternalMessage[]>([]);
  const [showInternal, setShowInternal] = useState(true);
  /** Channels/threads whose stored memory was deleted from this page, to tell "cleared" from "never stored". */
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  /** The workspace url, asked of the server once (cached there too); every link is then built here. */
  const workspace = useRef<Promise<string> | undefined>(undefined);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const run = useCallback(async (fn: () => Promise<void>, note = "") => {
    setError("");
    setBusy(true);
    if (note) setStatus(note);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }, []);

  /** What is on screen now, so an answer for a channel or thread the user already left is dropped, not shown. */
  const live = useRef({ channel: "", thread: "" });
  live.current = { channel, thread: thread?.root ?? "" };
  const [memoryError, setMemoryError] = useState("");

  /** The DB badges. Never fatal: when it fails only the badges go, Slack history still renders. */
  const loadMemory = useCallback(async (ch: string) => {
    try {
      const [chans, threads] = await Promise.all([
        get<MemoryChannel[]>("memory/channels"),
        ch ? get<MemoryThread[]>(`memory/threads?channel=${encodeURIComponent(ch)}`) : Promise.resolve([]),
      ]);
      setMemChannels(chans);
      if (live.current.channel === ch) setMemThreads(threads);
      setMemoryError("");
    } catch (e) {
      setMemoryError(e instanceof Error ? e.message : String(e));
    }
    // Apart from the badges: losing the hidden messages must not take them down, nor the reverse.
    try {
      const found = await get<{ items: InternalMessage[] }>(`memory/internal?channel=${encodeURIComponent(ch)}`);
      if (live.current.channel === ch) setInternal(found.items);
    } catch (e) {
      if (live.current.channel === ch) setInternal([]);
      setMemoryError((cur) => cur || `hidden messages unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    run(async () => {
      const list = await get<SlackConversation[]>("slack/conversations");
      setConvos(list);
      // Open the most recently active conversation by default.
      setChannel((cur) => cur || list[0]?.id || "");
    });
  }, [run]);

  type Page = { messages: SlackMessage[]; nextCursor?: string };
  const historyUrl = (ch: string, lim: number, before?: string) =>
    `slack/history?channel=${encodeURIComponent(ch)}&limit=${lim}${before === undefined ? "" : `&cursor=${encodeURIComponent(before)}`}`;

  /** Reload the newest page and the badges; leaves an open thread alone. */
  const reloadChannel = useCallback(
    async (ch: string, lim: number) => {
      const memory = loadMemory(ch);
      const page = await get<Page>(historyUrl(ch, lim));
      if (live.current.channel === ch) {
        setMessages(page.messages);
        setCursor(page.nextCursor);
      }
      await memory;
    },
    [loadMemory],
  );

  // Another channel: its own history, no thread, nothing carried over.
  useEffect(() => {
    if (!channel) return;
    setThread(null);
    setMessages([]);
    setCursor(undefined);
    setMemThreads([]);
    setInternal([]);
    run(() => reloadChannel(channel, limit));
    // limit changes reload the same channel without closing its thread (below)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  const firstLimit = useRef(true);
  useEffect(() => {
    if (firstLimit.current) {
      firstLimit.current = false;
      return;
    }
    if (channel) run(() => reloadChannel(channel, limit));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  const loadOlder = () => {
    const ch = channel;
    return run(async () => {
      const page = await get<Page>(historyUrl(ch, limit, cursor ?? ""));
      if (live.current.channel !== ch) return;
      // older page is chronologically before what we have - prepend it
      setMessages((cur) => [...page.messages, ...cur]);
      setCursor(page.nextCursor);
    }, "loading older...");
  };

  const fetchThread = (ch: string, root: string) => get<SlackMessage[]>(`slack/thread?channel=${encodeURIComponent(ch)}&ts=${root}`);

  /** Re-read the open thread unless the user has moved on from it meanwhile. */
  const reloadThread = async (ch: string, root: string) => {
    const msgs = await fetchThread(ch, root);
    if (live.current.channel === ch && live.current.thread === root) setThread({ root, messages: msgs });
  };

  const openThread = (m: SlackMessage) => openThreadRoot(m.threadTs ?? m.ts);

  const openThreadRoot = (root: string) => {
    const ch = channel;
    return run(async () => {
      const msgs = await fetchThread(ch, root);
      if (live.current.channel !== ch) return;
      setThread({ root, messages: msgs });
      setThreadComposer("");
    });
  };

  const refresh = () =>
    run(async () => {
      await reloadChannel(channel, limit);
      if (thread) await reloadThread(channel, thread.root);
    });

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
      await reloadChannel(ch, limit);
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

  const refreshAll = async (ch: string) => {
    await reloadChannel(ch, limit);
    const root = live.current.thread;
    if (root && live.current.channel === ch) await reloadThread(ch, root);
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
      setError(e instanceof Error ? e.message : String(e));
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
      await loadMemory(ch);
    }, "deleting from DB...");
  };

  const shown = messages.filter((m) => {
    if (mode === "own" && !m.own) return false;
    if (mode === "mentions" && !m.mentionsBot) return false;
    if (filter && !m.text.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  // One batched name lookup for every mention in the list and the open thread.
  const slackNames = useSlackNames([...messages, ...(thread?.messages ?? [])].map((m) => m.text));
  /** A `<#C…>` pill opens that channel only when it is in the sidebar. */
  const channelLink = (id: string) => (convos.some((c) => c.id === id) ? () => setChannel(id) : undefined);

  const memByChannel = useMemo(() => new Map(memChannels.map((c) => [c.channelId, c])), [memChannels]);
  const memByThread = useMemo(() => new Map(memThreads.map((t) => [t.threadTs, t])), [memThreads]);
  const channelCount = memByChannel.get(channel)?.count ?? 0;
  const current = convos.find((c) => c.id === channel);
  const currentName = current ? `${glyph(current)} ${current.name}` : channel;
  const threadCleared = (ch: string, root: string) => cleared.has(threadKey(ch, root)) || cleared.has(ch);
  const threadCount = thread ? memByThread.get(thread.root)?.count ?? 0 : 0;

  const visible = convos.filter((c) => c.name.toLowerCase().includes(convoFilter.toLowerCase()));
  const groups: { title: string; items: SlackConversation[] }[] = [
    { title: "Channels", items: visible.filter((c) => c.kind === "channel" || c.kind === "group") },
    { title: "Direct messages", items: visible.filter((c) => c.kind === "im" || c.kind === "mpim") },
  ];

  /** Slack messages with the hidden ones interleaved by time (just the Slack ones when "show internal" is off or a filter hides them). */
  const timeline = (msgs: readonly SlackMessage[], threadTs?: string, hasOlder = false) => {
    const hidden =
      showInternal && mode === "all"
        ? pickInternal(internal, { threadTs, since: oldestOnScreen(msgs, hasOlder), filter })
        : [];
    return mergeTimeline(msgs, hidden);
  };

  const marker = (m: SlackMessage) =>
    m.own ? <span className="badge assistant" title="your message">✎</span> : m.mentionsBot ? <span className="badge user" title="mentions you">@</span> : <span className="mk-space" />;

  const Row = (m: SlackMessage, inThread = false) => {
    const stored = memByThread.get(m.threadTs ?? m.ts)?.count ?? 0;
    return (
      <div className={`msg${m.own ? " own" : ""}`} key={m.ts}>
        <div className="msg-head">
          {marker(m)}
          <strong>{m.userId && m.userName !== m.userId ? `${m.userName} (${m.userId})` : m.userId ? `unknown (${m.userId})` : m.userName}</strong>
          <span className="muted">{fmtSlackTs(m.ts)}</span>
          <span className="msg-actions">
            {!inThread && <button className="link" onClick={() => openThread(m)}>reply</button>}
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
          <button className="thread-chip" onClick={() => openThread(m)} title="open thread">
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
      {copied && <div className="copy-toast" role="status">{copied}</div>}

      <div className={`slack${thread ? " with-thread" : ""}`}>
        <aside className="slack-side">
          <input placeholder="filter..." value={convoFilter} onChange={(e) => setConvoFilter(e.target.value)} />
          <div className="slack-list">
            {groups.map((g) => g.items.length > 0 && (
              <div key={g.title}>
                <div className="slack-group">{g.title}</div>
                {g.items.map((c) => {
                  const mem = memByChannel.get(c.id);
                  return (
                    <button key={c.id} className={`slack-item${c.id === channel ? " on" : ""}`} onClick={() => setChannel(c.id)} title={`${c.name} (${c.id})`}>
                      <span className="slack-glyph">{glyph(c)}</span>
                      <span className="slack-name">{c.name}</span>
                      {mem && <span className="mem-dot" title={`saved in the bot's DB · ${mem.count} turns`} />}
                      {c.lastActive ? <span className="muted slack-ago">{ago(c.lastActive)}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))}
            {convos.length > 0 && visible.length === 0 && <p className="muted" style={{ padding: 10 }}>No match.</p>}
          </div>
        </aside>

        <section className="slack-main">
          {!channel ? (
            <p className="muted" style={{ padding: 20 }}>Select a channel or DM.</p>
          ) : (
            <>
              <header className="slack-head">
                <strong>{currentName}</strong>
                <MemoryBadge count={channelCount} cleared={cleared.has(channel)} what="channel" />
                <span className="slack-head-actions">
                  <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                    {[15, 30, 50].map((n) => <option key={n} value={n}>{n} msgs</option>)}
                  </select>
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
              <div className="slack-msgs">
                <div className="load-older">
                  {cursor ? (
                    <button className="ghost" onClick={loadOlder} disabled={busy}>↑ load older messages</button>
                  ) : (
                    messages.length > 0 && <span className="muted">beginning of conversation</span>
                  )}
                </div>
                {timeline(shown, undefined, !!cursor).length === 0 && <p className="muted" style={{ padding: 16 }}>No messages.</p>}
                {timeline(shown, undefined, !!cursor).map((e) =>
                  e.type === "slack" ? Row(e.message) : <InternalRow key={e.message.id} m={e.message} onOpenThread={openThreadRoot} />,
                )}
              </div>
              {Composer(composer, setComposer)}
            </>
          )}
        </section>

        {thread && (
          <aside className="slack-thread">
            <header className="slack-head">
              <strong>Thread</strong>
              <MemoryBadge count={threadCount} cleared={threadCleared(channel, thread.root)} what="thread" />
              <span className="slack-head-actions">
                <button
                  className="danger"
                  onClick={() => forget("thread", currentName, threadCount, thread.root)}
                  disabled={busy || threadCount === 0}
                  title="forget the bot's stored turns for this thread only; Slack is not touched"
                >
                  Delete in DB only
                </button>
                <button className="link" onClick={() => copyLink({ ts: thread.root })} title="copy the Slack link to the thread's first message">copy link</button>
                <button className="link" onClick={() => setThread(null)}>close</button>
              </span>
            </header>
            <div className="slack-msgs">
              {timeline(thread.messages, thread.root).map((e) =>
                e.type === "slack" ? Row(e.message, true) : <InternalRow key={e.message.id} m={e.message} />,
              )}
            </div>
            {Composer(threadComposer, setThreadComposer, thread.root)}
          </aside>
        )}
      </div>
    </>
  );
}
