/**
 * What the vault specs share: fresh accounts, a wallet that signs with one,
 * the Recurring form filled in for a vault, every release's contracts with the
 * SPX holder registry and a proven holder (packages/testing/src/vaultFork.ts),
 * vaults made outside the page on any release's factory, and the clean-up
 * that leaves no funded vault behind on the shared fork.
 *
 * ## Fresh keys, never anvil's accounts
 *
 * Every account a vault spec uses is a new random key, and only such a key is
 * ever given ether with `anvil_setBalance`. The fork is shared — with the rest
 * of the suite, with a developer's browser on :5173, with other runs going at
 * the same time — and anvil's ten accounts are what all of those use. A vault
 * spec asserts the owner's ether to the wei ("rose by what the vault held,
 * less the fee"), which a stray transaction from a shared account would break
 * for reasons that have nothing to do with spDEX. A key nobody else holds has
 * no such neighbours, and no EIP-7702 delegation inherited from mainnet to
 * forward its ether away (see `clearDelegation` in fixtures.ts).
 *
 * anvil cannot send for a key it does not hold, and impersonation proved
 * erratic (fixtures.ts, `clearDelegation`), so the page's wallet is the usual
 * headless one with one change: its `eth_sendTransaction`, which it relays to
 * the fork, is caught on the way out and signed here with the key, through
 * `@spdex/chain`'s `prepareTransaction`/`signPrepared`, then sent raw. Its
 * `eth_signTransaction` (private sending: the page posts the signed bytes to
 * its relay itself) is signed here too, exactly as asked, and handed back
 * unsent. Everything else the page asks the fork goes through untouched. The
 * wallet still records what the page asked for (`window.ethereum._sent`), so a
 * spec checks the page's requests and the chain's result separately, as the
 * auto-buy spec does.
 */

import { expect, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";
import { addressOfKey, generateSpendingKey, prepareTransaction, signPrepared } from "../packages/chain/src/index.js";
import { headlessWalletScript } from "../packages/testing/src/wallet.js";
import { localClock } from "../apps/web/src/lib/steps.js";
import { FORK_HOLDER, encodeV1CreateVault, ensureHolderProven, ensureReleasesOnFork, forkChainTime } from "../packages/testing/src/vaultFork.js";
import {
  DEPLOYMENTS,
  MAINNET_BATCHER,
  MAINNET_DEPLOYMENT,
  MAINNET_REGISTRY,
  V1_MAINNET_BATCHER,
  V1_MAINNET_FACTORY,
  encodeClose,
  encodeCreateVault,
  factoryAddress,
  readVault,
  vaultBudget,
  vaultsCreatedBy,
  type RawLog,
  type VaultPlan,
  type VaultState,
} from "../packages/vault/src/index.js";
import { FORK_CHAIN_ID, FORK_URL, forkRpc } from "./fixtures.js";

type Hex = `0x${string}`;

/**
 * The factory the app creates vaults on: v2's, whose address commits to its
 * code, its market list and the registry it asks.
 */
export const FACTORY = factoryAddress(MAINNET_DEPLOYMENT).toLowerCase() as Hex;

/**
 * The batcher a keeper makes many vaults' buys through in one transaction:
 * bound to no factory, it serves every release from v2 on (`BATCHERS`' newest).
 */
export const BATCHER = MAINNET_BATCHER.toLowerCase() as Hex;

/**
 * v1's factory and its own batcher, built from v1's frozen source: the app
 * still lists, funds, triggers and closes v1 vaults, and creates none.
 */
export const V1_FACTORY = V1_MAINNET_FACTORY.toLowerCase() as Hex;
export const V1_BATCHER = V1_MAINNET_BATCHER.toLowerCase() as Hex;

/** The SPX holder registry v2's vaults ask about whoever they pay inside a buy's community window. */
export const REGISTRY = MAINNET_REGISTRY.toLowerCase() as Hex;

/**
 * The eligible address a keeper or a batch pays inside a buy's community
 * window: a real mainnet SPX holder, proven on the fork from a proof recorded
 * from mainnet (packages/testing/src/vaultFork.ts). Nothing ever signs for it
 * and nothing sends it SPX, so its WETH is measured as a delta: every run
 * pays it.
 */
export const HOLDER = FORK_HOLDER;

export const ETHER = 10n ** 18n;

/**
 * `shown` ("14:32") is this device's clock at some second from `from` to `to`
 * (unix seconds), written as the app writes a time of day (`localClock`):
 * hours and minutes, 24-hour, in this device's time zone, which the browser
 * shares with the test.
 */
export function expectClockWithin(shown: string, from: number, to: number): void {
  const minutes = new Set<string>();
  for (let t = from - (from % 60); t <= to; t += 60) minutes.add(localClock(t));
  expect([...minutes], `"${shown}" as a time from ${new Date(from * 1000).toISOString()} to ${new Date(to * 1000).toISOString()}`).toContain(shown);
}

/** "0.00125" ETH → wei, exactly: the figures a sentence on the page states. */
export function parseEther(text: string): bigint {
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole!) * ETHER + BigInt(fraction.padEnd(18, "0").slice(0, 18) || "0");
}

