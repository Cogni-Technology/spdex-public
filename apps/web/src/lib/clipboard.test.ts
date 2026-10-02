import { describe, expect, it } from "vitest";
import { canCopyImage, copyPng, copyText, type ClipboardEnv, type ClipboardItemClass } from "./clipboard.js";

/** A `ClipboardItem` that keeps what it was given, with `supports` as a browser has it or not. */
function itemClass(supports?: (type: string) => boolean): ClipboardItemClass {
  class Item {
    constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
  }
  if (supports) Object.assign(Item, { supports });
  return Item as unknown as ClipboardItemClass;
}

describe("copyText", () => {
  it("writes the text and says it did", async () => {
    const written: string[] = [];
    const env: ClipboardEnv = { clipboard: { writeText: async (text) => void written.push(text) }, ClipboardItem: undefined };
    expect(await copyText("0xabc", env)).toBe(true);
    expect(written).toEqual(["0xabc"]);
  });

  it("says it didn't where the page has no clipboard, or the clipboard refuses", async () => {
    expect(await copyText("0xabc", { clipboard: undefined, ClipboardItem: undefined })).toBe(false);
    const refusing: ClipboardEnv = {
      clipboard: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
      ClipboardItem: undefined,
    };
    expect(await copyText("0xabc", refusing)).toBe(false);
  });
});

describe("canCopyImage", () => {
  const write = async () => undefined;

  it("needs both the clipboard's write and ClipboardItem", () => {
    expect(canCopyImage({ clipboard: undefined, ClipboardItem: itemClass() })).toBe(false);
    expect(canCopyImage({ clipboard: { write }, ClipboardItem: undefined })).toBe(false);
    expect(canCopyImage({ clipboard: { write }, ClipboardItem: itemClass() })).toBe(true);
  });

  it("believes ClipboardItem.supports where a browser has it", () => {
    expect(canCopyImage({ clipboard: { write }, ClipboardItem: itemClass((type) => type === "image/png") })).toBe(true);
    expect(canCopyImage({ clipboard: { write }, ClipboardItem: itemClass(() => false) })).toBe(false);
    const throwing = itemClass(() => {
      throw new TypeError("no");
    });
    expect(canCopyImage({ clipboard: { write }, ClipboardItem: throwing })).toBe(false);
  });
});

describe("copyPng", () => {
  it("hands the clipboard the picture as a promise, in the same call, before it is drawn", async () => {
    const given: unknown[] = [];
    const env: ClipboardEnv = { clipboard: { write: async (items) => void given.push(...items) }, ClipboardItem: itemClass() };
    let draw!: (blob: Blob) => void;
    const picture = new Promise<Blob>((resolve) => (draw = resolve));
    const copying = copyPng(picture, env);
    // Written already, with the drawing still to finish: Safari's rule.
    expect(given).toHaveLength(1);
    const item = given[0] as { items: Record<string, Promise<Blob>> };
    expect(Object.keys(item.items)).toEqual(["image/png"]);
    expect(item.items["image/png"]).toBe(picture);
    draw(new Blob(["png"], { type: "image/png" }));
    await copying;
  });

  it("refuses where the browser can't copy a picture", async () => {
    const picture = Promise.reject(new Error("never drawn"));
    await expect(copyPng(picture, { clipboard: undefined, ClipboardItem: itemClass() })).rejects.toThrow("can't copy a picture");
  });
});
