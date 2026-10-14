/**
 * The first-visit tour: what it says, what each stop points at, and where its
 * bubble goes.
 *
 * A newcomer continues past the disclaimer and gets the welcome card (the
 * same frame as the disclaimer, so the two read as one popup's two pages),
 * then a walk round the page: a spotlight on one place at a time and a short
 * bubble beside it. The first stop is the only one that takes clicks:
 * Welcome's first step, choosing how spDEX reaches Ethereum, and Next waits
 * for that choice. Every other stop only points; the page behind is inert.
 * The footer offers the tour again ("Show me around again").
 *
 * The words are the publisher's script, verbatim. A bubble's text is never a
 * place's only copy of a limit: the vault card it points at keeps UNAUDITED,
 * the buy fee and the 0.5 ETH cap on screen (UI rule R6).
 *
 * Whether the tour has been finished or skipped is kept in this browser
 * (`spdex.tour.v1`), like Welcome's hide, never in the config. It starts by
 * itself only right after a first visit's disclaimer, for someone who hasn't
 * chosen a network service yet, so no returning visitor is walked round a
 * page they know.
 *
 * Free of React and the DOM, and of any import but `Pref`'s type: the page
 * lays the tour out from these (components/tour), and the e2e fixtures and
 * specs read them without pulling in the app, as they do lib/disclaimer.ts.
 */

import type { Pref } from "./prefs.js";

/** The tiles the tour opens (TileId in lib/tiles.ts, which tour.test.ts checks them against). */
export type TourTile = "start" | "trade" | "yours" | "community";

// ─── The welcome card ─────────────────────────────────────────────────────────

export const TOUR_HELLO = {
  chip: "welcome tour",
  title: "Welcome to spDEX",
  body: "A decentralized exchange custom-built for the SPX6900 community that prioritizes privacy and convenience.",
  /** Wide screens only: the picture beside it leaves the room. */
  more: "You can buy SPX once, set up a DCA plan, or tip other aeons. This short tour will show you where all of the major features are.",
  go: "Show me around",
  skip: "Skip the tour",
  imageAlt:
    "Meme: a financial advisor says to put only 3% of your net worth in Bitcoin. The reply: 3% BTC, 97% SPX6900.",
} as const;

// ─── Connecting, in Welcome's first step ──────────────────────────────────────

export const CONNECT_COPY = {
  title: "Connect to Ethereum",
  lead: "In order to DCA into SPX6900, you must first connect to the Ethereum network.",
  privacy: "The service you pick sees your IP address, the addresses you look up and what you send.",
  own: "More private: spDEX's team never sees what you look up. More reliable: nobody else shares it.",
  builtIn:
    "The built-in service is provided by the spDEX team as a courtesy to SPX community members. Everyone shares it, so it can be slower or busy at times.",
  public: "Limited: swaps aren't safety-checked, and auto-buy won't work.",
} as const;

/** The status panel's way to the first step while no service is chosen. */
export const STATUS_CONNECT = "Connect to Ethereum →";

/** The footer's way back into the tour. */
export const TOUR_REPLAY = "Show me around again";

// ─── The stops ────────────────────────────────────────────────────────────────

export type TourStopId =
  | "connect"
  | "payoff"
  | "buy"
  | "tip"
  | "recurring"
  | "confirm"
  | "vault"
  | "stack"
  | "collective"
  | "handoff";

export interface TourStop {
  id: TourStopId;
  title: string;
  body: string;
  /** What the spotlight frames: selectors, each a place on the page. */
  targets: readonly string[];
  /**
   * On a narrow screen, where the bubble is a sheet at the bottom: smaller
   * places, so what is pointed at fits above it.
   */
  sheetTargets?: readonly string[];
  /** The tile opened for it. */
  tile: TourTile;
  /** The Buy SPX tab shown for it. */
  buyMode?: "once" | "recurring";
  /** Takes clicks inside the spotlight, and Next waits until it is done. */
  interactive?: boolean;
  /** What the bubble says while Next waits. */
  wait?: string;
  /** On a wide screen, the bubble under the first place rather than beside it. */
  below?: boolean;
}

