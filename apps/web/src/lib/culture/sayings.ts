/**
 * Three of the SPX6900 community's sayings, where spDEX quotes them.
 *
 * The community coined them; spx6900.com publishes each at its own address.
 * spDEX quotes only the saying, in capitals as the community writes it, says
 * whose it is, and links the page it is on: the site is "All rights
 * reserved", and a quote with a link is both fair to it and more useful than
 * a copy. spDEX calls them sayings and nothing grander.
 *
 * The sayings were read from the site's own bundle. Only the three spDEX
 * places are here, each where it answers a question the page raises:
 * - `no-chart`, beside pool statistics: why there is no price chart;
 * - `believe`, in how auto-buy works, after the line on dollar-cost averaging;
 * - `persist`, under Your stack.
 */

export type SayingId = "no-chart" | "believe" | "persist";

export const SAYINGS: Readonly<Record<SayingId, string>> = {
  "no-chart": "THERE IS NO CHART",
  believe: "STOP TRADING AND BELIEVE IN SOMETHING",
  persist: "PERSIST FOREVER",
};

/** Where spx6900.com keeps each saying: the number in its own address. */
const PAGE: Readonly<Record<SayingId, number>> = { "no-chart": 1, believe: 2, persist: 10 };

/** The saying's own page on spx6900.com: a link to follow, never a page spDEX reads. */
export function sayingUrl(id: SayingId): string {
  return `https://www.spx6900.com/commandment/${PAGE[id]}`;
}

/**
 * What spDEX says before each saying, when the place it sits doesn't say
 * otherwise. The first answers a question people ask; the others stand
 * alone, so a line about buying never reads as a call to buy.
 */
export const SAYING_LEADS: Readonly<Record<SayingId, string | null>> = {
  "no-chart": "No price chart here.",
  believe: null,
  persist: null,
};
