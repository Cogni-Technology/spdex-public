/**
 * "Trigger now" on a vault's later window: the one vault case the e2e suite
 * does not reach, pinned here instead.
 *
 * e2e/vault.spec.ts creates a vault from the form and triggers its first buy
 * from a real browser, through the Guard, on the fork. A second buy it cannot
 * make without either waiting or moving time: the vault spaces buys at least
 * half an interval apart (`_nextBuyAt`) and accepts no interval under five
 * minutes, so a later window opens at least 150 real seconds after a buy — and
 * on an idle fork no block shows it until a transaction arrives. The suite
 * does not wait that long, and nothing may move the shared fork's clock.
 *
 * What is different about a later window is only the vault's state: a buy
 * counted, the next window's start as `nextBuyAt`, the chain's time before or
 * after it. So that state is built here, as `readVault` returns it, and run
 * through what the page does with it — the card's state, its pill and figures,
 * the card itself rendered, and the transaction "Trigger now" would send. The
 * chain's side, that the second window's buy goes through, is forge's
 * (`test_afterOneIntervalTheNextBuyWorks` in packages/vault/test/forge).
 *
 * Both releases: a v1 vault's card is unchanged — no community window, and
 * Trigger now sends `execute()` — and a v2 vault's says, while its buy is
 * inside its community window, until when holders have first claim, and
 * Trigger now sends `execute(owner)`, which the window never refuses.
 *
 * And decision 31's notice, which no build draws until a registry bug is
 * known: on every v2 card, never a v1 one, in a build that sets it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import { recommendedConfig } from "@spdex/config";
import type { Address, DcaPlan } from "@spdex/core";
import { runVaultChecks } from "@spdex/guard";
import {
  MAINNET_DEPLOYMENT,
  V1_MAINNET_FACTORY,
  encodeExecute,
  encodeExecuteV1,
  factoryAddress,
  predictVault,
  type VaultRelease,
  type VaultState,
  type VaultTerms,
} from "@spdex/vault";
import type { AutoBuy, AutoBuyDeps } from "../../lib/dca/useAutoBuy.js";
import {
  triggerVaultTx,
  vaultCardStatus,
  vaultNextBuyStat,
  vaultPlanState,
  vaultProgress,
  type VaultPlanState,
} from "../../lib/dca/vault.js";
import { VaultPlanCard } from "./VaultCard.js";

/** Decision 31's notice, as a build that sets one would have it; none (this build's) unless a test says. */
const advisory = vi.hoisted(() => ({ text: null as string | null }));
vi.mock("../../lib/dca/advisory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/dca/advisory.js")>();
  return {
    ...actual,
    get REGISTRY_ADVISORY() {
      return advisory.text;
    },
  };
});

const CHAIN = 690069;
const ETHER = 10n ** 18n;
const OWNER = "0x00000000000000000000000000000000000000a1" as Address;
const STRANGER = "0x00000000000000000000000000000000000000b2" as Address;
const MARKET = MAINNET_DEPLOYMENT.markets[0]!;
const AMOUNT = ETHER / 100n;
const REWARD = 768n * 10n ** 12n;
const INTERVAL = 86_400n;
const START = 1_789_000_000n;
/** The first buy, made by a keeper a minute into the first window. */
const FIRST_BUY_AT = START + 60n;
/** When the second buy may happen: the later of its window's start and half an interval after the first buy, as `_nextBuyAt` has it. */
const SECOND_WINDOW = START + INTERVAL > FIRST_BUY_AT + INTERVAL / 2n ? START + INTERVAL : FIRST_BUY_AT + INTERVAL / 2n;
/** A daily v2 plan's community window: 30 minutes. */
const WINDOW = 1_800n;
const NONCE = 0n;

