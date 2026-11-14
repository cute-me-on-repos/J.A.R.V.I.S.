/**
 * Where the console is, as a URL: `/console/<channel>` and
 * `/console/<channel>/<thread_ts>`. Pure, so loading a url directly and the
 * back button agree with what the page links to.
 */

export type ConsoleLocation = { channel: string; thread: string };

const CHANNEL = /^[A-Z][A-Z0-9]{2,}$/;
const THREAD_TS = /^\d{1,12}\.\d{1,9}$/;

/** The location in the console route's splat (the part after `/console/`); anything malformed reads as "not there" (empty). */
export const parseConsolePath = (splat: string | undefined): ConsoleLocation => {
  const [channelPart = "", threadPart = ""] = (splat ?? "").split("/").filter(Boolean);
  const channel = CHANNEL.test(channelPart) ? channelPart : "";
  // A thread without a channel, or a ts that is not one, is dropped rather than guessed.
  const thread = channel && THREAD_TS.test(threadPart) ? threadPart : "";
  return { channel, thread };
};

/** The url of a channel, or of one thread in it. */
export const consolePath = (channel: string, thread?: string): string =>
  !channel ? "/console" : thread ? `/console/${encodeURIComponent(channel)}/${encodeURIComponent(thread)}` : `/console/${encodeURIComponent(channel)}`;
