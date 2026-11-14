import { useEffect, useState, type ReactNode } from "react";
import { get } from "../api.ts";
import { mrkdwnRefs, parseMrkdwn, type Block, type Inline } from "./mrkdwn.ts";

/** Display names already resolved by the server: `users` id -> name, `channels` id -> name without `#` ("" = unknown). */
export type SlackNames = { users: Readonly<Record<string, string>>; channels: Readonly<Record<string, string>> };

const NONE: SlackNames = { users: {}, channels: {} };

/**
 * Names for every mention in `texts`, fetched in ONE request per change of the
 * set (`GET slack/names`), and only for ids not asked about yet. A failure just
 * leaves the raw ids on screen. `enabled` false holds the lookup back, so a page
 * that is still arriving in pieces asks once, for everything, when it is whole.
 */
export function useSlackNames(texts: readonly string[], enabled = true): SlackNames {
  const [names, setNames] = useState<SlackNames>(NONE);
  const refs = mrkdwnRefs(texts);
  const wanted = (ids: string[], have: Readonly<Record<string, string>>) => ids.filter((id) => !(id in have));
  const users = wanted(refs.users, names.users);
  const channels = wanted(refs.channels, names.channels);
  const key = `${users.join(",")}|${channels.join(",")}`;

  useEffect(() => {
    if (!enabled || (!users.length && !channels.length)) return;
    let stale = false;
    const qs = new URLSearchParams();
    if (users.length) qs.set("users", users.join(","));
    if (channels.length) qs.set("channels", channels.join(","));
    get<SlackNames>(`slack/names?${qs}`)
      .then((got) => {
        if (stale) return;
        // An id the server did not answer for is remembered as unknown, so it is not asked again every render.
        const fill = (ids: string[], answer: Readonly<Record<string, string>>) => Object.fromEntries(ids.map((id) => [id, answer[id] ?? ""]));
        setNames((cur) => ({
          users: { ...cur.users, ...fill(users, got.users) },
          channels: { ...cur.channels, ...fill(channels, got.channels) },
        }));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // `key` is the content of users/channels
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return names;
}

type Ctx = { names: SlackNames; openChannel?: (id: string) => (() => void) | undefined };

const inline = (nodes: readonly Inline[], ctx: Ctx): ReactNode[] =>
  nodes.map((n, i): ReactNode => {
    switch (n.t) {
      case "text":
        return n.text;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
            {n.label}
          </a>
        );
      case "user": {
        const name = ctx.names.users[n.id] || n.label;
        return (
          <span key={i} className="mention" title={n.id}>
            @{name || n.id}
          </span>
        );
      }
      case "channel": {
        const name = ctx.names.channels[n.id] || n.label;
        const text = name ? `#${name}` : `#${n.id}`;
        const open = ctx.openChannel?.(n.id);
        return open ? (
          <button key={i} className="mention mention-link" title={`open ${text}`} onClick={open}>
            {text}
          </button>
        ) : (
          <span key={i} className="mention" title={n.id}>
            {text}
          </span>
        );
      }
      case "special":
        return (
          <span key={i} className="mention mention-broadcast">
            {n.label}
          </span>
        );
      case "code":
        return <code key={i}>{n.text}</code>;
      case "bold":
        return <strong key={i}>{inline(n.children, ctx)}</strong>;
      case "italic":
        return <em key={i}>{inline(n.children, ctx)}</em>;
      case "strike":
        return <s key={i}>{inline(n.children, ctx)}</s>;
    }
  });

const block = (b: Block, i: number, ctx: Ctx): ReactNode => {
  switch (b.t) {
    case "pre":
      return <pre key={i} className="msg-pre">{b.text}</pre>;
    case "quote":
      return <blockquote key={i} className="msg-quote">{inline(b.children, ctx)}</blockquote>;
    case "para":
      return <span key={i}>{inline(b.children, ctx)}</span>;
  }
};

/** One Slack message body (`openChannel` returns a click handler for a channel in the sidebar, else undefined): links, mentions and mrkdwn styling as elements, everything else as text. */
export function Mrkdwn({ text, names, openChannel }: { text: string; names: SlackNames; openChannel?: Ctx["openChannel"] }) {
  const ctx: Ctx = { names, openChannel };
  const blocks = parseMrkdwn(text);
  return <>{blocks.map((b, i) => block(b, i, ctx))}</>;
}
