/**
 * Which version of the disclaimer this browser has been shown.
 *
 * The gate (components/shell/DisclaimerGate.tsx) shows the disclaimer on a
 * first visit and again whenever its text changes, which is what the version
 * is for: change the text, bump `DISCLAIMER_VERSION`, and every browser sees
 * it once more. The version shown last is kept per browser under
 * `spdex.disclaimer.v1` and never sent anywhere. Storage that throws keeps it
 * for the visit only (`createPrefStore`), so a blocked site sees the gate once
 * per visit rather than never.
 *
 * Deliberately free of runtime imports: the e2e fixtures import the version
 * and the key from here to seed a browser past the gate, and they must not
 * pull in the app to do it.
 */

import type { Pref } from "./prefs.js";

/** Bump when the disclaimer's text changes, so every browser is shown it again. */
export const DISCLAIMER_VERSION = "2026-10b";

export const DISCLAIMER_KEY = "spdex.disclaimer.v1";

/** The version this browser last continued past, or null for none. */
export const DISCLAIMER_PREF: Pref<string | null> = {
  key: DISCLAIMER_KEY,
  parse: (raw) => (raw === null || raw === "" ? null : raw),
  format: (version) => version,
};

/** Whether a browser that last saw `stored` has seen the current text. Any other value, older or unknown, has not. */
export function disclaimerSeen(
  stored: string | null,
  version: string = DISCLAIMER_VERSION,
): boolean {
  return stored === version;
}

// ─── The text ─────────────────────────────────────────────────────────────────

/*
 * NOT REVIEWED BY A LAWYER. This text is original, written for spDEX. The
 * community prototype is published without a lawyer's review, a risk its
 * publisher accepted on 2026-10-02; a release beyond the prototype should have
 * one read it first. It informs; it is not a clickwrap agreement. Change a
 * word, bump DISCLAIMER_VERSION: 2026-10 shipped, and 2026-10b is its text
 * checked again against v2's vaults (who may be paid a buy's fee, and the
 * registry among "its contracts").
 *
 * Every sentence must be true of the code (UI rule R3, docs/ARCHITECTURE.md).
 * Re-check these sources whenever a signing path changes:
 *   3: spDEX promises no return (no copy in the app does; its slogans are
 *      point 8's jokes); the token is an ERC-20 with no reserve behind it.
 *      Says nothing about SPX6900's team or plans, which no code here can
 *      check, and uses no wording of spx6900.com's (UI rule R8).
 *   4: no servers (AGENTS.md rule 5); your wallet signs (lib/execute.ts,
 *      lib/submit.ts, the Guard path), every transaction it prepares: since
 *      2026-10-02 nothing in the app signs with a key of its own (the old
 *      spending wallets' withdrawals were removed; senders.ts).
 *   5: a vault's terms are fixed when it is created, and `execute`'s one
 *      parameter (v2) names only who receives the caller's own fee, nothing
 *      about the buy (AGENTS.md rule 6; the forge fuzz test that any two
 *      accepted `rewardTo` give byte-identical buys). The buy fee, at most
 *      0.69% with the network cost included (BUY_FEE_CEILING_BPS, which is
 *      the contract's MAX_REWARD_BPS), goes to the caller in a v1 vault
 *      (or the `rewardTo` its batcher's caller names) and to the `rewardTo`
 *      the caller names in a v2 one. The app creates v2 vaults only
 *      (`encodeCreateVault`, the v2 factory). Inside a v2 vault's community
 *      window (60 s to an hour, `VaultLimits`) `rewardTo` must be the owner
 *      or pass the registry's `isEligible`: a proof of holding MIN_SPX (690
 *      SPX) at a recent block, and that much now (SpdexDcaVault
 *      `NotEligible`, SpxHolderRegistry). The developers' keeper is paid
 *      like anyone (V2_UPGRADE.md decision 28).
 *   6: licence AGPL-3.0-or-later in every package.json; "its contracts" are
 *      the vault, factory, batcher and SPX holder registry, all unaudited
 *      (packages/vault; V2_UPGRADE.md decision 30).
 *   7: "an official release" is a copy at an address its publisher released
 *      it for, the canonical origins its key is allowlisted to (UI rule R8
 *      allows the word here and nowhere else: `OFFICIAL_RELEASE`); the
 *      built-in service is the publisher's key, used without a screen
 *      where the key is allowlisted, after this text is continued past, and
 *      by a button elsewhere (lib/store.ts `autoBundledRpc`,
 *      `bundledRpcAvailable`; App.tsx); not offered at all without a key or
 *      away from a canonical origin, where the chooser asks for one
 *      (FirstRun.tsx, `rpc-no-bundled-note`); another is one click away
 *      (Settings → Network service, Change service); a service sees your
 *      IP address (FirstRun.tsx, the glossary); modules and tip lists are
 *      untrusted (modules/tiplist-spx-community/module.js); settings links
 *      (ConfigIo.tsx); check the build (components/network/VerifyBuild.tsx).
 *   8: rates (lib/money/rates.ts), fee estimates (lib/dca/form.ts), unknown
 *      is never zero (AGENTS.md). "Never shown as zero", not "shown as
 *      unknown": some panels show a dash for a figure they couldn't read.
 */

