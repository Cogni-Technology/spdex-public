/**
 * The addresses spDEX may write into things people keep or follow: where this
 * app is published (on an "I bought" card, in a calendar file), where its
 * source is (in Verify this build's `git clone`), and where people leave
 * feedback (the footer's link).
 *
 * All are build settings, `VITE_SPDEX_APP_URL`, `VITE_SPDEX_SOURCE_URL` and
 * `VITE_SPDEX_FEEDBACK_URL`, set by whoever publishes a release, and all are
 * unset otherwise. spDEX never fills one in itself:
 * - **Not from the address bar.** A card or a calendar file outlives the tab,
 *   and the tab may be a dev server, a shared IPFS gateway or a stranger's
 *   copy. Printing that address would send everyone the file reaches there.
 * - **Not a built-in domain.** Nobody can promise who holds a domain later,
 *   and sending people to a stranger's site in spDEX's name is exactly the
 *   impersonation risk this app warns about. This is also why these aren't
 *   `VITE_SPDEX_CANONICAL_ORIGIN`: that one is set only together with the
 *   bundled network service's key, for its allowlist, and naming it here would
 *   print it on every card.
 *
 * So an unset or unusable setting reads as null, and whatever would print it
 * leaves the link out or says plainly that none is configured. It never shows
 * a placeholder made to look like a link.
 */

export interface LinkSettings {
  appUrl?: string | undefined;
  sourceUrl?: string | undefined;
  feedbackUrl?: string | undefined;
}

// Read by name, one property each, so the build puts in each value on its own.
const BUILD_SETTINGS: LinkSettings = {
  appUrl: import.meta.env.VITE_SPDEX_APP_URL as string | undefined,
  sourceUrl: import.meta.env.VITE_SPDEX_SOURCE_URL as string | undefined,
  feedbackUrl: import.meta.env.VITE_SPDEX_FEEDBACK_URL as string | undefined,
};

/**
 * Where this release is published, for links written into files: an `https:`
 * address on a public name, without the query or fragment (a card adds its own
 * `#receipt=`). Null when unset or unusable.
 */
export function shareableAppUrl(settings: LinkSettings = BUILD_SETTINGS): string | null {
  const url = parsedHttps(settings.appUrl);
  if (url === null || !isPublicName(url.hostname)) return null;
  return url.origin + url.pathname;
}

/**
 * Where the source is published, for `git clone <this>`, exactly as set. Null
 * when unset or unusable.
 *
 * It lands in a command people paste into a terminal, so it must be an
 * `https:` address made only of characters no shell gives a meaning to. Other
 * text is refused rather than escaped: an address rewritten on the way out is
 * no longer the one the publisher gave.
 */
export function sourceUrl(settings: LinkSettings = BUILD_SETTINGS): string | null {
  const text = settings.sourceUrl?.trim() ?? "";
  if (!/^https:\/\/[A-Za-z0-9._~:/%-]+$/.test(text)) return null;
  const url = parsedHttps(text);
  return url !== null && isPublicName(url.hostname) ? text : null;
}

/**
 * Where people leave feedback (an issue tracker or a form), for the footer's
 * link: an `https:` address on a public name, query kept (a tracker's
 * `?template=` picks the form). A link the person clicks, never a request the
 * app makes (AGENTS.md rule 4). Null when unset or unusable.
 */
export function feedbackUrl(settings: LinkSettings = BUILD_SETTINGS): string | null {
  const url = parsedHttps(settings.feedbackUrl);
  return url !== null && isPublicName(url.hostname) ? url.href : null;
}

/** An https URL with no user name or password in it, or null. */
function parsedHttps(value: string | undefined): URL | null {
  const text = value?.trim() ?? "";
  if (text === "") return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  return url;
}

/**
 * Whether a host is a public name, the only kind a release is published under.
 *
 * Loopback, `.localhost`, `.local` and single-label names only resolve on the
 * machine or network they were typed on. An address written as numbers is
 * refused too: it is nearly always a private network's, and a list of private
 * ranges is one more thing to get wrong.
 */
function isPublicName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host.startsWith("[") || /^[0-9.]+$/.test(host)) return false;
  return host.includes(".");
}