/** One plan per release: v2's vault from v2's factory with a window, v1's from v1's without. */
const RELEASES = (["v1", "v2"] as const).map((release) => {
  const factory = release === "v1" ? V1_MAINNET_FACTORY : factoryAddress(MAINNET_DEPLOYMENT);
  const terms: VaultTerms = {
    tokenOut: MARKET.tokenOut,
    pair: MARKET.pair,
    oraclePool: MARKET.oraclePool,
    amountPerBuy: AMOUNT,
    interval: INTERVAL,
    maxBuys: 3n,
    startAt: START,
    keeperReward: REWARD,
    maxSlippageBps: 200n,
    communityWindow: release === "v1" ? null : WINDOW,
    turnBuckets: release === "v1" ? null : 0n,
  };
  const vault = predictVault({ factory, owner: OWNER, nonce: NONCE, terms });
  const plan: DcaPlan = {
    id: `dca-later-${release}`,
    paused: true,
    chainId: CHAIN,
    sell: NATIVE_TOKEN,
    buy: TOKENS.SPX.address,
    amountPerBuy: AMOUNT.toString(),
    intervalSeconds: Number(INTERVAL),
    maxBuys: 3,
    startAt: Number(START),
    signer: "vault",
    vault,
  };
  return { release, factory, terms, vault, plan };
});
type Fixture = (typeof RELEASES)[number];
const V2 = RELEASES[1]!;

/**
 * The vault one buy in, as `readVault` returns it at chain time `chainTime`:
 * funded for the two buys left, the price inside its floor, and due — by the
 * vault's own `status()` — exactly when its second window has opened. A v2
 * vault's buy falls due at the window's start, and its community window runs
 * thirty minutes from there.
 */
function oneBuyInOf(chainTime: bigint, fixture: Fixture = V2): VaultState {
  const v2 = fixture.release === "v2";
  return {
    address: fixture.vault,
    release: fixture.release as VaultRelease,
    source: fixture.release,
    owner: OWNER,
    terms: fixture.terms,
    closed: false,
    buysDone: 1n,
    totalOut: 13_070_000_000n,
    totalRewards: REWARD,
    windowBuys: v2 ? 1n : null,
    quote: { spotOut: 13_000_000_000n, floorOut: 12_800_000_000n, oracleDepth: 60n * ETHER },
    fromFactory: true,
    factory: fixture.factory,
    chainTime,
    status: {
      due: chainTime >= SECOND_WINDOW,
      nextBuyAt: SECOND_WINDOW,
      buysLeft: 2n,
      wethBalance: 2n * (AMOUNT + REWARD),
      funded: true,
      dueSince: v2 ? SECOND_WINDOW : null,
      windowEndsAt: v2 ? SECOND_WINDOW + WINDOW : null,
      // No turns: the turn part ends where the window starts.
      turnEndsAt: v2 ? SECOND_WINDOW : null,
      turn: v2 ? 0n : null,
    },
  };
}

/**
 * The card as the page draws it for `state`, seen by `account`: the hook's
 * answers are the real functions' (`vaultCardStatus` for the pill and line),
 * and the wallet is connected, on the right chain and idle.
 */
const NOW_MS = 1_000_000_000_000;

function cardOf(read: VaultState, account: Address, fixture: Fixture = V2, mode: "recommended" | "expert" = "recommended"): string {
  const nowMs = NOW_MS;
  const PLAN = fixture.plan;
  const state: VaultPlanState = vaultPlanState({ plan: PLAN, account, read, readAtMs: nowMs });
  const chainNow = Number(read.chainTime);
  const autoBuy = {
    vaultFor: () => state,
    vaultStatusFor: () => vaultCardStatus(state, chainNow),
    chainNow: () => chainNow,
    now: nowMs,
    activity: {},
    ownerLockBusy: false,
    vaultSupport: { kind: "checking" },
    vaultHistory: {},
    fees: { kind: "reading" },
    vaultCostsFor: () => null,
  } as unknown as AutoBuy;
  const deps = {
    account,
    walletChainOk: true,
    mode,
    config: { ...recommendedConfig(), chainId: CHAIN },
  } as unknown as AutoBuyDeps;
  return renderToStaticMarkup(createElement(VaultPlanCard, { plan: PLAN, autoBuy, deps }));
}

/** The opening tag of the element with this test id, or null when it isn't drawn. */
function tagOf(html: string, testId: string): string | null {
  return new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? null;
}

