import { useLayoutEffect, useRef, type ReactNode } from "react";
import { nearBottom, nearTop } from "../pageMerge.ts";

type Props = {
  /** Changes when another conversation opens: the pane lands on its newest message again. */
  resetKey: string;
  /** Bump to jump to the bottom whatever the scroll position (the user just posted). */
  bottomSignal?: number;
  /** Older messages remain to load. */
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  children: ReactNode;
};

/**
 * The scrolling list of a conversation, as Slack behaves: it opens on the
 * newest message and follows new ones while the user is at the bottom, but
 * leaves a reader who scrolled up alone; reaching the top loads the next older
 * page and keeps what the user was looking at where it was.
 */
export function MessagePane({ resetKey, bottomSignal = 0, hasOlder, loadingOlder, onLoadOlder, children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  /** Following the newest message: true until the user scrolls away from the bottom. */
  const follow = useRef(true);
  /** Height and offset just before an older page was asked for, to put the reader back after it is prepended. */
  const anchor = useRef<{ height: number; top: number } | null>(null);

  useLayoutEffect(() => {
    follow.current = true;
    anchor.current = null;
  }, [resetKey, bottomSignal]);

  // After every render: restore the reader's place after a prepend, else stay at the bottom when following.
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    if (anchor.current) {
      if (loadingOlder) return;
      node.scrollTop = anchor.current.top + (node.scrollHeight - anchor.current.height);
      anchor.current = null;
    } else if (follow.current) {
      node.scrollTop = node.scrollHeight;
    }
  });

  const loadOlder = () => {
    const node = box.current;
    if (!node || loadingOlder || !hasOlder) return;
    anchor.current = { height: node.scrollHeight, top: node.scrollTop };
    onLoadOlder();
  };

  return (
    <div
      className="slack-msgs"
      ref={box}
      onScroll={(e) => {
        const n = e.currentTarget;
        // A scroll the code made itself (to the bottom, or back to the anchor) must not read as the user leaving.
        if (anchor.current) return;
        follow.current = nearBottom(n.scrollTop, n.clientHeight, n.scrollHeight);
        if (nearTop(n.scrollTop)) loadOlder();
      }}
    >
      <div className="load-older">
        {loadingOlder ? (
          <span className="muted">loading older messages...</span>
        ) : hasOlder ? (
          <button className="ghost" onClick={loadOlder}>↑ load older messages</button>
        ) : (
          <span className="muted">beginning of conversation</span>
        )}
      </div>
      {children}
    </div>
  );
}
