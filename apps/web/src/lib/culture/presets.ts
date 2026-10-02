/**
 * The amounts spDEX offers as one-tap choices.
 *
 * 69 and its tens are the SPX6900 community's own numbers, so the choices
 * speak its language: $6.90, $69 and $690 to buy, 69 buys for a plan, and
 * stack goals of 690, 6,900 and 69,000 SPX. Every list is in ascending order,
 * so nothing nudges anyone upward, and no choice is labelled "recommended".
 *
 * - **Dollar choices are whole cents,** so they are written exactly in any
 *   number format ("6.90" in en-US, "6,90" in de-DE) and never pass through a
 *   float. They say dollars whatever currency is chosen: it is the meme's own
 *   unit.
 * - **Recurring leaves out $690.** 69 buys of it would be $47,610.
 */

export const CULTURE_AMOUNT_PRESETS_USD_CENTS = [690, 6_900, 69_000] as const;

export const RECURRING_AMOUNT_PRESETS_USD_CENTS = [690, 6_900] as const;

/** How many buys a plan makes. */
export const CULTURE_COUNT_PRESETS = [69] as const;

/** Whole SPX. */
export const STACK_GOAL_PRESETS_SPX = [690, 6_900, 69_000] as const;
