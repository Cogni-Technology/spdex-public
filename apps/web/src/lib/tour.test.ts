import { describe, expect, it } from "vitest";
import { BUY_FEE_CEILING_BPS } from "@spdex/vault";
import { isTileId } from "./tiles.js";
import {
  BESIDE_MIN_WIDTH,
  TOUR_HELLO,
  TOUR_SEEN,
  TOUR_STOPS,
  besideWidth,
  placeBubble,
  scrollToShow,
  stopTargets,
  tourBack,
  tourNext,
  tourStartsOnArrival,
  type TourPlace,
} from "./tour.js";

const VIEW = { w: 1600, h: 900 };
const BUBBLE = { w: 300, h: 200 };

describe("the stops", () => {
  it("start at choosing a service, the one stop that takes clicks, and end back at Welcome", () => {
    expect(TOUR_STOPS[0]?.id).toBe("connect");
    expect(TOUR_STOPS.filter((stop) => stop.interactive === true).map((stop) => stop.id)).toEqual(["connect"]);
    expect(TOUR_STOPS[0]?.wait).toBe("Pick one to continue");
    expect(TOUR_STOPS.at(-1)?.tile).toBe("start");
    expect(new Set(TOUR_STOPS.map((stop) => stop.id)).size).toBe(TOUR_STOPS.length);
  });

  it("each open a tile the page has, point at something, and say something", () => {
    for (const stop of TOUR_STOPS) {
      expect(isTileId(stop.tile), stop.id).toBe(true);
      expect(stop.targets.length, stop.id).toBeGreaterThan(0);
      expect(stop.title.trim(), stop.id).not.toBe("");
      expect(stop.body.trim(), stop.id).not.toBe("");
    }
  });

  it("show Buy SPX's tabs where they point into it", () => {
    const tabs = Object.fromEntries(TOUR_STOPS.filter((stop) => stop.tile === "trade").map((stop) => [stop.id, stop.buyMode]));
    expect(tabs).toEqual({ buy: "once", tip: "once", recurring: "recurring", confirm: "recurring", vault: "recurring" });
  });

  it("point at something smaller on a sheet only where they say so", () => {
    const buy = TOUR_STOPS.find((stop) => stop.id === "buy")!;
    expect(stopTargets(buy, true)).toEqual(['[data-testid="buy-once"]']);
    expect(stopTargets(buy, false)).toEqual(['[data-tile="trade"]']);
    const tip = TOUR_STOPS.find((stop) => stop.id === "tip")!;
    expect(stopTargets(tip, true)).toEqual(stopTargets(tip, false));
  });

  it("say the buy fee's ceiling as the contract has it, and never that a tip is sent by itself", () => {
    const vault = TOUR_STOPS.find((stop) => stop.id === "vault")!;
    expect(vault.body).toContain(`${Number(BUY_FEE_CEILING_BPS) / 100}%`);
    const tip = TOUR_STOPS.find((stop) => stop.id === "tip")!;
    expect(tip.body).not.toMatch(/automatic/i);
  });
});

describe("moving through the tour", () => {
  it("goes from the welcome card through every stop, then ends", () => {
    let place: TourPlace | null = { phase: "hello" };
    const seen: string[] = [];
    while (place !== null) {
      seen.push(place.phase === "hello" ? "hello" : TOUR_STOPS[place.index]!.id);
      place = tourNext(place);
    }
    expect(seen).toEqual(["hello", ...TOUR_STOPS.map((stop) => stop.id)]);
  });

  it("goes back a stop at a time, and from the first stop to the welcome card", () => {
    expect(tourBack({ phase: "stop", index: 3 })).toEqual({ phase: "stop", index: 2 });
    expect(tourBack({ phase: "stop", index: 0 })).toEqual({ phase: "hello" });
    expect(tourBack({ phase: "hello" })).toEqual({ phase: "hello" });
  });

  it("starts by itself only for a newcomer who came for the page", () => {
    const newcomer = { seen: false, serviceChosen: false, welcomeShown: true, cameForSomething: false };
    expect(tourStartsOnArrival(newcomer)).toBe(true);
    expect(tourStartsOnArrival({ ...newcomer, seen: true })).toBe(false);
    expect(tourStartsOnArrival({ ...newcomer, serviceChosen: true })).toBe(false);
    expect(tourStartsOnArrival({ ...newcomer, welcomeShown: false })).toBe(false);
    expect(tourStartsOnArrival({ ...newcomer, cameForSomething: true })).toBe(false);
  });

  it('remembers finished or skipped as "seen", and anything else as not', () => {
    expect(TOUR_SEEN.parse("seen")).toBe(true);
    expect(TOUR_SEEN.parse(null)).toBe(false);
    expect(TOUR_SEEN.parse("")).toBe(false);
    expect(TOUR_SEEN.format(true)).toBe("seen");
  });
});

