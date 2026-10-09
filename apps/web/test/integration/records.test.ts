/**
 * Your records against the fork: what `recordSwap` measures from a real
 * swap's receipts, Chainlink's answers at a block as "Fill in values" reads
 * them, and the finality badge's reading of the fork's finalized block.
 *
 * - **A real swap, measured.** A fresh account swaps ETH for SPX through the
 *   app's own Engine and `executeQuote`; the record must say exactly what
 *   the account's balances say moved, who sent it and what it cost.
 * - **Chainlink at a block.** One `aggregate3` at a block must answer what
 *   each feed answers when asked directly at that block, and each feed must
 *   be the pair it is named for. At the pinned block every answer is fresh,
 *   so a trade's value there is a figure; at a fork-local block the fork's
 *   clock has run on past the currency markets' last update, which the value
 *   rules must read as unknown rather than price with.
 * - **Finality.** anvil reports `finalized` as latest − 64. A transaction at
 *   or below it is final, and one above it is only included.
 *
 * Nothing here moves the fork's clock or mines a block for its own sake; the
 * one balance set is a fresh key's (see
 * packages/chain/test/integration/local-key.test.ts for why never a dev
 * account). Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  CHAINLINK_FEEDS,
  ETH_USD_MAX_AGE_SECONDS,
  FX_CODES,
  Multicall3Reader,
  NATIVE_TOKEN,
  TOKENS,
  addressOfKey,
  generateSpendingKey,
  httpRpc,
  prepareTransaction,
  signPrepared,
} from "@spdex/chain";
import { recommendedConfig } from "@spdex/config";
import type { Address, Hex, SpdexConfig } from "@spdex/core";
import { Engine } from "../../src/lib/engine.js";
import { balanceOf } from "../../src/lib/erc20.js";
import { executeQuote, type TxSender } from "../../src/lib/execute.js";
import { watchFinality, type FinalityView, type WatchEnv } from "../../src/lib/finality.js";
import { buildRows } from "../../src/lib/records/build.js";
import { ReceiptStore, recordSwap } from "../../src/lib/records/store.js";
import { usdToFiat } from "../../src/lib/money/convert.js";
import { readChainlinkAt, valueAtBlock } from "../../src/lib/records/values.js";
import { TOKEN_LIST } from "../../src/lib/tokens.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const FORK_BLOCK = BigInt(process.env["SPDEX_FORK_BLOCK"] ?? "26000000");
const rpc = httpRpc(FORK_URL);
const ETHER = 10n ** 18n;
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

class MemoryStorage {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

/** A wallet, as the app sees one: a sender that signs, here with a fresh local key. */
function walletOf(key: Hex): TxSender {
  const account = addressOfKey(key);
  return {
    account,
    kind: "wallet",
    confirm: { rpc, timeoutMs: 60_000 },
    async send(call) {
      const tx = await prepareTransaction(rpc, { from: account, to: call.to, data: call.data, value: call.value, chainId: CHAIN_ID });
      const { raw, hash } = await signPrepared(key, tx);
      await rpc("eth_sendRawTransaction", [raw]);
      return { hash, via: "endpoint" };
    },
  };
}

/** A 32-byte word of an eth_call's answer, as an unsigned integer. */
const wordOf = (data: string, index: number) => BigInt(`0x${data.slice(2 + 64 * index, 2 + 64 * (index + 1))}`);

/** An ABI-encoded string, as `description()` returns it. */
function stringOf(data: string): string {
  const length = Number(wordOf(data, 1));
  const bytes = data.slice(2 + 128, 2 + 128 + length * 2);
  return new TextDecoder().decode(Uint8Array.from(bytes.match(/../g)!.map((b) => parseInt(b, 16))));
}

async function call(to: string, data: string, block: bigint): Promise<string> {
  return (await rpc("eth_call", [{ to, data }, hex(block)])) as string;
}

