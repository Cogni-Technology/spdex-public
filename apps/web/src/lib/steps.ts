/**
 * What spDEX is doing right now, in one sentence.
 *
 * A manual swap and an auto-buy walk the same road — price, check, permission,
 * the trade itself, the wait for the network — so the words for each step are
 * written once, here, and both status lines (`swap-status` and a plan card's
 * `dca-status`) come from this function. That is the only way the two can't
 * drift into describing the same wallet prompt differently.
 *
 * Rules the wording keeps, because tests and people depend on them:
 *
 * - **Every prompt is named for what the wallet will show.** "Confirm the
 *   permission to spend WETH" rather than "Approving WETH": the wallet's own
 *   screen says approve/permission, and the old "Approving…" read as if spDEX
 *   were doing it. The word "Approving" is retired.
 * - **The deadline is stated.** A wallet that broadcasts by itself can't be
 *   stopped once it signs, and a transaction confirmed after its deadline
 *   reverts and still costs the fee. Saying "before 14:05" is the only warning
 *   the user can act on.
 * - **"privately" only on the private path.** A swap the user agreed to send
 *   publicly must never be described as private, so only the `private` and
 *   `sign` (private) steps use the word.
 * - **"(step i of n)" only when n > 1.** One prompt needs no count, and a count
 *   that was wrong would be worse than none, so callers pass the exact number.
 *
 * Terminal strings ("Swap complete — …", "Cancelled in your wallet.") are not
 * steps and stay with their callers, byte-identical.
 */

export type Step =
  /** Auto-buy only: asking the markets for a fresh price. */
  | { kind: "quote" }
  /** Auto-buy only: the Guard's test run. */
  | { kind: "check" }
  /** A wallet prompt for an exact ERC-20 allowance. */
  | { kind: "permission"; symbol: string; step: number; of: number }
  /**
   * A wallet prompt for the trade. `deadline` is the transaction's own
   * deadline (unix seconds); null when it isn't known, and then no time is
   * promised.
   */
  | { kind: "swap" | "buy"; deadline: number | null; step: number; of: number }
  /** The wallet signed and spDEX posts it to the private relay. */
  | { kind: "private" }
  /** Sent; waiting for a receipt. */
  | { kind: "wait" }
  /**
   * A wallet prompt for one of the configured tips, sent as its own
   * transaction: tip `index` of `count`. `why` says why they go one at a time
   * when a batch was expected (the same clause the final note ends with), or
   * is null when there was never going to be a batch.
   */
  | { kind: "tip"; index: number; count: number; why: string | null; step: number; of: number }
  /**
   * The permission for Permit2 on the tip token, asked the first time tips
   * are batched, after the signature. Explained where it is asked, in full:
   * it is unlimited, it stands until revoked, and it is the only permission
   * spDEX ever asks for without a limit.
   */
  | { kind: "tip-permission"; symbol: string; step: number; of: number }
  /**
   * The signature that lets one transaction pay every recipient, described
   * as the wallet will show it: Permit2, the amounts (as the page shows them
   * and in the token's raw units, which is how a wallet shows a uint256), the
   * user as spender, and how long it stays valid. It is the first of the
   * batch's prompts; `permissionNext` says the standing permission for
   * Permit2 comes after it, before the transaction that uses it.
   */
  | {
      kind: "tip-sign";
      symbol: string;
      amounts: { shown: string; raw: string }[];
      minutes: number;
      permissionNext: boolean;
      step: number;
      of: number;
    }
  /**
   * The one transaction that pays every recipient. The wallet shows only a
   * call to Permit2, so the status names who gets what. `tested` is whether
   * the Guard test-ran it, or could only check it.
   */
  | {
      kind: "tip-batch";
      symbol: string;
      payments: { name: string; shown: string }[];
      tested: boolean;
      step: number;
      of: number;
    };

export interface StepTextOptions {
  /**
   * Formats a deadline (unix seconds) as the user reads a clock. Defaults to
   * this device's local "HH:MM". Injected so tests don't depend on the
   * machine's time zone.
   */
  formatTime?: (unixSeconds: number) => string;
}

/** "14:05" in this device's time zone, 24-hour, which never needs an am/pm. */
export function localClock(unixSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(unixSeconds * 1_000),
  );
}

