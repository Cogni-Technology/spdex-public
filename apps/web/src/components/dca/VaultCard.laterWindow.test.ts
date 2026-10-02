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
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NATIVE_TOKEN, TOKENS } from "@spdex/chain";
import { recommendedConfig } from "@spdex/config";
import type { Address, DcaPlan } from "@spdex/core";
import { runVaultChecks } from "@spdex/guard";
import { MAINNET_DEPLOYMENT, encodeExecute, factoryAddress, predictVault, type VaultState, type VaultTerms } from "@spdex/vault";
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

const CHAIN = 690069;
const ETHER = 10n ** 18n;
const FACTORY = factoryAddress(MAINNET_DEPLOYMENT);
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

const TERMS: VaultTerms = {
  tokenOut: MARKET.tokenOut,
  pair: MARKET.pair,
  oraclePool: MARKET.oraclePool,
  amountPerBuy: AMOUNT,
  interval: INTERVAL,
  maxBuys: 3n,
  startAt: START,
  keeperReward: REWARD,
  maxSlippageBps: 200n,
};
const NONCE = 0n;
const VAULT = predictVault({ factory: FACTORY, owner: OWNER, nonce: NONCE, terms: TERMS });

const PLAN: DcaPlan = {
  id: "dca-later",
  paused: true,
  chainId: CHAIN,
  sell: NATIVE_TOKEN,
  buy: TOKENS.SPX.address,
  amountPerBuy: AMOUNT.toString(),
  intervalSeconds: Number(INTERVAL),
  maxBuys: 3,
  startAt: Number(START),
  signer: "vault",
  vault: VAULT,
};

/**
 * The vault one buy in, as `readVault` returns it at chain time `chainTime`:
 * funded for the two buys left, the price inside its floor, and due — by the
 * vault's own `status()` — exactly when its second window has opened.
 */
function oneBuyIn(chainTime: bigint): VaultState {
  return {
    address: VAULT,
    owner: OWNER,
    terms: TERMS,
    closed: false,
    buysDone: 1n,
    totalOut: 13_070_000_000n,
    totalRewards: REWARD,
    quote: { spotOut: 13_000_000_000n, floorOut: 12_800_000_000n, oracleDepth: 60n * ETHER },
    fromFactory: true,
    chainTime,
    status: {
      due: chainTime >= SECOND_WINDOW,
      nextBuyAt: SECOND_WINDOW,
      buysLeft: 2n,
      wethBalance: 2n * (AMOUNT + REWARD),
      funded: true,
    },
  };
}

/**
 * The card as the page draws it for `state`, seen by `account`: the hook's
 * answers are the real functions' (`vaultCardStatus` for the pill and line),
 * and the wallet is connected, on the right chain and idle.
 */
function card(read: VaultState, account: Address): string {
  const nowMs = 1_000_000_000_000;
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
    mode: "recommended",
    config: { ...recommendedConfig(), chainId: CHAIN },
  } as unknown as AutoBuyDeps;
  return renderToStaticMarkup(createElement(VaultPlanCard, { plan: PLAN, autoBuy, deps }));
}

/** The opening tag of the element with this test id, or null when it isn't drawn. */
function tagOf(html: string, testId: string): string | null {
  return new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? null;
}

describe("a vault's later window", () => {
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
    expect(html).toContain("Waiting for the next buy time. Then anyone can trigger it.");
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
    const claim = { address: VAULT, owner: OWNER, nonce: NONCE, terms: TERMS };
    const tx = triggerVaultTx({ chainId: CHAIN, account: OWNER, plan: PLAN, claim, floorOut: read.quote!.floorOut });
    expect(tx.calls).toEqual([{ to: VAULT, data: encodeExecute(), value: 0n }]);
    expect(tx.intent).toMatchObject({ action: "trigger", account: OWNER, floorOut: read.quote!.floorOut });
    expect(runVaultChecks(tx, CHAIN)).toEqual([]);
  });
});