/**
 * `stated` is `exact` rounded up to the four significant digits the page
 * shows costs in: never below it, and above it by less than a thousandth.
 */
export function expectRoundedUp(stated: bigint, exact: bigint): void {
  expect(stated).toBeGreaterThanOrEqual(exact);
  expect((stated - exact) * 1000n).toBeLessThan(exact);
}

/** `shown` is `exact` to the six significant digits a card's figures use. */
export function expectSixDigits(shown: bigint, exact: bigint): void {
  const gap = shown > exact ? shown - exact : exact - shown;
  expect(gap * 100_000n).toBeLessThanOrEqual(exact);
}

// ── Accounts ─────────────────────────────────────────────────────────────

export interface Account {
  key: Hex;
  address: Hex;
}

/** Owners made in this worker, with the block they were made at, until `closeLeftoverVaults` has looked at them. */
const owners: (Account & { fromBlock: bigint })[] = [];

/**
 * A new random key holding `wei` of ether and nothing else.
 *
 * Checked fresh before it is funded — no transactions, no code, no ether —
 * so `anvil_setBalance` never lands on an account anything else uses. With
 * `owner`, its vaults are closed after the test by `closeLeftoverVaults`.
 */
export async function freshAccount(wei: bigint, options: { owner?: boolean } = {}): Promise<Account> {
  const key = generateSpendingKey() as Hex;
  const address = addressOfKey(key) as Hex;
  const [nonce, code, balance, head] = (await Promise.all([
    forkRpc("eth_getTransactionCount", [address, "latest"]),
    forkRpc("eth_getCode", [address, "latest"]),
    forkRpc("eth_getBalance", [address, "latest"]),
    forkRpc("eth_blockNumber", []),
  ])) as string[];
  if (BigInt(nonce!) !== 0n || code !== "0x" || BigInt(balance!) !== 0n) {
    throw new Error(`${address} is not a fresh address; refusing to set its balance`);
  }
  await forkRpc("anvil_setBalance", [address, `0x${wei.toString(16)}`]);
  if (options.owner) owners.push({ key, address, fromBlock: BigInt(head!) });
  return { key, address };
}

// ── A wallet that signs with a key ───────────────────────────────────────

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

/** A single JSON-RPC request, or null for anything else (a batch, a GET, a body that isn't JSON). */
function jsonRpcRequest(text: string | null): { id?: unknown; method?: unknown; params?: unknown[] } | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { method?: unknown }) : null;
  } catch {
    return null;
  }
}

export interface KeyWallet {
  address: Hex;
  /** Every transaction signed and sent for the page, in order. */
  hashes: Hex[];
  /**
   * Every transaction signed for the page and handed back unsent
   * (`eth_signTransaction`, for private sending), with the gas limit and
   * price it was signed at, in order.
   */
  signed: { hash: Hex; gas: bigint; gasPrice: bigint }[];
}

/**
 * Give every page in `context` a headless wallet for `account`, whose
 * transactions are signed here with its key (see the file comment).
 *
 * Context-wide rather than per page, so a page opened later — the same person
 * coming back after closing spDEX — has the same wallet without being set up
 * again, and finds whatever the earlier page saved.
 */
