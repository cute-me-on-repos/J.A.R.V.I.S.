import { Mrkdwn, type SlackNames } from "./ui/mrkdwn.tsx";
import { turnTime, type DbTurn } from "./deletedTurns.ts";

const stamp = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(5, 16);

/**
 * One message the bot's DB still holds but Slack no longer has, drawn from the
 * DB copy and marked as such. Read only: there is nothing in Slack to edit.
 */
export function DeletedRow({ m, names }: { m: DbTurn; names: SlackNames }) {
  const who = m.role === "assistant" ? "Jarvis" : m.userId ? names.users[m.userId] || m.userId : "unknown";
  return (
    <div className="msg k-deleted" title="stored in the bot's DB; the Slack message was deleted">
      <div className="msg-head">
        <span className="kind-dot" aria-hidden />
        <span className="badge deleted-badge">deleted on Slack</span>
        <strong>{who}</strong>
        <span className="muted">{stamp(turnTime(m))}</span>
        <span className="muted internal-note">from the bot's DB</span>
      </div>
      <div className="msg-body"><Mrkdwn text={m.text} names={names} /></div>
    </div>
  );
}
