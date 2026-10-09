/**
 * Every place the copy points to exists: its test id is rendered somewhere in
 * the app's source, and a place only the Expert view has says so, so `reveal`
 * switches views for it.
 *
 * Read from the source rather than a rendered page, which a node test doesn't
 * have; shell.spec follows each `GoTo` on the real page.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isExpertOnly, PLACES, type Place } from "./places.js";

const SRC = fileURLToPath(new URL("../", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// Without the list of places itself, which names every test id.
const FILES = new Map(
  sources(SRC)
    .map((file) => file.slice(SRC.length))
    .filter((file) => file !== "lib/places.tsx")
    .map((file) => [file, readFileSync(join(SRC, file), "utf8")]),
);

/** The files that render `testId` as a test id: `testId="…"`, `data-testid="…"` or `testId: "…"`. */
function renderedIn(testId: string): string[] {
  const pattern = new RegExp(`(?:testId|data-testid)\\s*[=:]\\s*\\{?\\s*["'\`]${testId}["'\`]`);
  return [...FILES].filter(([, source]) => pattern.test(source)).map(([file]) => file);
}

/**
 * Places whose section hasn't landed yet: until it does, `GoTo` shows the
 * label as text. Each entry goes as its section
 * lands, and the test fails if one is left here after it has.
 */
const PENDING: Record<string, string> = {};

describe("places", () => {
  const entries = Object.entries(PLACES) as [string, Place][];

  it("reads the source", () => {
    expect(FILES.size).toBeGreaterThan(50);
    expect(renderedIn("swap-panel").length).toBeGreaterThan(0);
  });

  for (const [key, place] of entries) {
    it(`${key}: ${place.testId} is rendered${PENDING[place.testId] ? " (pending)" : ""}`, () => {
      const files = renderedIn(place.testId);
      if (PENDING[place.testId]) {
        expect(files, `${place.testId} has landed: take it out of PENDING`).toEqual([]);
      } else {
        expect(files, place.testId).not.toEqual([]);
      }
    });
  }

  it("labels each as where to find it, never through the Expert view", () => {
    for (const [key, place] of entries) {
      expect(place.label, key).toMatch(/^(Settings|Your SPX) → [A-Z]/);
      expect(place.label, key).not.toMatch(/Expert/);
    }
  });

  it("knows which live only in the Expert view", () => {
    expect(isExpertOnly("expert-submitter")).toBe(true);
    expect(isExpertOnly("config-panel")).toBe(true);
    expect(isExpertOnly("settings-network")).toBe(false);
    expect(isExpertOnly("swap-panel")).toBe(false);
    for (const [, place] of entries.filter(([, p]) => p.view === "expert")) {
      // An Expert-only place is rendered by the Expert view's own components.
      const files = renderedIn(place.testId);
      expect(files.every((file) => /components\/(Expert|ConfigIo)\.tsx$/.test(file)), place.testId).toBe(true);
    }
  });
});
