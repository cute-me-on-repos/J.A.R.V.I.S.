import { useState } from "react";
import { KIND_META, previewOf, type InternalMessage } from "./internalTimeline.ts";

const stamp = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(5, 16);

/**
 * One hidden message in the console timeline: dashed and dimmed, with its kind,
 * who or what sent it, and the text collapsed to a preview until opened. Read
 * only. `onOpenThread` is given in the channel view, where the message names the
 * thread it went into.
 */
export function InternalRow({ m, onOpenThread }: { m: InternalMessage; onOpenThread?: (root: string) => void }) {
  const [open, setOpen] = useState(false);
  const meta = KIND_META[m.kind];
  const { shown, cut } = previewOf(m.text);
  return (
    <div className={`msg internal internal-${m.kind}`} title={meta.hint}>
      <div className="msg-head">
        <span className="internal-icon" aria-hidden>{meta.icon}</span>
        <span className="badge member">{meta.label}</span>
        <strong>{m.source}</strong>
        <span className="muted">{stamp(m.at)}</span>
        <span className="muted internal-note">not posted to Slack</span>
        <span className="msg-actions">
          {m.threadTs && onOpenThread && <button className="link" onClick={() => onOpenThread(m.threadTs)}>thread</button>}
          {cut && <button className="link" onClick={() => setOpen(!open)}>{open ? "collapse" : "expand"}</button>}
        </span>
      </div>
      {m.from && <div className="muted internal-from">from thread {m.from.channelId} / {m.from.threadTs}</div>}
      <div className="msg-body">{open || !cut ? m.text : shown}</div>
    </div>
  );
}
