/**
 * What kind of message a row of the console is, and the legend that names the
 * colours: one kind per colour, so a row says where it lives at a glance.
 */

export type MessageKind = "jarvis" | "internal" | "deleted" | "person" | "bot";

export const KIND_LEGEND: readonly { kind: MessageKind; label: string; hint: string }[] = [
  { kind: "jarvis", label: "Jarvis on Slack", hint: "posted by the bot on Slack" },
  { kind: "internal", label: "internal", hint: "tell, brief, watch, nudge: steered the bot's session and never posted to Slack" },
  { kind: "deleted", label: "deleted on Slack", hint: "still in the bot's DB, but the Slack message is gone" },
  { kind: "person", label: "people", hint: "a message from someone else on Slack" },
  { kind: "bot", label: "other bots", hint: "a message from a bot or app that is not Jarvis" },
];

/** The kind of a message that is on Slack. */
export const slackKind = (m: { own: boolean; bot?: boolean }): MessageKind => (m.own ? "jarvis" : m.bot ? "bot" : "person");
