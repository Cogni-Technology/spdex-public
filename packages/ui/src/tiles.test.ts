/**
 * The tile keyboard: where ↑ ↓ Home End move focus from a tile header. Pure,
 * so it is checked here rather than in a browser; shell.spec checks the keys
 * reach it.
 */

import { describe, expect, it } from "vitest";
import { tileKeyTarget } from "./components.js";

const IDS = ["trade", "auto-buys", "yours", "settings"] as const;

describe("tileKeyTarget", () => {
  it("moves to the next and previous header", () => {
    expect(tileKeyTarget(IDS, "trade", "ArrowDown")).toBe("auto-buys");
    expect(tileKeyTarget(IDS, "yours", "ArrowDown")).toBe("settings");
    expect(tileKeyTarget(IDS, "yours", "ArrowUp")).toBe("auto-buys");
    expect(tileKeyTarget(IDS, "auto-buys", "ArrowUp")).toBe("trade");
  });

  it("does not wrap at either end", () => {
    expect(tileKeyTarget(IDS, "settings", "ArrowDown")).toBeNull();
    expect(tileKeyTarget(IDS, "trade", "ArrowUp")).toBeNull();
  });

  it("goes to the first and last header on Home and End, from anywhere", () => {
    expect(tileKeyTarget(IDS, "yours", "Home")).toBe("trade");
    expect(tileKeyTarget(IDS, "trade", "End")).toBe("settings");
    expect(tileKeyTarget(IDS, null, "Home")).toBe("trade");
    expect(tileKeyTarget(IDS, "not-a-tile", "End")).toBe("settings");
  });

  it("leaves every other key alone, and arrows from an unknown tile", () => {
    for (const key of ["Enter", " ", "Escape", "Tab", "ArrowLeft", "ArrowRight", "PageDown"]) {
      expect(tileKeyTarget(IDS, "yours", key), key).toBeNull();
    }
    expect(tileKeyTarget(IDS, "not-a-tile", "ArrowDown")).toBeNull();
    expect(tileKeyTarget(IDS, null, "ArrowUp")).toBeNull();
  });

  it("has nowhere to go without tiles", () => {
    expect(tileKeyTarget([], null, "Home")).toBeNull();
    expect(tileKeyTarget([], null, "End")).toBeNull();
  });

  it("works with a single tile", () => {
    expect(tileKeyTarget(["trade"], "trade", "ArrowDown")).toBeNull();
    expect(tileKeyTarget(["trade"], "trade", "Home")).toBe("trade");
  });
});