export async function keyWallet(context: BrowserContext, account: Account): Promise<KeyWallet> {
  const wallet: KeyWallet = { address: account.address, hashes: [], signed: [] };
  await context.addInitScript(headlessWalletScript({ rpcUrl: FORK_URL, address: account.address, chainId: FORK_CHAIN_ID }));
  await context.route(
    (url) => url.href.startsWith(FORK_URL),
    async (route: Route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      const body = jsonRpcRequest(request.postData());
      if (body === null || (body.method !== "eth_sendTransaction" && body.method !== "eth_signTransaction")) return route.continue();

      const reply = (payload: object) =>
        route.fulfill({
          status: 200,
          headers: CORS,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }),
        });
      if (body.method === "eth_signTransaction") {
        // Signed exactly as asked (nonce, gas and price included) and handed
        // back: the page posts it to its relay itself.
        const tx = (body.params?.[0] ?? {}) as Record<string, string | undefined>;
        if ((tx["from"] ?? "").toLowerCase() !== account.address || !tx["to"]) {
          return reply({ error: { code: 4100, message: `this test wallet signs only for ${account.address}, to an address` } });
        }
        try {
          const gas = BigInt(tx["gas"]!);
          const gasPrice = BigInt(tx["gasPrice"]!);
          const signed = await signPrepared(account.key, {
            from: account.address,
            chainId: Number(BigInt(tx["chainId"] ?? FORK_CHAIN_ID)),
            nonce: Number(BigInt(tx["nonce"]!)),
            to: tx["to"].toLowerCase() as Hex,
            data: (tx["data"] ?? "0x") as Hex,
            value: BigInt(tx["value"] ?? "0x0"),
            gas,
            fees: { type: "legacy", gasPrice },
          });
          wallet.signed.push({ hash: signed.hash.toLowerCase() as Hex, gas, gasPrice });
          return reply({ result: signed.raw });
        } catch (error) {
          return reply({ error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
        }
      }
      const tx = (body.params?.[0] ?? {}) as { from?: string; to?: string; data?: string; value?: string; gas?: string };
      if ((tx.from ?? "").toLowerCase() !== account.address || !tx.to) {
        return reply({ error: { code: 4100, message: `this test wallet sends only from ${account.address}, to an address` } });
      }
      try {
        const prepared = await prepareTransaction(forkRpc, {
          from: account.address,
          to: tx.to.toLowerCase() as Hex,
          data: (tx.data ?? "0x") as Hex,
          value: BigInt(tx.value ?? "0x0"),
          chainId: FORK_CHAIN_ID,
        });
        // The headless wallet has already set a limit with a real wallet's
        // headroom (packages/testing/src/wallet.ts says why); it is kept.
        const signed = await signPrepared(account.key, tx.gas ? { ...prepared, gas: BigInt(tx.gas) } : prepared);
        await forkRpc("eth_sendRawTransaction", [signed.raw]);
        wallet.hashes.push(signed.hash.toLowerCase() as Hex);
        return reply({ result: signed.hash });
      } catch (error) {
        return reply({ error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
      }
    },
  );
  return wallet;
}

// ── Reading what happened ────────────────────────────────────────────────

interface Receipt {
  transactionHash: string;
  status: string;
  blockNumber: string;
  gasUsed: string;
  effectiveGasPrice: string;
  logs: (RawLog & { blockNumber?: string })[];
}

/** A mined transaction's receipt; throws for one that is not mined or reverted. */
export async function receiptOf(hash: string): Promise<Receipt> {
  const receipt = (await forkRpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
  if (receipt === null) throw new Error(`no receipt for ${hash}`);
  if (BigInt(receipt.status) !== 1n) throw new Error(`${hash} reverted`);
  return receipt;
}

/**
 * The vault, read from the chain as the app and the keeper read it, vouched
 * for by whichever release's factory made it. Throws when nothing there
 * answers like one.
 */
export async function vaultOnChain(vault: string): Promise<VaultState> {
  const state = await readVault(forkRpc, vault.toLowerCase() as Hex);
  if (state === null) throw new Error(`${vault} does not answer like a vault`);
  return state;
}

/**
 * The fork's time as its next block will carry it. The idle head's time lags
 * it by however long nothing was sent, so a vault started at the head's time
 * may find its first community window already over when its creation lands.
 */
export function chainNow(): Promise<bigint> {
  return forkChainTime(forkRpc);
}

// ── The form ─────────────────────────────────────────────────────────────

/** The one plan card on the page. Plan ids are random, so it is found by its prefix. */
export function planCard(page: Page): Locator {
  return page.locator('[data-testid^="dca-plan-"]');
}

/** A card's history entries of one kind ("bought", "closed", …). */
export function history(card: Locator, kind: string): Locator {
  return card.locator(`[data-testid^="dca-run-"][data-kind="${kind}"]`);
}

/** What the form says the vault will cost, before anything is sent. */
export interface VaultQuote {
  /** "X ETH goes in": what the one confirmation sends, rounded up. */
  sends: bigint;
  /** "Y ETH for the buys": every buy, exactly. */
  forBuys: bigint;
  /** "Z ETH for their buy fees": every buy's fee, rounded up. */
  forFees: bigint;
  /** "Buy fee: ≈ $0.23 (F ETH)": one buy's fee, rounded up. */
  feeEach: bigint;
}

/**
 * Connect, open Recurring and fill in a vault plan: `amount` ETH → SPX every
 * day, `count` times, at the default 2% allowance. Returns Start, enabled,
 * and what the form says the one confirmation will send.
 */
export async function fillVaultForm(page: Page, amount: string, count: number): Promise<{ start: Locator; quote: VaultQuote }> {
  await page.getByTestId("connect-button").click();
  await page.getByTestId("buy-mode-recurring").click();
  // The vault first: choosing it resets the pair, and with it an amount
  // typed for another token.
  const choice = page.getByTestId("dca-form-signer-vault");
  await expect(choice.getByRole("radio")).toBeEnabled({ timeout: 60_000 });
  // The name the user chose for a vault plan, with what it is in its short line.
  await expect(choice.locator(".spdex-choice__title")).toHaveText("Set and forget");
  await expect(choice).toContainText("no tab needed");
  await choice.getByRole("radio").check();
  await page.getByTestId("dca-form-amount").fill(amount);
  await page.getByTestId("dca-form-count").fill(String(count));
  await expect(choice.getByTestId("dca-form-vault-badge")).toHaveText("Unaudited");
  // A vault pays with ETH and buys SPX, and nothing else: the form sets the
  // pair and holds it there.
  await expect(page.getByTestId("dca-form-sell")).toHaveValue("ETH");
  await expect(page.getByTestId("dca-form-buy")).toHaveValue("SPX");
  await expect(page.getByTestId("dca-form-sell")).toBeDisabled();
  await expect(page.getByTestId("dca-form-vault-slippage-200")).toHaveAttribute("aria-pressed", "true");
  // Who may earn its fee, and for how long, in the one line everyone sees: a
  // daily plan's window is the default 30 minutes. Choosing another is
  // Expert's alone (expert.spec.ts), so Simple shows no control for it.
  await expect(page.getByTestId("dca-form-vault-window-line")).toHaveText(
    "SPX holders can earn this plan's fee for its first 30 minutes after each buy falls due; then anyone can.",
  );
  await expect(page.getByTestId("dca-form-vault-window")).toHaveCount(0);

  const start = page.getByTestId("dca-form-start");
  await expect(start).toHaveText("Create and fund vault");
  await expect(start).toBeEnabled({ timeout: 60_000 });

  const setup = ((await page.getByTestId("dca-form-vault-setup-cost").textContent()) ?? "").trim();
  const said =
    /^Created and funded in 1 confirmation: ([\d.]+) ETH goes in — ([\d.]+) ETH for the buys and ([\d.]+) ETH for their buy fees\.$/.exec(
      setup,
    );
  expect(said, setup).not.toBeNull();
  // Spaces normalised, the non-breaking one after "≈" or "<" included.
  const cost = ((await choice.textContent()) ?? "").replace(/\s+/g, " ");
  expect(cost).toContain("1 confirmation creates and funds it");
  // Dollars first when the page knows a rate ("≈ $0.23", or "< $0.01" for a
  // fee under half a cent), then the ether figure this reads.
  const each = /Buy fee: (?:[≈<] \$[\d.,]+ \()?([\d.]+) ETH/.exec(cost);
  expect(each, cost).not.toBeNull();
  return {
    start,
    quote: {
      sends: parseEther(said![1]!),
      forBuys: parseEther(said![2]!),
      forFees: parseEther(said![3]!),
      feeEach: parseEther(each![1]!),
    },
  };
}

// ── Sending outside the page ─────────────────────────────────────────────

/**
 * Make sure every release is on the fork — v2's registry, factory and the
 * batcher bound to no factory (built for WETH, shared by every release from v2
 * on), and v1's factory and its own batcher from its frozen source — and that
 * `HOLDER` is proven there, deploying and proving from fresh keys whatever
 * isn't yet (packages/testing/src/vaultFork.ts). The keeper never deploys a
 * batcher itself, and the app deploys no release on its own; on the pinned
 * block none exists, since v1 reached mainnet after it. Anyone may
 * deploy them, and each lands at the address its code fixes: a deployment
 * that loses a race to another run reverts, and the code is there all the
 * same.
 */
export async function ensureContracts(): Promise<void> {
  await ensureReleasesOnFork(forkRpc, FORK_CHAIN_ID);
  await ensureHolderProven(forkRpc, FORK_CHAIN_ID);
}

/**
 * Sign and send one transaction from `account`'s key, outside any page, and
 * wait for it to be mined: what another browser, another app or a script of
 * the owner's own would do. Throws for one that reverts.
 */
export async function sendAs(account: Account, call: { to: Hex; data: Hex; value?: bigint }): Promise<Receipt> {
  const prepared = await prepareTransaction(forkRpc, {
    from: account.address,
    to: call.to,
    data: call.data,
    value: call.value ?? 0n,
    chainId: FORK_CHAIN_ID,
  });
  const signed = await signPrepared(account.key, prepared);
  await forkRpc("eth_sendRawTransaction", [signed.raw]);
  await expect.poll(() => forkRpc("eth_getTransactionReceipt", [signed.hash]), { timeout: 60_000 }).not.toBeNull();
  return receiptOf(signed.hash);
}

/**
 * Create and fund a v2 vault from `owner`'s key, outside any page, on v2's
 * factory: what another app or a script of the owner's own would do. Returns
 * its address, from the factory's own `VaultCreated`.
 */
export async function createVaultAs(owner: Account, plan: VaultPlan): Promise<Hex> {
  const receipt = await sendAs(owner, { to: FACTORY, data: encodeCreateVault(plan), value: vaultBudget(plan) });
  const created = vaultsCreatedBy(FACTORY, receipt.logs).filter((event) => event.owner === owner.address);
  expect(created, "the vault the factory created").toHaveLength(1);
  return created[0]!.vault.toLowerCase() as Hex;
}

/**
 * Create and fund a v1 vault from `owner`'s key, on v1's factory, with v1's
 * seven-argument `createVault`: a vault made before v2 shipped, which the app
 * still shows, funds, triggers and closes, and Help run never offers.
 */
export async function createV1VaultAs(owner: Account, plan: Omit<VaultPlan, "communityWindow" | "turnBuckets">): Promise<Hex> {
  const receipt = await sendAs(owner, { to: V1_FACTORY, data: encodeV1CreateVault(plan), value: vaultBudget(plan) });
  const created = vaultsCreatedBy(V1_FACTORY, receipt.logs).filter((event) => event.owner === owner.address);
  expect(created, "the vault v1's factory created").toHaveLength(1);
  return created[0]!.vault.toLowerCase() as Hex;
}

// ── Leaving nothing behind ───────────────────────────────────────────────

/**
 * Close every vault a fresh owner of this test still has open, from its own
 * key, so that nothing funded is left on the shared fork for a keeper — a
 * developer's `pnpm keeper`, or the next run's — to trigger. It covers a test
 * that had no reason to close its vault and one that stopped half way, and it
 * looks from the owner's creation block with every release's factory's own
 * `VaultCreated` logs, so a vault the page never got to show is found too,
 * v1's included.
 */
export async function closeLeftoverVaults(): Promise<void> {
  const waiting = owners.splice(0);
  for (const owner of waiting) {
    for (const factory of DEPLOYMENTS.map((d) => d.factory.toLowerCase() as Hex)) {
      const logs = (await forkRpc("eth_getLogs", [
        { address: factory, fromBlock: `0x${owner.fromBlock.toString(16)}`, toBlock: "latest" },
      ])) as RawLog[];
      for (const created of vaultsCreatedBy(factory, logs).filter((event) => event.owner === owner.address)) {
        const state = await vaultOnChain(created.vault);
        if (state.closed) continue;
        await sendAs(owner, { to: created.vault, data: encodeClose() });
      }
    }
  }
}
