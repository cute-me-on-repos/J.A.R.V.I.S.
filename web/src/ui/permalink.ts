/**
 * Slack message permalinks for the Console's "copy link". The workspace url is
 * fetched once (`GET /api/slack/workspace`); every link is built here, so
 * copying is instant and costs no Slack call.
 */
export type PermalinkRef = {
  /** Channel, DM or group id - a DM is `D...` and links the same way. */
  channel: string;
  /** The message's own ts. */
  ts: string;
  /** The thread root's ts when the message is a reply in a thread. */
  threadTs?: string;
};

/**
 * `https://<workspace>.slack.com/archives/<channel>/p<ts without dot>`, and for
 * a thread reply `?thread_ts=<root>&cid=<channel>` so Slack opens the thread.
 * A thread root (its `threadTs` is its own ts) is a plain channel link.
 */
export const messagePermalink = (workspaceUrl: string, { channel, ts, threadTs }: PermalinkRef): string => {
  const base = `${workspaceUrl.replace(/\/+$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
};

type Nav = { clipboard?: { writeText: (t: string) => Promise<void> } };

type Doc = {
  createElement: (tag: "textarea") => {
    value: string;
    style: Record<string, string>;
    setAttribute: (k: string, v: string) => void;
    focus: () => void;
    select: () => void;
    remove: () => void;
  };
  body: { appendChild: (el: never) => unknown };
  execCommand: (cmd: "copy") => boolean;
};

/**
 * Copy text: `navigator.clipboard` where the page is a secure context
 * (https or localhost), else a hidden textarea + `execCommand("copy")` - the
 * dashboard is often opened by LAN ip over plain http, where the clipboard API
 * is missing. Returns whether anything was copied.
 */
export const copyText = async (
  text: string,
  nav: Nav = (globalThis as { navigator?: Nav }).navigator ?? {},
  doc: Doc = (globalThis as { document?: Doc }).document as Doc,
): Promise<boolean> => {
  if (nav.clipboard) {
    try {
      await nav.clipboard.writeText(text);
      return true;
    } catch {
      // permission refused or document not focused: try the textarea route
    }
  }
  const el = doc.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  Object.assign(el.style, { position: "fixed", top: "0", left: "0", opacity: "0" });
  doc.body.appendChild(el as never);
  try {
    el.focus();
    el.select();
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    el.remove();
  }
};
