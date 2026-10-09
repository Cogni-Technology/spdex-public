/** Which disclaimer a browser has seen: only the current version counts. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DISCLAIMER_CHANGES,
  DISCLAIMER_KEY,
  DISCLAIMER_PREF,
  DISCLAIMER_SECTIONS,
  DISCLAIMER_VERSION,
  disclaimerSeen,
  FOOTER_LINE,
  keyContinues,
  OFFICIAL_RELEASE,
  type GateKey,
} from "./disclaimer.js";
import { GLOSSARY } from "./names.js";

describe("disclaimer version", () => {
  it("is kept under its own key, as the version string", () => {
    expect(DISCLAIMER_KEY).toBe("spdex.disclaimer.v1");
    expect(DISCLAIMER_PREF.format(DISCLAIMER_VERSION)).toBe(DISCLAIMER_VERSION);
    expect(DISCLAIMER_PREF.parse(DISCLAIMER_VERSION)).toBe(DISCLAIMER_VERSION);
    expect(DISCLAIMER_PREF.parse(null)).toBeNull();
    expect(DISCLAIMER_PREF.parse("")).toBeNull();
  });

  it("counts as seen only at the current version", () => {
    expect(disclaimerSeen(DISCLAIMER_VERSION)).toBe(true);
    expect(disclaimerSeen(null)).toBe(false);
    expect(disclaimerSeen("2026-09")).toBe(false);
    expect(disclaimerSeen("2026-11", "2026-10")).toBe(false);
  });

  it("shows v2's text again to a browser that continued past the text that shipped first", () => {
    // 2026-10 is live at www.spdex.io; its section on vaults said whoever
    // triggers a buy is paid, which v2's community window made untrue.
    expect(DISCLAIMER_VERSION).not.toBe("2026-10");
    expect(disclaimerSeen("2026-10")).toBe(false);
  });

  it("imports nothing at run time, so the e2e fixtures can read it without the app", () => {
    const source = readFileSync(fileURLToPath(new URL("./disclaimer.ts", import.meta.url)), "utf8");
    const imports = [...source.matchAll(/^import\s+(?!type\b)[^;]*;/gm)].map((m) => m[0]);
    expect(imports).toEqual([]);
  });
});

describe("disclaimer text", () => {
  const all = [...DISCLAIMER_SECTIONS.map((s) => `${s.label} ${s.text}`), DISCLAIMER_CHANGES].join(" ");

  it("is short enough to read: ten numbered points, about 450 words", () => {
    expect(DISCLAIMER_SECTIONS).toHaveLength(10);
    const words = all.split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThan(300);
    expect(words).toBeLessThan(460);
  });

  it("names its version, so a changed text is recognisably a new one", () => {
    expect(DISCLAIMER_CHANGES).toContain(DISCLAIMER_VERSION);
  });

  it("says official once, of a release, and unofficial never, and keeps the honest limits", () => {
    // SPX6900 has no official team, so neither word measures anything about
    // it. The one use is "On an official release" (UI rule R8): a copy at the
    // address its publisher released it for.
    const text = `${all} ${FOOTER_LINE}`;
    expect(text.split(OFFICIAL_RELEASE)).toHaveLength(2);
    expect(text.replace(OFFICIAL_RELEASE, "")).not.toMatch(/official/i);
    for (const phrase of ["Community project.", "speaks only for itself", "built, runs, reviewed or endorses", "not been independently audited", "can't be undone", "up to 0.69%, including network costs", "IP address", "never shows it as zero"]) {
      expect(all).toContain(phrase);
    }
    expect(FOOTER_LINE).toMatch(/^Community project\./);
    expect(`${all} ${FOOTER_LINE}`).not.toMatch(/fan-made/i);
  });

  it("says which network service is used in words true of every copy, as the glossary does", () => {
    // The built-in service exists only at a release's own address (lib/store.ts
    // `bundledRpcAvailable`); elsewhere the chooser says it isn't offered.
    const services = DISCLAIMER_SECTIONS[6]!.text;
    expect(services).toContain(
      `can see your IP address: the one you choose on the first screen. ${OFFICIAL_RELEASE}, the publisher's built-in service is among the choices.`,
    );
    // The glossary says the same in its own words.
    expect(GLOSSARY.networkService).toContain(
      "through a network service (an RPC endpoint): the one you choose when you first open it.",
    );
    expect(`${services} ${GLOSSARY.networkService}`).not.toMatch(/: the built-in one,? (?:set up by this copy's publisher, )?unless/);
  });

  it("says who a vault pays, as v2's vaults do: whoever makes the buy or a wallet they name, and only you or a proven holder at first", () => {
    const vaults = DISCLAIMER_SECTIONS[4]!;
    expect(vaults.label).toBe("Auto-buy vaults.");
    // execute(rewardTo): the caller names who receives its own fee, and
    // nothing about the buy, which follows the signed rules whoever makes it.
    expect(vaults.text).toContain("no matter who makes the buy");
    expect(vaults.text).toContain("up to 0.69%, including network costs, to whoever makes it or a wallet they name");
    // Inside the community window the vault refuses any rewardTo but the
    // owner or one the registry finds eligible (MIN_SPX, 690 SPX).
    // "New vaults", since no app version is shown to say "from this version
    // on"; "up to an hour", the longest window (MAX_COMMUNITY_WINDOW), which
    // "the first minutes" understated.
    expect(vaults.text).toContain("New vaults pay only you or a proven holder of 690 SPX for up to an hour after a buy is due.");
    expect(vaults.text).not.toMatch(/this version|first minutes/);
    // The developers' keeper proves and is paid like anyone's.
    expect(vaults.text).toContain("Whoever is paid may be one of spDEX's developers.");
    // v1's wording, untrue of a v2 vault inside its window.
    expect(all).not.toMatch(/triggers/);
  });

  it("calls every contract unaudited, the SPX holder registry included, not only the vaults", () => {
    const unaudited = DISCLAIMER_SECTIONS[5]!.text;
    expect(unaudited).toMatch(/^spDEX and its contracts are a prototype\. They have not been independently audited/);
    expect(unaudited).not.toContain("vault contracts");
  });

  it("uses none of spx6900.com's legal wording, and claims nothing about SPX6900's team or plans", () => {
    expect(all).not.toMatch(/intrinsic value|formal team|roadmap|expectation of financial return|no affiliations/i);
  });

  it("says beside the text that no lawyer has reviewed it", () => {
    const source = readFileSync(fileURLToPath(new URL("./disclaimer.ts", import.meta.url)), "utf8");
    expect(source).toContain("NOT REVIEWED BY A LAWYER");
  });
});

describe("which keys continue past the gate", () => {
  const key = (k: string, extra: Partial<GateKey> = {}): GateKey => ({
    key: k,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...extra,
  });

  it("continues on a key pressed on purpose", () => {
    for (const k of ["Enter", "Escape", "a", "Z", "1", "Backspace"]) expect(keyContinues(key(k)), k).toBe(true);
  });

  it("never on a key that scrolls the text or moves focus", () => {
    for (const k of ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " ", "Tab"]) expect(keyContinues(key(k)), k).toBe(false);
  });

  it("never on a modifier, a lock, a function key or a key mid-composition", () => {
    for (const k of ["Shift", "Control", "Alt", "Meta", "CapsLock", "F1", "F5", "F12", "Dead", "Process", "Unidentified"]) {
      expect(keyContinues(key(k)), k).toBe(false);
    }
    expect(keyContinues(key("a", { isComposing: true }))).toBe(false);
  });

  it("never on a shortcut or a held key", () => {
    expect(keyContinues(key("c", { ctrlKey: true }))).toBe(false);
    expect(keyContinues(key("c", { metaKey: true }))).toBe(false);
    expect(keyContinues(key("c", { altKey: true }))).toBe(false);
    expect(keyContinues(key("Enter", { repeat: true }))).toBe(false);
  });
});