const byTestId = (id: string) => `[data-testid="${id}"]`;
const byTile = (id: TourTile) => `[data-tile="${id}"]`;

export const TOUR_STOPS: readonly TourStop[] = [
  {
    id: "connect",
    title: "Connect to Ethereum",
    body: "You must first connect to the Ethereum network to interact with this app.",
    targets: [byTestId("welcome-step-1")],
    tile: "start",
    interactive: true,
    wait: "Pick one to continue",
  },
  {
    id: "payoff",
    title: "You’re connected!",
    body: "Now you'll see you are online and can read blockchain data through your network service.",
    targets: [byTestId("status-widget"), byTestId("ticker")],
    tile: "start",
    below: true,
  },
  {
    id: "buy",
    title: "Buy SPX",
    body: "Your first option is a one-time purchase. No purchase is made until you press swap and confirm in your wallet pop-up.",
    targets: [byTile("trade")],
    sheetTargets: [byTestId("buy-once")],
    tile: "trade",
    buyMode: "once",
  },
  {
    id: "tip",
    title: "Tip other aeons",
    body:
      "An important part of SPX culture is tipping people for their hard work. We offer the ability to tip a " +
      "percentage of your swaps to others. Simply add their wallet address and select a percent to send them.",
    targets: [byTestId("tip-row")],
    tile: "trade",
    buyMode: "once",
  },
  {
    id: "recurring",
    title: "Auto-buy",
    body:
      'spDEX also offers an auto-buy feature. In this mode, you can either confirm each buy yourself or "set and ' +
      'forget" automatic recurring buys.',
    targets: [byTestId("buy-mode")],
    tile: "trade",
    buyMode: "recurring",
  },
  {
    id: "confirm",
    title: "Confirm each buy myself",
    body:
      "We understand some people want to manually press the buy button themselves. Those people can click " +
      '"Confirm each buy myself". Your wallet will ask you to confirm and spDEX must stay open.',
    targets: [byTestId("dca-form-signer-wallet")],
    tile: "trade",
    buyMode: "recurring",
  },
  {
    id: "vault",
    title: "Set and forget",
    body:
      'For those that prefer the automated "set and forget" style, we offer that option as well. A vault you own ' +
      "holds a budget and buys without keeping the app open. The buy fee is capped at 0.69% of each buy.",
    targets: [byTestId("dca-form-signer-vault")],
    tile: "trade",
    buyMode: "recurring",
  },
  {
    id: "stack",
    title: "Your SPX",
    body:
      "Here you can see a number of statistics related to your own SPX stack. But remember, there is no chart. Do " +
      "not get obsessed with stats and numbers.",
    targets: [byTile("yours")],
    tile: "yours",
  },
  {
    id: "collective",
    title: "Collective DCA",
    body: "A neat display of how many other aeons are collectively DCA'ing. Note: this card only counts spDEX's set-and-forget vaults.",
    targets: [byTile("community")],
    tile: "community",
  },
  {
    id: "handoff",
    title: "What next",
    body:
      "Now that you're familiar with the platform, check out the next steps here. Connect your wallet and start " +
      "your DCA plan today.",
    targets: [byTile("start")],
    tile: "start",
  },
];

/** The places a stop frames on a screen of this kind. */
export function stopTargets(stop: TourStop, sheet: boolean): readonly string[] {
  return sheet && stop.sheetTargets !== undefined ? stop.sheetTargets : stop.targets;
}

// ─── Where the tour is ────────────────────────────────────────────────────────

/** The welcome card, then the stops by index. */
export type TourPlace = { phase: "hello" } | { phase: "stop"; index: number };

/** Next from `place`, or null once past the last stop. */
export function tourNext(place: TourPlace): TourPlace | null {
  if (place.phase === "hello") return { phase: "stop", index: 0 };
  return place.index + 1 < TOUR_STOPS.length ? { phase: "stop", index: place.index + 1 } : null;
}

