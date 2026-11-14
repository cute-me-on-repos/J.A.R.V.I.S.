import { useEffect, useRef, useState } from "react";
import { get } from "./api.ts";
import type { InternalMessage } from "./internalTimeline.ts";
import type { DbTurn } from "./deletedTurns.ts";
import { mergeRows, replaceFrom } from "./pageMerge.ts";

type Rows = { internal: InternalMessage[]; turns: DbTurn[] };
const EMPTY: Rows = { internal: [], turns: [] };
const enc = encodeURIComponent;

const fetchRows = async (channel: string, thread: string, since: number | undefined, before: number | undefined) => {
  const q = `channel=${enc(channel)}${thread ? `&thread=${enc(thread)}` : ""}${since === undefined ? "" : `&since=${Math.floor(since)}`}${before === undefined ? "" : `&before=${Math.floor(before)}`}`;
  const [hidden, turns] = await Promise.allSettled([get<{ items: InternalMessage[] }>(`memory/internal?${q}`), get<{ items: DbTurn[] }>(`memory/turns?${q}`)]);
  const failed = [hidden, turns].find((r) => r.status === "rejected");
  return {
    internal: hidden.status === "fulfilled" ? hidden.value.items : null,
    turns: turns.status === "fulfilled" ? turns.value.items : null,
    error: failed?.status === "rejected" ? (failed.reason instanceof Error ? failed.reason.message : String(failed.reason)) : "",
  };
};

/**
 * The DB rows that sit next to a Slack page - the bot's hidden messages and the
 * DB copy that shows what Slack deleted - for one channel or thread. They page
 * with the Slack history: the first read is the window from the oldest message
 * on screen (`since`) to now; each older Slack page then reads just ITS window
 * (new `since` up to the previous one) and adds it, so no window is cut by a
 * cap on a bigger one. `tick` re-reads the newest window (a post, an edit).
 * `ready` is false until the Slack page it belongs to has arrived.
 */
export function useDbRows(channel: string, thread: string, ready: boolean, since: number | undefined, tick: number) {
  const [rows, setRows] = useState<Rows>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  /** `head`: where the newest window starts; `low`: how far back rows are loaded (undefined: all the way). */
  const state = useRef<{ key: string; head: number | undefined; low: number | undefined } | null>(null);
  const key = `${channel}/${thread}`;

  useEffect(() => {
    setRows(EMPTY);
    setLoaded(false);
    setError("");
    state.current = null;
  }, [key]);

  // The newest window: first read, and every re-read.
  useEffect(() => {
    if (!channel || !ready) return;
    let stale = false;
    const st = state.current?.key === key ? state.current : (state.current = { key, head: since, low: since });
    void fetchRows(channel, thread, st.head, undefined).then((r) => {
      if (stale) return;
      setRows((cur) => ({
        internal: r.internal ? replaceFrom(cur.internal, r.internal, st.head) : cur.internal,
        turns: r.turns ? replaceFrom(cur.turns, r.turns, st.head) : cur.turns,
      }));
      setError(r.error);
      setLoaded(true);
    });
    return () => {
      stale = true;
    };
    // `since` only seeds the first window; later ones come from the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready, tick]);

  // An older Slack page was loaded: read its window and add it.
  useEffect(() => {
    const st = state.current;
    if (!loaded || !st || st.key !== key || st.low === undefined) return;
    if (since !== undefined && since >= st.low) return;
    const before = st.low;
    st.low = since;
    void fetchRows(channel, thread, since, before).then((r) => {
      if (state.current?.key !== key) return;
      setRows((cur) => ({ internal: r.internal ? mergeRows(cur.internal, r.internal) : cur.internal, turns: r.turns ? mergeRows(cur.turns, r.turns) : cur.turns }));
      if (r.error) setError(r.error);
    });
  }, [key, since, loaded, channel, thread]);

  return { internal: rows.internal, turns: rows.turns, loaded, error };
}
