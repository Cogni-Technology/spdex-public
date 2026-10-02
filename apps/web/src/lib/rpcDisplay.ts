/**
 * A network-service address as the page shows it: enough to recognise the
 * service, not enough to use its key.
 *
 * Endpoint URLs often carry an API key: in the path (`/v2/<key>`), in the
 * query, as a user and password, or as a subdomain. Screenshots of a status
 * panel travel, so the page shows `scheme://host` only, with any host label
 * that looks like a key cut to its first four characters: a label of 16
 * characters or more, or of 12 or more that mixes letters and digits. The
 * full address stays one tap away (the widget's and Settings' SHOW), and
 * nothing here changes what is stored or where requests go.
 */

const KEYLIKE_LONG = 16;
const KEYLIKE_MIXED = 12;

function keyLike(label: string): boolean {
  if (label.length >= KEYLIKE_LONG) return true;
  return label.length >= KEYLIKE_MIXED && /[a-z]/i.test(label) && /\d/.test(label);
}

function maskHost(hostname: string): string {
  // An IPv6 literal is an address, not a key: shown as it is.
  if (hostname.startsWith("[")) return hostname;
  return hostname
    .split(".")
    .map((label) => (keyLike(label) ? `${label.slice(0, 4)}…` : label))
    .join(".");
}

/**
 * `url` as `scheme://host[:port]`: no user or password, path, query or
 * fragment, and key-like host labels cut. Something that doesn't parse as a
 * URL shows as "…" rather than as itself, since it could be anything.
 */
export function maskRpcUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "…";
  }
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  return `${parsed.protocol}//${maskHost(parsed.hostname)}${port}`;
}

/** The service in use, named for a sentence: "the built-in service", or its address as `maskRpcUrl` shows it. */
export function serviceNameOf(rpc: { url: string | null; source: "bundled" | "user" | "fallback" }): string {
  return rpc.source === "bundled" || rpc.url === null ? "the built-in service" : maskRpcUrl(rpc.url);
}

/** Whether masking hides anything: when it doesn't, a SHOW button has nothing to show. */
export function rpcUrlMasked(url: string): boolean {
  return maskRpcUrl(url) !== url && maskRpcUrl(url) !== url.replace(/\/$/, "");
}
