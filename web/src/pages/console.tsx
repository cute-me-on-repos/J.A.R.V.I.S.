import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fmtSlackTs,
  get,
  post,
  type MemoryChannel,
  type MemoryThread,
  type SlackConversation,
  type SlackMessage,
} from "../api.ts";

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
  /** Channels/threads whose stored memory was deleted from this page, to tell "cleared" from "never stored". */
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

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

  const loadMemory = useCallback(async (ch: string) => {
    const [chans, threads] = await Promise.all([
      get<MemoryChannel[]>("memory/channels"),
      ch ? get<MemoryThread[]>(`memory/threads?channel=${encodeURIComponent(ch)}`) : Promise.resolve([]),
    ]);
    setMemChannels(chans);
    setMemThreads(threads);
  }, []);

  useEffect(() => {
    run(async () => {
      const list = await get<SlackConversation[]>("slack/conversations");
      setConvos(list);
      // Open the most recently active conversation by default.
      setChannel((cur) => cur || list[0]?.id || "");
    });
  }, [run]);

  const loadHistory = useCallback(
    (ch: string, lim: number) =>
      run(async () => {
        setThread(null);
        const [page] = await Promise.all([
          get<{ messages: SlackMessage[]; nextCursor?: string }>(`slack/history?channel=${encodeURIComponent(ch)}&limit=${lim}`),
          loadMemory(ch),
        ]);
        setMessages(page.messages);
        setCursor(page.nextCursor);
      }),
    [run, loadMemory],
  );

  const loadOlder = () =>
    run(async () => {
      const page = await get<{ messages: SlackMessage[]; nextCursor?: string }>(
        `slack/history?channel=${encodeURIComponent(channel)}&limit=${limit}&cursor=${encodeURIComponent(cursor ?? "")}`,
      );
      // older page is chronologically before what we have - prepend it
      setMessages((cur) => [...page.messages, ...cur]);
      setCursor(page.nextCursor);
    }, "loading older...");

  useEffect(() => {
    if (channel) loadHistory(channel, limit);
  }, [channel, limit, loadHistory]);

  const fetchThread = (root: string) => get<SlackMessage[]>(`slack/thread?channel=${encodeURIComponent(channel)}&ts=${root}`);

  const openThread = (m: SlackMessage) =>
    run(async () => {
      const root = m.threadTs ?? m.ts;
      setThread({ root, messages: await fetchThread(root) });
      setThreadComposer("");
    });

  const refresh = () => {
    loadHistory(channel, limit);
  };

  const refreshThread = (root: string) => run(async () => setThread({ root, messages: await fetchThread(root) }));

  const send = (threadTs?: string) =>
    run(async () => {
      const text = threadTs ? threadComposer : composer;
      await post("slack/post", { channel, text, threadTs });
      if (threadTs) {
        setThreadComposer("");
        setThread({ root: threadTs, messages: await fetchThread(threadTs) });
      } else {
        setComposer("");
      }
      const page = await get<{ messages: SlackMessage[]; nextCursor?: string }>(`slack/history?channel=${encodeURIComponent(channel)}&limit=${limit}`);
      setMessages(page.messages);
      setCursor(page.nextCursor);
    }, "posting...");

  const draft = (threadTs?: string) =>
    run(async () => {
      const { draft } = await post<{ draft: string }>("slack/draft", { channel, threadTs });
      if (threadTs) setThreadComposer(draft);
      else setComposer(draft);
    }, "drafting...");

  const saveEdit = () =>
    run(async () => {
      if (!editing) return;
      await post("slack/update", { channel, ts: editing.ts, text: editing.text });
      setEditing(null);
      refresh();
      if (thread) await refreshThread(thread.root);
    }, "saving...");

  const del = (m: SlackMessage) => {
    if (!confirm("Delete this message in Slack?")) return;
    run(async () => {
      await post("slack/delete", { channel, ts: m.ts });
      refresh();
      if (thread) await refreshThread(thread.root);
    }, "deleting...");
  };

  /** Forget the bot's stored turns only - never a Slack message. */
  const forget = (scope: "channel" | "thread", name: string, count: number, root?: string) => {
    const what = scope === "thread" ? "this thread" : `the whole of ${name} (every thread in it)`;
    if (!confirm(`Delete ${count} stored turn${count === 1 ? "" : "s"} for ${what} from the bot's DB?\n\nThe bot forgets them. Nothing in Slack is touched.`)) return;
    run(async () => {
      await post("conversation/clear", { channel, threadTs: scope === "thread" ? root : undefined });
      setCleared((cur) => new Set([...cur, scope === "thread" && root ? threadKey(channel, root) : channel]));
      await loadMemory(channel);
    }, "deleting from DB...");
  };

  const shown = messages.filter((m) => {
    if (mode === "own" && !m.own) return false;
    if (mode === "mentions" && !m.mentionsBot) return false;
    if (filter && !m.text.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  const memByChannel = useMemo(() => new Map(memChannels.map((c) => [c.channelId, c])), [memChannels]);
  const memByThread = useMemo(() => new Map(memThreads.map((t) => [t.threadTs, t])), [memThreads]);
  const channelCount = memByChannel.get(channel)?.count ?? 0;
  const current = convos.find((c) => c.id === channel);
  const currentName = current ? `${glyph(current)} ${current.name}` : channel;
  const threadCount = thread ? memByThread.get(thread.root)?.count ?? 0 : 0;

  const visible = convos.filter((c) => c.name.toLowerCase().includes(convoFilter.toLowerCase()));
  const groups: { title: string; items: SlackConversation[] }[] = [
    { title: "Channels", items: visible.filter((c) => c.kind === "channel" || c.kind === "group") },
    { title: "Direct messages", items: visible.filter((c) => c.kind === "im" || c.kind === "mpim") },
  ];

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
          <div className="msg-body">{m.text || <span className="muted">(no text)</span>}</div>
        )}
        {!inThread && (m.replyCount > 0 || stored > 0) && (
          <button className="thread-chip" onClick={() => openThread(m)} title="open thread">
            {m.replyCount > 0 ? `${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"}` : "thread"}
            <MemoryBadge count={stored} cleared={cleared.has(threadKey(channel, m.threadTs ?? m.ts))} what="thread" />
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
              </div>
              <div className="slack-msgs">
                <div className="load-older">
                  {cursor ? (
                    <button className="ghost" onClick={loadOlder} disabled={busy}>↑ load older messages</button>
                  ) : (
                    messages.length > 0 && <span className="muted">beginning of conversation</span>
                  )}
                </div>
                {shown.length === 0 && <p className="muted" style={{ padding: 16 }}>No messages.</p>}
                {shown.map((m) => Row(m))}
              </div>
              {Composer(composer, setComposer)}
            </>
          )}
        </section>

        {thread && (
          <aside className="slack-thread">
            <header className="slack-head">
              <strong>Thread</strong>
              <MemoryBadge count={threadCount} cleared={cleared.has(threadKey(channel, thread.root))} what="thread" />
              <span className="slack-head-actions">
                <button
                  className="danger"
                  onClick={() => forget("thread", currentName, threadCount, thread.root)}
                  disabled={busy || threadCount === 0}
                  title="forget the bot's stored turns for this thread only; Slack is not touched"
                >
                  Delete in DB only
                </button>
                <button className="link" onClick={() => setThread(null)}>close</button>
              </span>
            </header>
            <div className="slack-msgs">{thread.messages.map((m) => Row(m, true))}</div>
            {Composer(threadComposer, setThreadComposer, thread.root)}
          </aside>
        )}
      </div>
    </>
  );
}
