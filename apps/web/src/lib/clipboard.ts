/**
 * Putting things on the person's clipboard: an address or a hash as text,
 * the "I bought" card as a picture.
 *
 * Local, like download.ts: the clipboard is the person's own, and nothing
 * leaves the tab until they paste it somewhere themselves.
 */

/** What copying needs from the page, passed in so tests can run it without one. */
export interface ClipboardEnv {
  clipboard: Partial<Pick<Clipboard, "writeText" | "write">> | undefined;
  /** The browser's `ClipboardItem`, where it has one. */
  ClipboardItem: ClipboardItemClass | undefined;
}

/** `ClipboardItem`'s constructor, and the `supports` newer browsers give it. */
export interface ClipboardItemClass {
  new (items: Record<string, Blob | Promise<Blob>>): ClipboardItem;
  supports?: (type: string) => boolean;
}

function pageEnv(): ClipboardEnv {
  const item = (globalThis as { ClipboardItem?: ClipboardItemClass }).ClipboardItem;
  return { clipboard: globalThis.navigator?.clipboard, ClipboardItem: item };
}

/**
 * Copy `text`, and say whether it was. False where the browser has no
 * clipboard to offer (a page not served over HTTPS or from this machine) or
 * refuses it (a permission denied), so the caller can show the text to be
 * selected by hand instead.
 */
export async function copyText(text: string, env: ClipboardEnv = pageEnv()): Promise<boolean> {
  if (typeof env.clipboard?.writeText !== "function") return false;
  try {
    await env.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Whether this browser can put a PNG on the clipboard; the card offers the button only where it can. */
export function canCopyImage(env: ClipboardEnv = pageEnv()): boolean {
  if (typeof env.clipboard?.write !== "function" || env.ClipboardItem === undefined) return false;
  const supports = env.ClipboardItem.supports;
  if (typeof supports !== "function") return true;
  try {
    return supports.call(env.ClipboardItem, "image/png");
  } catch {
    return false;
  }
}

/**
 * Put the PNG that `png` resolves to on the clipboard.
 *
 * Called in the click itself, with the picture still being drawn: Safari
 * allows the clipboard only within the gesture, and takes the picture as a
 * promise so the drawing can finish after it. A `png` that rejects rejects
 * this too, and nothing is copied.
 */
export async function copyPng(png: Promise<Blob>, env: ClipboardEnv = pageEnv()): Promise<void> {
  if (typeof env.clipboard?.write !== "function" || env.ClipboardItem === undefined) {
    // The picture's own failure, if it has one, is this one now.
    png.catch(() => undefined);
    throw new Error("This browser can't copy a picture.");
  }
  await env.clipboard.write([new env.ClipboardItem({ "image/png": png })]);
}