/** Back from `place`: the first stop goes back to the welcome card. */
export function tourBack(place: TourPlace): TourPlace {
  if (place.phase === "hello" || place.index === 0) return { phase: "hello" };
  return { phase: "stop", index: place.index - 1 };
}

/** Whether the tour should start by itself when a first visit's disclaimer closes. */
export function tourStartsOnArrival(state: {
  /** Finished or skipped in this browser before. */
  seen: boolean;
  /** A network service is already chosen: not a newcomer to this page. */
  serviceChosen: boolean;
  /** Welcome is on the page: the first stop is its first step. */
  welcomeShown: boolean;
  /** The visit came for something else: a shared transaction, or a settings link. */
  cameForSomething: boolean;
}): boolean {
  return !state.seen && !state.serviceChosen && state.welcomeShown && !state.cameForSomething;
}

/** "seen" once the tour is finished or skipped in this browser. */
export const TOUR_KEY = "spdex.tour.v1";

export const TOUR_SEEN: Pref<boolean> = {
  key: TOUR_KEY,
  parse: (raw) => raw === "seen",
  format: (seen) => (seen ? "seen" : ""),
};

/** How long a stop must have been up before Next or Enter moves on: a double click is not two steps. */
export const TOUR_ARM_MS = 400;

// ─── Where the bubble goes on a wide screen ──────────────────────────────────

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Room kept between the bubble and the place, and between the bubble and the window's edge. */
const GAP = 22;
const EDGE = 14;

/** The narrowest a bubble beside a place may be before it goes under it instead. */
export const BESIDE_MIN_WIDTH = 240;

/**
 * How wide the bubble is beside the place: its own width where that fits in
 * the room on either side, else the room there is (a side column is about
 * 17rem), down to `BESIDE_MIN_WIDTH`; null where neither side has that much,
 * and it goes under the place at its own width.
 */
export function besideWidth(place: Box, viewWidth: number, natural: number): number | null {
  const right = viewWidth - EDGE - (place.x + place.w + GAP);
  const left = place.x - GAP - EDGE;
  const room = Math.floor(Math.max(right, left));
  return room < BESIDE_MIN_WIDTH ? null : Math.min(natural, room);
}

/**
 * Where the bubble goes, in window coordinates: beside the place (right,
 * else left) when there is room, otherwise under it; then kept inside the
 * window, and level with the place's top while the place is on screen.
 */
export function placeBubble(
  place: Box,
  bubble: { w: number; h: number },
  view: { w: number; h: number },
  below = false,
): { left: number; top: number } {
  const right = view.w - EDGE - (place.x + place.w + GAP);
  const left = place.x - GAP - EDGE;
  let x: number;
  let y: number;
  if (!below && right >= bubble.w) {
    x = place.x + place.w + GAP;
    y = place.y;
  } else if (!below && left >= bubble.w) {
    x = place.x - GAP - bubble.w;
    y = place.y;
  } else {
    x = place.x + place.w - bubble.w;
    y = place.y + place.h + GAP;
  }
  x = Math.min(Math.max(x, EDGE), Math.max(EDGE, view.w - bubble.w - EDGE));
  y = Math.min(Math.max(y, EDGE), Math.max(EDGE, view.h - bubble.h - EDGE));
  return { left: Math.round(x), top: Math.round(y) };
}

/**
 * How far to scroll so the place shows in the band the bubble leaves free
 * (`top` to `bottom`, window coordinates): centred when it fits, its top at
 * the band's top when it doesn't. Zero when it is already wholly inside.
 */
export function scrollToShow(place: Box, band: { top: number; bottom: number }): number {
  const room = band.bottom - band.top;
  const pad = 18;
  if (place.y >= band.top + 4 && place.y + place.h <= band.bottom - 4) return 0;
  if (place.h + 2 * pad > room) return Math.round(place.y - band.top - pad);
  return Math.round(place.y - band.top - (room - place.h) / 2);
}