function position(step: number, of: number): string {
  return of > 1 ? ` (step ${step} of ${of})` : "";
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** True when every entry is the same, so "each" can say it once. */
const allSame = (values: readonly string[]) => values.every((value) => value === values[0]);

export function stepText(step: Step, options: StepTextOptions = {}): string {
  const formatTime = options.formatTime ?? localClock;
  switch (step.kind) {
    case "quote":
      return "Getting a price…";
    case "check":
      return "Running the safety check…";
    case "permission":
      return `Confirm the permission to spend ${step.symbol} in your wallet${position(step.step, step.of)}…`;
    case "swap":
    case "buy": {
      const before =
        step.deadline !== null && Number.isFinite(step.deadline) ? ` before ${formatTime(step.deadline)}` : "";
      return `Confirm the ${step.kind} in your wallet${before}${position(step.step, step.of)}…`;
    }
    case "private":
      return "Sending privately…";
    case "wait":
      return "Waiting for the network…";
    case "tip": {
      const why = step.why ? `Each tip goes as its own transaction: ${step.why}. ` : "";
      const which = step.count === 1 ? "the tip" : `tip ${step.index} of ${step.count}`;
      return `${why}Confirm ${which} in your wallet${position(step.step, step.of)}…`;
    }
    case "tip-permission":
      // Said in full, because this is the one place it is said while the
      // wallet asks: unlimited, standing, and not only spDEX's to use. "Asked
      // once" rather than "one-time", which read as single-use. It comes
      // after the signature, so declining leaves that signature unused.
      return (
        `Asked once: let Permit2 (Uniswap's contract) move your ${step.symbol}, with no limit, until you revoke it ` +
        "in Settings → Tips. Permit2 moves it only on a signature or a Permit2 approval you give. spDEX checks the " +
        `ones it asks for; one another site asks for can move this ${step.symbol} too. Confirm in your wallet` +
        `${position(step.step, step.of)}, or decline: each tip then goes as its own transaction, and the ` +
        "signature you just gave goes unused…"
      );
    case "tip-sign": {
      // What the wallet will show, so it can be compared: amounts in raw
      // units too, because that is how a wallet shows a uint256.
      const shown = step.amounts.map((amount) => amount.shown);
      const raw = step.amounts.map((amount) => amount.raw);
      const amounts = allSame(shown) && allSame(raw)
        ? `${step.symbol} ${shown[0]} each (${raw[0]} in raw units)`
        : `${step.symbol} ${listed(shown)} (${listed(raw)} in raw units)`;
      // Which transaction uses it is said exactly: the next one, or, the
      // first time, the one after the permission for Permit2.
      const uses = step.permissionNext
        ? "only a transaction you send can use it. Next comes the permission for Permit2, then the transaction " +
          "that uses it and names who gets paid…"
        : "only the transaction you send next can use it, and that one names who gets paid…";
      return (
        `Sign in your wallet${position(step.step, step.of)}. It shows Permit2, ${amounts}, spender: your own ` +
        `address, valid ${step.minutes} minutes. spDEX checked it first. It names nobody and moves nothing by ` +
        `itself: ${uses}`
      );
    }
    case "tip-batch": {
      // The wallet shows a call to Permit2 and little else, so who gets what
      // is said here.
      const shown = step.payments.map((payment) => payment.shown);
      const pays = allSame(shown)
        ? `${shown[0]} ${step.symbol} each to ${listed(step.payments.map((payment) => payment.name))}`
        : listed(step.payments.map((payment) => `${payment.shown} ${step.symbol} to ${payment.name}`));
      return (
        `Confirm the tip in your wallet${position(step.step, step.of)}: one transaction to Permit2 pays ${pays}. ` +
        (step.tested ? "spDEX checked and test-ran it…" : "spDEX checked it, but your network service can't test-run it…")
      );
    }
  }
}

/**
 * Numbers a sequence of wallet prompts exactly.
 *
 * The total is fixed before the first prompt — the caller reads every
 * allowance first and counts only the permissions still needed plus the
 * trades — and each prompt takes the next number. If a prompt arrives that
 * wasn't counted (an allowance that changed between the read and the send),
 * the total grows with it rather than ever printing "step 3 of 2".
 */
export class StepCounter {
  #done = 0;
  #total: number;

  constructor(total: number) {
    this.#total = Math.max(1, Math.floor(total));
  }

  /** The next prompt's number and the total, e.g. `{ step: 2, of: 3 }`. */
  next(): { step: number; of: number } {
    this.#done += 1;
    if (this.#done > this.#total) this.#total = this.#done;
    return { step: this.#done, of: this.#total };
  }

  /**
   * From here on, exactly `remaining` more prompts. For a sequence whose
   * later part is only known once it is reached: a swap's tips are counted
   * from what the page knew before the swap, and settled here once the tip
   * flow has read what it needs, or has had to change course.
   */
  expectMore(remaining: number): void {
    this.#total = Math.max(1, this.#done + Math.max(0, Math.floor(remaining)));
  }
}