describe("recordSwap on a real swap", () => {
  const key = generateSpendingKey();
  const account = addressOfKey(key) as Address;
  const config: SpdexConfig = { ...recommendedConfig(), chainId: CHAIN_ID, rpc: { url: FORK_URL, source: "user" } };

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    expect(await rpc("eth_getCode", [account, "latest"])).toBe("0x");
    await rpc("anvil_setBalance", [account, hex(ETHER)]);
  });

  it("records what the balances say moved, who sent it and what it cost", async () => {
    const engine = new Engine(config);
    const ETH = TOKEN_LIST.find((t) => t.address === NATIVE_TOKEN)!;
    const SPX = TOKEN_LIST.find((t) => t.symbol === "SPX")!;
    const amountIn = ETHER / 100n;
    const quote = await engine.quote({ tokenIn: ETH, tokenOut: SPX, amountIn, account });
    expect(quote.verdict.signable).toBe(true);

    const spxBefore = await balanceOf(rpc, SPX.address, account);
    const result = await executeQuote(quote, walletOf(key), rpc);
    const spxAfter = await balanceOf(rpc, SPX.address, account);

    const store = new ReceiptStore(new MemoryStorage(), { locks: null, events: null });
    const recorded = await recordSwap({ rpc, chainId: CHAIN_ID, account, quote, result, pricing: null, store });
    expect(recorded?.saved).toBe(true);
    const row = recorded!.row;

    let fees = 0n;
    for (const hash of result.hashes) {
      const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { gasUsed: string; effectiveGasPrice: string };
      fees += BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    }
    const last = (await rpc("eth_getTransactionReceipt", [result.hashes.at(-1)])) as { blockNumber: string };
    const block = (await rpc("eth_getBlockByNumber", [last.blockNumber, false])) as { timestamp: string };

    expect(row).toMatchObject({
      kind: "swap",
      chainId: CHAIN_ID,
      account: account.toLowerCase(),
      hashes: result.hashes.map((h) => h.toLowerCase()),
      sold: { token: NATIVE_TOKEN, amount: amountIn, measured: true },
      bought: { token: SPX.address.toLowerCase(), amount: spxAfter - spxBefore, measured: true },
      networkFee: fees,
      block: BigInt(last.blockNumber),
      at: { unix: Number(BigInt(block.timestamp)), source: "block" },
      valueUsd: null,
    });
    expect(row.bought.amount).toBeGreaterThan(0n);

    // Read back from the store, the list says the same.
    const read = store.read();
    if (read === "unavailable") throw new Error("the store couldn't be read back");
    const rows = buildRows({ chainId: CHAIN_ID, receipts: read, ledger: { version: 1, entries: {} }, plans: [], vaults: [] }).rows;
    expect(rows).toEqual([row]);
  });
});

describe("Chainlink at a block, as Fill in values reads it", () => {
  const reader = new Multicall3Reader(rpc);
  const names = ["ETH", "USDC", ...FX_CODES] as const;

  async function direct(block: bigint) {
    const answers = new Map<string, { answer: bigint; updatedAt: number; decimals: number; description: string }>();
    for (const name of names) {
      const feed = CHAINLINK_FEEDS[name].address;
      const round = await call(feed, "0xfeaf968c", block);
      answers.set(name, {
        answer: wordOf(round, 1),
        updatedAt: Number(wordOf(round, 3)),
        decimals: Number(wordOf(await call(feed, "0x313ce567", block), 0)),
        description: stringOf(await call(feed, "0x7284e416", block)),
      });
    }
    return answers;
  }

  it("answers at a fork-local block exactly what each feed answers there, each the pair it is named for", async () => {
    const head = BigInt((await rpc("eth_blockNumber", [])) as string);
    const block = head - 1n > FORK_BLOCK ? head - 1n : FORK_BLOCK;
    const read = await readChainlinkAt(reader, block);
    const answers = await direct(block);
    const header = (await rpc("eth_getBlockByNumber", [hex(block), false])) as { timestamp: string };

    expect(read.block).toBe(block);
    expect(read.chainTime).toBe(Number(BigInt(header.timestamp)));
    for (const name of names) {
      const expected = answers.get(name)!;
      expect(expected.description, name).toBe(`${name} / USD`);
      expect(expected.decimals, name).toBe(CHAINLINK_FEEDS[name].decimals);
      const got = name === "ETH" ? read.eth : name === "USDC" ? read.usdc : read.rates[name];
      expect(got, name).toEqual({ answer: expected.answer, decimals: expected.decimals, updatedAt: expected.updatedAt });
    }

    // Whether ETH can be priced there depends on how far the fork's clock
    // has run past the feed's last update; either way it's the rule's answer.
    const eth = answers.get("ETH")!;
    const fresh = read.chainTime - eth.updatedAt <= ETH_USD_MAX_AGE_SECONDS;
    const oneWeth = { token: TOKENS.WETH.address, amount: ETHER, measured: true };
    expect(valueAtBlock(oneWeth, read)).toBe(fresh ? (eth.answer * 1_000_000n) / 10n ** BigInt(eth.decimals) : null);
  });

  it("prices ETH, USDC and a currency at the pinned block, where every answer is fresh", async () => {
    const read = await readChainlinkAt(reader, FORK_BLOCK);
    const eth = read.eth!;
    const value = valueAtBlock({ token: NATIVE_TOKEN, amount: ETHER, measured: true }, read);
    expect(value).toBe((eth.answer * 1_000_000n) / 10n ** 8n);
    expect(valueAtBlock({ token: TOKENS.USDC.address, amount: 1_000_000n, measured: true }, read)).toBe(
      (1_000_000n * read.usdc!.answer) / 10n ** 8n,
    );
    expect(valueAtBlock({ token: TOKENS.SPX.address, amount: 10n ** 8n, measured: true }, read)).toBeNull();
    const euros = usdToFiat(value!, read, "EUR");
    expect(euros).toEqual({ minor6: (value! * 10n ** 8n) / read.rates.EUR!.answer, currency: "EUR" });
  });
});