describe("the bubble's place on a wide screen", () => {
  it("is beside the place, on the right when there is room", () => {
    expect(placeBubble({ x: 400, y: 120, w: 800, h: 300 }, BUBBLE, VIEW)).toEqual({ left: 1222, top: 120 });
  });

  it("is on the left when only the left has room", () => {
    expect(placeBubble({ x: 500, y: 120, w: 1000, h: 300 }, BUBBLE, VIEW)).toEqual({ left: 178, top: 120 });
  });

  it("is under the place when neither side has room, or when the stop asks", () => {
    expect(placeBubble({ x: 100, y: 100, w: 1400, h: 200 }, BUBBLE, VIEW)).toEqual({ left: 1200, top: 322 });
    expect(placeBubble({ x: 400, y: 100, w: 800, h: 200 }, BUBBLE, VIEW, true)).toEqual({ left: 900, top: 322 });
  });

  it("narrows to the column beside the place, down to a floor, rather than cover it", () => {
    // A 720px centre column in a 1440px window: 324px on either side once the gaps are kept.
    const centre = { x: 360, y: 170, w: 720, h: 600 };
    expect(besideWidth(centre, 1440, 345)).toBe(324);
    expect(besideWidth(centre, 1440, 300)).toBe(300);
    expect(besideWidth({ x: 100, y: 0, w: 1300, h: 100 }, 1440, 345)).toBeNull();
    expect(besideWidth({ x: 0, y: 0, w: 1440 - 36 - BESIDE_MIN_WIDTH, h: 100 }, 1440, 345)).toBe(BESIDE_MIN_WIDTH);
    expect(placeBubble(centre, { w: 324, h: 300 }, { w: 1440, h: 900 }).left).toBe(1102);
  });

  it("stays inside the window", () => {
    expect(placeBubble({ x: 400, y: -500, w: 800, h: 300 }, BUBBLE, VIEW).top).toBe(14);
    expect(placeBubble({ x: 400, y: 850, w: 800, h: 300 }, BUBBLE, VIEW).top).toBe(VIEW.h - BUBBLE.h - 14);
  });
});

describe("scrolling a place into view", () => {
  const band = { top: 60, bottom: 600 };

  it("leaves a place that is already in the band", () => {
    expect(scrollToShow({ x: 0, y: 100, w: 300, h: 200 }, band)).toBe(0);
  });

  it("centres a place that fits", () => {
    // 540 tall band, a 200 tall place: 170 above it.
    expect(scrollToShow({ x: 0, y: 1000, w: 300, h: 200 }, band)).toBe(1000 - 60 - 170);
  });

  it("puts a place taller than the band at its top", () => {
    expect(scrollToShow({ x: 0, y: 1000, w: 300, h: 900 }, band)).toBe(1000 - 60 - 18);
  });
});

describe("the welcome card", () => {
  it("says what spDEX is, and describes its picture", () => {
    expect(TOUR_HELLO.title).toBe("Welcome to spDEX");
    expect(TOUR_HELLO.imageAlt).toMatch(/^Meme: /);
  });
});