/**
 * The one place spDEX says "official" (UI rule R8, docs/ARCHITECTURE.md): a
 * release, meaning a copy at the address its publisher released it for. Never
 * spDEX's standing with SPX6900, which has no official anything. The copy
 * checks remove exactly this and still refuse the word anywhere else.
 */
export const OFFICIAL_RELEASE = "On an official release";

/** The disclaimer, a numbered section at a time: a short label, then its sentences. */
export const DISCLAIMER_SECTIONS: readonly { label: string; text: string }[] = [
  {
    label: "Community project.",
    text:
      "spDEX is a free, open-source project for the SPX6900 community. It speaks only for itself. No exchange, " +
      "index provider or company mentioned in spDEX built, runs, reviewed or endorses it. A link to something " +
      "is not an endorsement, and a name on a tip list is not a recommendation.",
  },
  {
    label: "Not advice.",
    text:
      "Nothing in spDEX is financial, investment, legal or tax advice. It is not a suggestion to buy, sell or " +
      "hold anything.",
  },
  {
    label: "A meme token.",
    text:
      "SPX6900 is a meme token with nothing backing it. It has no connection to the S&P 500 or any other stock " +
      "index. spDEX promises no return, and the token can lose all of its value.",
  },
  {
    label: "Your keys, your signature.",
    text:
      "spDEX has no servers, and its authors never hold your money or your keys. Your wallet signs every " +
      "transaction spDEX prepares. Once signed, a transaction can't be undone.",
  },
  {
    label: "Auto-buy vaults.",
    text:
      "A vault you create holds the budget you give it and buys according to the rules you signed, no matter " +
      "who makes the buy. Each buy pays a fee of up to 0.69%, including network costs, to whoever makes it or " +
      "a wallet they name. New vaults pay only you or a proven holder of 690 SPX for up to an hour after a buy " +
      "is due. Whoever is paid may be one of spDEX's developers.",
  },
  {
    label: "Unaudited, no warranty.",
    text:
      "spDEX and its contracts are a prototype. They have not been independently audited and may " +
      'contain bugs. They are provided "as is", without warranty of any kind, under the GNU Affero General ' +
      "Public License v3.0 or later. To the extent the law allows, the authors are not liable for any loss.",
  },
  {
    label: "Third-party services.",
    text:
      "spDEX reads blockchain data through a network service that can see your IP address. " +
      `${OFFICIAL_RELEASE}, that's the publisher's built-in service; anywhere else, it's one you choose. Relays, keepers, ` +
      "markets, add-ons, tip lists and settings links come from other people, who can see what you send them. " +
      "spDEX has no control over any of these. Copies hosted elsewhere may have been modified, so check the build.",
  },
  {
    label: "Estimates.",
    text:
      "Prices, currency conversions, fees and counts are estimates based on blockchain data from your network " +
      "service. They may be delayed or wrong. If a value can't be read, spDEX never shows it as zero.",
  },
  {
    label: "Jokes aren't claims.",
    text: "Slogans and stickers are community in-jokes. They are not claims about value or returns.",
  },
  {
    label: "Your risk, your responsibility.",
    text:
      "Only use money you can afford to lose completely. You are responsible for your taxes and for following " +
      "the law where you live. Don't use spDEX where it is illegal.",
  },
];

/** The last line, in italics: the text is versioned, and shown again when it changes. */
export const DISCLAIMER_CHANGES = `This text can change. When it does, it is shown again. Version ${DISCLAIMER_VERSION}.`;

/** The footer's one line: the disclaimer in brief, on every page. */
export const FOOTER_LINE =
  "Community project. Not financial advice. Unaudited contracts. Transactions can't be undone; you can lose it all.";

// ─── Which keys continue ──────────────────────────────────────────────────────

/** Keys that never continue: moving focus, modifiers, locks, function keys, and what a person scrolls the text with. */
const NOT_CONTINUE = new Set([
  "Tab",
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "Fn",
  "CapsLock",
  "Insert",
  "NumLock",
  "ScrollLock",
  "ContextMenu",
  "Dead",
  "Unidentified",
  "Process",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "Spacebar",
]);

/** The parts of a keydown this reads. */
export interface GateKey {
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
}

/**
 * Whether a keydown continues past the gate: any key pressed on purpose, but
 * not a held one repeating, a shortcut (Ctrl+C to copy the text), a key
 * mid-composition, or one that moves focus or scrolls the text.
 */
export function keyContinues(event: GateKey): boolean {
  if (
    event.repeat ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.isComposing
  )
    return false;
  if (/^F\d{1,2}$/.test(event.key)) return false;
  return !NOT_CONTINUE.has(event.key);
}