describe("finality on the fork", () => {
  /** Real reads, and a clock that only moves when the watcher sleeps, so a test never waits out a poll. */
  const env = (): WatchEnv => {
    let time = 0;
    return { now: () => time, sleep: async (ms) => void (time += ms), whenVisible: async () => undefined };
  };

  async function firstTransactionAtOrBelow(block: bigint, lowest: bigint): Promise<Hex | null> {
    for (let n = block; n > lowest; n--) {
      const read = (await rpc("eth_getBlockByNumber", [hex(n), false])) as { transactions: Hex[] } | null;
      if (read !== null && read.transactions.length > 0) return read.transactions[0]!;
    }
    return null;
  }

  it("reports a finalized block, and a transaction at or below it is final", async () => {
    const finalized = (await rpc("eth_getBlockByNumber", ["finalized", false])) as { number: string } | null;
    expect(finalized).not.toBeNull();
    const head = BigInt((await rpc("eth_blockNumber", [])) as string);
    expect(BigInt(finalized!.number)).toBeLessThanOrEqual(head);

    // A block the fork made itself when there is one below finality;
    // otherwise the finalized block, a mainnet block the fork already has.
    const target = BigInt(finalized!.number);
    const hash = (await firstTransactionAtOrBelow(target, FORK_BLOCK)) ?? (await firstTransactionAtOrBelow(target, target - 1n));
    expect(hash).not.toBeNull();

    const views: FinalityView[] = [];
    await new Promise<void>((resolve) => {
      watchFinality(rpc, hash!, (view) => {
        views.push(view);
        if (view.state !== "sent" && view.state !== "included") resolve();
      }, { env: env() });
    });
    expect(views.at(-1)?.state).toBe("final");
  });

  it("calls a transaction above the finalized block included, not final", async () => {
    const finalized = BigInt(((await rpc("eth_getBlockByNumber", ["finalized", false])) as { number: string }).number);
    const head = BigInt((await rpc("eth_blockNumber", [])) as string);
    const hash = await firstTransactionAtOrBelow(head, finalized);
    if (hash === null) {
      // Every block above finality is empty on this fork: nothing to follow.
      expect(head - finalized).toBeLessThanOrEqual(64n);
      return;
    }
    const views: FinalityView[] = [];
    await new Promise<void>((resolve) => {
      const stop = watchFinality(rpc, hash, (view) => {
        views.push(view);
        if (view.state === "included" && view.finalized !== null) {
          stop();
          resolve();
        }
      }, { env: env() });
    });
    const last = views.at(-1)!;
    expect(last.state).toBe("included");
    if (last.state === "included") expect(last.finalized).toBeLessThan(last.block);
  });
});