describe.each(RELEASES)("a $release vault's later window", (fixture) => {
  const PLAN = fixture.plan;
  const VAULT = fixture.vault;
  const oneBuyIn = (chainTime: bigint) => oneBuyInOf(chainTime, fixture);
  const card = (read: VaultState, account: Address) => cardOf(read, account, fixture);

  it("offers nothing to trigger while its next window hasn't opened, a buy after the first", () => {
    const read = oneBuyIn(SECOND_WINDOW - 90n);
    const state = vaultPlanState({ plan: PLAN, account: OWNER, read, readAtMs: 0 });
    expect(state).toMatchObject({ kind: "active", mine: true, buysDone: 1, due: false, canTrigger: false });
    if (state.kind === "active") expect(state.waitingFor).toMatch(/^Its next buy isn't due until /);
    const status = vaultCardStatus(state, Number(read.chainTime));
    expect(status).toMatchObject({ vault: "waiting", pill: "running", nextBuyAt: Number(SECOND_WINDOW) });
    expect(vaultNextBuyStat(status, Number(read.chainTime), 0).value).toBe("1m");

    const html = card(read, OWNER);
    expect(tagOf(html, "dca-vault-due")).toBeNull();
    expect(tagOf(html, "dca-vault-trigger")).toBeNull();
    expect(html).toContain(fixture.release === "v1" ? "Waiting for the next buy time. Then anyone can trigger it." : "Waiting for the next buy time.<");
  });

  it("once it opens, says buy 2 is due and offers its owner Trigger now", () => {
    const read = oneBuyIn(SECOND_WINDOW);
    const state = vaultPlanState({ plan: PLAN, account: OWNER, read, readAtMs: 0 });
    expect(state).toMatchObject({ kind: "active", buysDone: 1, due: true, canTrigger: true, waitingFor: null });
    const status = vaultCardStatus(state, Number(read.chainTime));
    expect(status).toMatchObject({ vault: "due", pill: "running", pillLabel: "Buy due" });
    expect(vaultNextBuyStat(status, Number(read.chainTime), 0)).toEqual({ value: "Due now", hint: "waiting for a keeper" });
    if (state.kind === "active") expect(vaultProgress(state).valueText).toBe("1 of 3 buys · 0.01 of 0.03 ETH");

    const html = card(read, OWNER);
    expect(tagOf(html, "dca-vault-due")).not.toBeNull();
    expect(html).toContain("Buy 2 is due — waiting for a");
    const trigger = tagOf(html, "dca-vault-trigger");
    expect(trigger).not.toBeNull();
    expect(trigger).not.toMatch(/\sdisabled=/);
    // A v2 buy inside its window says until when holders have first claim; a v1 card is unchanged.
    expect(tagOf(html, "dca-vault-window") !== null).toBe(fixture.release === "v2");
  });

  it("is shown due, and offers nothing to act on, on someone else's vault", () => {
    // Anyone may trigger a due buy on chain; a vault from someone else's link
    // is only watched here, so the card neither asks nor offers.
    const html = card(oneBuyIn(SECOND_WINDOW), STRANGER);
    expect(html).toContain('data-testid="dca-next">Due now<');
    expect(html).toContain('data-testid="dca-pill">Not yours<');
    expect(tagOf(html, "dca-vault-due")).toBeNull();
    expect(tagOf(html, "dca-vault-trigger")).toBeNull();
  });

  it("sends the same execute as the first window's, which passes the Guard's static checks", () => {
    const read = oneBuyIn(SECOND_WINDOW);
    const claim = { address: VAULT, owner: OWNER, nonce: NONCE, terms: fixture.terms, release: fixture.release };
    const tx = triggerVaultTx({ chainId: CHAIN, account: OWNER, plan: PLAN, claim, floorOut: read.quote!.floorOut });
    // v2: execute(owner), the fee named back to the owner; v1: execute(), as always.
    const data = fixture.release === "v2" ? encodeExecute(OWNER) : encodeExecuteV1();
    expect(tx.calls).toEqual([{ to: VAULT, data, value: 0n }]);
    expect(tx.intent).toMatchObject({ action: "trigger", account: OWNER, floorOut: read.quote!.floorOut, rewardTo: OWNER });
    expect(runVaultChecks(tx, CHAIN)).toEqual([]);
  });
});

describe("a v2 vault's community window on its card", () => {
  const clockAt = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

  it("says, while a due buy is inside its window, until when holders have first claim, in this device's clock", () => {
    // Ten minutes into the window: it ends twenty minutes from now.
    const html = cardOf(oneBuyInOf(SECOND_WINDOW + 600n), OWNER);
    expect(html).toContain(`Community window until ${clockAt(NOW_MS + 1_200_000)}, then open to anyone.`);
    // Its owner may still trigger it: execute(owner) is never refused by the window.
    expect(tagOf(html, "dca-vault-trigger")).not.toMatch(/\sdisabled=/);
  });

  it("says nothing of the window once it has ended, and the buy is open to anyone", () => {
    const html = cardOf(oneBuyInOf(SECOND_WINDOW + WINDOW), OWNER);
    expect(tagOf(html, "dca-vault-due")).not.toBeNull();
    expect(tagOf(html, "dca-vault-window")).toBeNull();
  });

  /**
   * Only what v2 changes is shown to everyone (the window line on the card);
   * the release and the window's figures are Expert's, beside the vault's
   * other terms. "Window" alone is the buy slot ("First window"), so each of
   * the new rows says "community window".
   */
  it("shows its release and window in the details in Expert only, each named the community window", () => {
    const simple = cardOf(oneBuyInOf(SECOND_WINDOW), OWNER);
    expect(tagOf(simple, "dca-vault-release")).toBeNull();
    expect(simple).not.toContain("Community window ends");
    const expert = cardOf(oneBuyInOf(SECOND_WINDOW), OWNER, V2, "expert");
    expect(expert).toMatch(/data-testid="dca-vault-release"[^>]*>[\s\S]*?v2/);
    expect(expert).toContain("Community window ends");
    expect(expert).toContain("Buys in the community window, paid to community keepers");
    expect(expert).not.toMatch(/>Window ends</);
  });

  /**
   * Turns are dormant — every vault spDEX creates has none, and its card says
   * nothing of them but "none" in Expert's details. A vault created with them
   * (by anyone, through the factory) says so in one line, and while its buy is
   * in its turn, the due banner says when the turn ends, then the window.
   */
  it("says nothing of turns for a plan without, and for one with them, so, and when this buy's turn ends", () => {
    const plain = cardOf(oneBuyInOf(SECOND_WINDOW + 60n), OWNER);
    expect(tagOf(plain, "dca-vault-turns")).toBeNull();
    expect(cardOf(oneBuyInOf(SECOND_WINDOW), OWNER, V2, "expert")).toMatch(/Turns in the window(?:&#x27;|')s first half[\s\S]*?none/);

    const read = oneBuyInOf(SECOND_WINDOW + 60n);
    const turned: VaultState = {
      ...read,
      terms: { ...read.terms, turnBuckets: 4n },
      status: { ...read.status, turnEndsAt: SECOND_WINDOW + WINDOW / 2n, turn: 1n },
    };
    const html = cardOf(turned, OWNER);
    expect(tagOf(html, "dca-vault-turns")).not.toBeNull();
    expect(html).toContain("shared out in turns among 4 groups of SPX holders");
    expect(html).toContain(
      `This buy&#x27;s turn until ${clockAt(NOW_MS + 840_000)}, for SPX holders in its group; then any SPX holder until ${clockAt(NOW_MS + 1_740_000)}, then anyone.`,
    );
    expect(cardOf(turned, OWNER, V2, "expert")).toMatch(/Turns in the window(?:&#x27;|')s first half[\s\S]*?4 groups/);
  });
});

describe("decision 31's notice on a vault's card", () => {
  const NOTICE = "A bug in the SPX holder registry lets some addresses that never held SPX be paid inside community windows. No vault's money is at risk.";
  afterEach(() => {
    advisory.text = null;
  });

  it("is on every v2 card, and no v1 card, in a build that sets one, and on none in this build", () => {
    const V1 = RELEASES[0]!;
    expect(tagOf(cardOf(oneBuyInOf(SECOND_WINDOW), OWNER), "dca-vault-advisory")).toBeNull();
    advisory.text = NOTICE;
    const v2 = cardOf(oneBuyInOf(SECOND_WINDOW), OWNER);
    expect(tagOf(v2, "dca-vault-advisory")).not.toBeNull();
    expect(v2).toContain("No vault&#x27;s money is at risk.");
    // Someone else's v2 vault too: the notice is about the vault, not whose it is.
    expect(tagOf(cardOf(oneBuyInOf(SECOND_WINDOW), STRANGER), "dca-vault-advisory")).not.toBeNull();
    expect(tagOf(cardOf(oneBuyInOf(SECOND_WINDOW, V1), OWNER, V1), "dca-vault-advisory")).toBeNull();
  });
});
