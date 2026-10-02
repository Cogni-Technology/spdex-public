import { describe, expect, it } from "vitest";
import { REVOKE_AFTER_MS, downloadBlob, downloadText, safeFileName, type DownloadEnv } from "./download.js";

/** A page with just enough DOM to save a file, recording what happened in order. */
function fakePage(options: { clickThrows?: boolean } = {}) {
  const events: string[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const blobs: Blob[] = [];
  const link = {
    href: "",
    download: "",
    rel: "",
    style: { display: "" },
    click() {
      events.push(`click ${link.download} ${link.href}`);
      if (options.clickThrows) throw new Error("blocked");
    },
    remove() {
      events.push("remove");
    },
  };
  const env = {
    document: {
      createElement(tag: string) {
        events.push(`create ${tag}`);
        return link;
      },
      body: {
        append() {
          events.push("append");
        },
      },
    },
    URL: {
      createObjectURL(blob: Blob) {
        blobs.push(blob);
        return `blob:page/${blobs.length}`;
      },
      revokeObjectURL(url: string) {
        events.push(`revoke ${url}`);
      },
    },
    setTimeout(run: () => void, ms: number) {
      timers.push({ run, ms });
    },
  } as unknown as DownloadEnv;
  return { env, events, timers, blobs, link };
}

describe("downloadBlob", () => {
  it("saves through a hidden link it removes again", () => {
    const page = fakePage();
    downloadBlob("spdex-card.png", new Blob(["png"], { type: "image/png" }), page.env);
    expect(page.events).toEqual(["create a", "append", "click spdex-card.png blob:page/1", "remove"]);
    expect(page.link.rel).toBe("noopener");
    expect(page.link.style.display).toBe("none");
  });

  it("keeps the object URL for a minute after the click, then revokes it", () => {
    // Revoking at once lets the URL vanish before the browser reads the file.
    const page = fakePage();
    downloadBlob("a.csv", new Blob(["x"]), page.env);
    expect(page.events.some((e) => e.startsWith("revoke"))).toBe(false);
    expect(page.timers.map((t) => t.ms)).toEqual([REVOKE_AFTER_MS]);
    expect(REVOKE_AFTER_MS).toBe(60_000);
    page.timers[0]!.run();
    expect(page.events.at(-1)).toBe("revoke blob:page/1");
  });

  it("still removes the link and schedules the revoke when the click throws", () => {
    const page = fakePage({ clickThrows: true });
    expect(() => downloadBlob("a.csv", new Blob(["x"]), page.env)).toThrow("blocked");
    expect(page.events.at(-1)).toBe("remove");
    expect(page.timers).toHaveLength(1);
  });
});

describe("downloadText", () => {
  it("saves exactly the text, with the type it was given", async () => {
    const page = fakePage();
    const text = "date_utc,kind\r\n2026-09-27,swap,\"a,b\"\r\n€ ✓\r\n";
    downloadText("spdex-activity.csv", "text/csv;charset=utf-8", text, page.env);
    expect(page.blobs).toHaveLength(1);
    expect(page.blobs[0]!.type).toBe("text/csv;charset=utf-8");
    expect(await page.blobs[0]!.text()).toBe(text);
    expect(page.link.download).toBe("spdex-activity.csv");
  });
});

describe("safeFileName", () => {
  it("leaves the names spDEX builds as they are", () => {
    for (const name of ["spdex-activity-690069-0xab12cd-2026-09-27.csv", "spdex-weekly-spx.ics", "spdex-card_1.png"]) {
      expect(safeFileName(name)).toBe(name);
    }
  });

  it("keeps a name out of other folders and hidden files", () => {
    expect(safeFileName("../../.bashrc")).toBe("spdex.bashrc");
    expect(safeFileName("..\\..\\evil.ics")).toBe("evil.ics");
    expect(safeFileName(".ics")).toBe("spdex.ics");
  });

  it("drops characters that can disguise a name", () => {
    // U+202E turns "spdex-gpj.exe" into what looks like "spdex-exe.jpg".
    expect(safeFileName("spdex-‮gpj.exe.ics")).toBe("spdex-gpj.exe.ics");
    expect(safeFileName("plan: my buys; 1/2.ics")).toBe("plan-my-buys-1-2.ics");
  });

  it("is never empty, and keeps the extension when it shortens a long name", () => {
    expect(safeFileName("")).toBe("spdex");
    expect(safeFileName("€€€.ics")).toBe("spdex.ics");
    const long = safeFileName(`${"a".repeat(300)}.csv`);
    expect(long.length).toBe(120);
    expect(long.endsWith("a.csv")).toBe(true);
  });
});
