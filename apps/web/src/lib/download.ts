/**
 * Handing the person a file: the CSV of their activity, a calendar file of
 * buy times, the "I bought" card's PNG.
 *
 * Everything is made in the page and saved through a link to an object URL,
 * so nothing is uploaded and no request is made: the file goes from this tab
 * to the person's disk.
 */

/**
 * How long an object URL outlives its click.
 *
 * The browser reads the file after `click()` returns, not during it, so an
 * object URL revoked straight away can be gone before the save starts. That
 * made Playwright's download event flaky, and a slow disk could do the same to
 * a person. A minute is far more than any save needs, and the memory is
 * released after that.
 */
export const REVOKE_AFTER_MS = 60_000;

/** What saving a file needs from the page, passed in so tests can run it without one. */
export interface DownloadEnv {
  document: Pick<Document, "createElement" | "body">;
  URL: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  setTimeout(run: () => void, ms: number): unknown;
}

function pageEnv(): DownloadEnv {
  return { document, URL, setTimeout: (run, ms) => setTimeout(run, ms) };
}

/** Save `text` as a file named `name`, of type `mime` (give text types a charset: "text/csv;charset=utf-8"). */
export function downloadText(name: string, mime: string, text: string, env: DownloadEnv = pageEnv()): void {
  downloadBlob(name, new Blob([text], { type: mime }), env);
}

/** Save `blob` as a file named `name`. */
export function downloadBlob(name: string, blob: Blob, env: DownloadEnv = pageEnv()): void {
  const url = env.URL.createObjectURL(blob);
  const link = env.document.createElement("a");
  link.href = url;
  link.download = safeFileName(name);
  link.rel = "noopener";
  link.style.display = "none";
  env.document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    env.setTimeout(() => env.URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}

const MAX_NAME = 120;

/**
 * A file name made only of letters, digits, dots, dashes and underscores.
 *
 * Names are built from spDEX's own values today (a plan id is lowercase
 * letters, digits and dashes), and this keeps it that way if one ever carries
 * text from a shared config: no path, no hidden file, and no right-to-left
 * mark that makes "x.exe" look like something else.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-");
  const [, rawStem = "", extension = ""] = /^(.*?)(\.[A-Za-z0-9]{1,9})?$/.exec(cleaned) ?? [];
  const stem = rawStem
    .replace(/^[.-]+/, "")
    .slice(0, MAX_NAME - extension.length)
    .replace(/[.-]+$/, "");
  return (stem || "spdex") + extension;
}
