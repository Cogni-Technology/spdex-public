/**
 * `VaultGuard` against real simulations of the four vault transactions on the
 * local fork.
 *
 * The red-team suite scripts the simulated logs, in the shapes a simulation on
 * this fork produced, and proves the Guard's verdict on each. This proves the
 * other half: that `eth_simulateV1` reports a vault's creation, funding, buy
 * and closing the way those scripts assume — ether by value as traced
 * transfers, WETH wrapped and unwrapped as `Deposit` and `Withdrawal` with no
 * `Transfer`, the factory's announcement and the vault's own events — so that
 * an honest transaction built with `@spdex/vault`'s encoders comes back
 * `verified`, and one whose creation lands anywhere but predicted does not.
 *
 * One transaction is really sent: the vault's creation, from a fresh address,
 * funded for one buy, because funding, triggering and closing need a vault to
 * act on. Those three are only simulated, and the vault is then closed for
 * real, so nothing is left on the shared fork for a keeper to find. Its clock
 * is never touched. The factory is deployed first if the fork doesn't have it
 * yet, from a fresh address, as the vault package's own tests do.
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Address, DcaPlan, Hex } from "@spdex/core";
import {
  EthSimulateV1Provider,
  NATIVE_TOKEN,
  TOKENS,
  addressOfKey,
  generateSpendingKey,
  httpRpc,
  prepareTransaction,
  signPrepared,
} from "@spdex/chain";
import {
  MAINNET_DEPLOYMENT,
  buyFee,
  deployFactoryCall,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  encodeFund,
  factoryAddress,
  fundingRoom,
  predictVault,
  readVault,
  readVaultNonce,
  termsOfPlan,
  type VaultPlan,
  type VaultState,
} from "@spdex/vault";
import { VaultGuard, findVaultNonce, type VaultClaim, type VaultTxPlan } from "../../src/vault.js";

/** The environment, read without Node's types, which this package does not carry. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const FORK_URL = env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);
const ETHER = 10n ** 18n;
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

/** A key nobody has used, given a balance. Only fresh addresses are ever given one. */
async function freshAccount(amount: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  expect(await rpc("eth_getCode", [address, "latest"])).toBe("0x");
  await rpc("anvil_setBalance", [address, hex(amount)]);
  return { key, address };
}

/** Sign locally, send raw, wait for the receipt, insist it succeeded. */
async function send(key: Hex, to: Address, data: Hex, value = 0n): Promise<void> {
  const tx = await prepareTransaction(rpc, { from: addressOfKey(key), to, data, value, chainId: CHAIN_ID });
  const { raw, hash } = await signPrepared(key, tx);
  await rpc("eth_sendRawTransaction", [raw]);
  for (let attempt = 0; attempt < 400; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { status: string } | null;
    if (receipt) {
      expect(BigInt(receipt.status)).toBe(1n);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${hash} was not mined`);
}

describe("VaultGuard on the fork", () => {
  const factory = factoryAddress(MAINNET_DEPLOYMENT);
  // `requireSimulation` on, so a simulation that did not happen cannot pass as one that did.
  const guard = new VaultGuard(new EthSimulateV1Provider(rpc), { chainId: CHAIN_ID, requireSimulation: true });

  let owner: { key: Hex; address: Address };
  let terms: VaultPlan;
  let plan: DcaPlan;
  let nonce: bigint;
  let chainTime: bigint;

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    if (((await rpc("eth_getCode", [factory, "latest"])) as string) === "0x") {
      // Whichever fork test runs first deploys it; the address commits to its code.
      const deployer = await freshAccount(ETHER);
      const call = deployFactoryCall();
      await send(deployer.key, call.to, call.data, call.value);
    }
    expect(await rpc("eth_getCode", [factory, "latest"])).not.toBe("0x");
    owner = await freshAccount(ETHER);
    chainTime = BigInt(((await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string }).timestamp);
    const amountPerBuy = ETHER / 100n;
    terms = {
      marketIndex: 0n,
      amountPerBuy,
      interval: 3_600n,
      maxBuys: 3n,
      startAt: chainTime,
      // The buy fee the app proposes, within the 0.69% ceiling the Guard and the factory hold a creation to.
      keeperReward: buyFee(amountPerBuy).reward,
      maxSlippageBps: 300n,
    };
    plan = {
      id: "dca-guard-fork",
      paused: true,
      chainId: CHAIN_ID,
      sell: NATIVE_TOKEN,
      buy: TOKENS.SPX.address,
      amountPerBuy: amountPerBuy.toString(),
      intervalSeconds: 3_600,
      maxBuys: 3,
      startAt: Number(chainTime),
      signer: "vault",
    };
    nonce = await readVaultNonce(rpc, factory, owner.address);
  });

  const perBuy = () => terms.amountPerBuy + terms.keeperReward;
  const creation = (withNonce = nonce): VaultTxPlan => ({
    version: 1,
    intent: { version: 1, action: "create", chainId: CHAIN_ID, account: owner.address, plan, terms, nonce: withNonce, nowSeconds: chainTime },
    calls: [{ to: factory, data: encodeCreateVault(terms), value: perBuy() }],
  });

  it("verifies an honest creation, and refuses one expected anywhere but where it lands, or paying more than the ceiling", async () => {
    const verdict = await guard.check(creation());
    expect(verdict.violations).toEqual([]);
    expect(verdict.level).toBe("verified");

    // The host's nonce one too high: the simulated vault is not where the
    // plan would record it.
    const misplaced = await guard.check(creation(nonce + 1n));
    expect(misplaced.violations.map((v) => v.code)).toEqual(["VAULT_MALFORMED"]);

    // A buy fee of 1%: past the 0.69% ceiling. The factory would refuse it too;
    // the Guard says so first, with the figures, and nothing is sent.
    const dear = { ...terms, keeperReward: terms.amountPerBuy / 100n };
    const refused = await guard.check({
      ...creation(),
      intent: { ...creation().intent, terms: dear } as VaultTxPlan["intent"],
      calls: [{ to: factory, data: encodeCreateVault(dear), value: dear.amountPerBuy + dear.keeperReward }],
    });
    expect(refused.violations.map((v) => v.code)).toContain("VAULT_MALFORMED");
    expect(refused.violations.map((v) => v.message).join(" ")).toContain("above the 0.69% ceiling");
  });

  describe("once the vault exists", () => {
    let vault: Address;
    let state: VaultState;
    let claim: VaultClaim;

    beforeAll(async () => {
      await send(owner.key, factory, encodeCreateVault(terms), perBuy());
      vault = predictVault({ factory, owner: owner.address, nonce, terms: termsOfPlan(terms) });
      const read = await readVault(rpc, vault, { factory });
      if (read === null) throw new Error(`no vault at ${vault}`);
      state = read;
      // What the host does with a vault the config names: find its nonce from
      // what the vault says about itself.
      const found = findVaultNonce({ factory, owner: state.owner, terms: state.terms, vault, below: nonce + 1n });
      expect(found).toBe(nonce);
      claim = { address: vault, owner: state.owner, nonce: found!, terms: state.terms };
      plan = { ...plan, vault };
    });

    it("verifies funding the rest of the budget", async () => {
      const room = fundingRoom(state);
      expect(room).toBe(2n * perBuy());
      const verdict = await guard.check({
        version: 1,
        intent: { version: 1, action: "fund", chainId: CHAIN_ID, account: owner.address, plan, vault: claim, buysDone: state.buysDone, wethBalance: state.status.wethBalance },
        calls: [{ to: vault, data: encodeFund(), value: room }],
      });
      expect(verdict.violations).toEqual([]);
      expect(verdict.level).toBe("verified");
    });

    it("verifies the owner triggering the first buy, held to the vault's own floor", async () => {
      expect(state.quote).not.toBeNull();
      const verdict = await guard.check({
        version: 1,
        intent: { version: 1, action: "trigger", chainId: CHAIN_ID, account: owner.address, plan, vault: claim, floorOut: state.quote!.floorOut },
        calls: [{ to: vault, data: encodeExecute(), value: 0n }],
      });
      expect(verdict.violations).toEqual([]);
      expect(verdict.level).toBe("verified");
    });

    it("verifies closing, then closes for real", async () => {
      const closing: VaultTxPlan = {
        version: 1,
        intent: { version: 1, action: "close", chainId: CHAIN_ID, account: owner.address, plan, vault: claim },
        calls: [{ to: vault, data: encodeClose(), value: 0n }],
      };
      const verdict = await guard.check(closing);
      expect(verdict.violations).toEqual([]);
      expect(verdict.level).toBe("verified");

      await send(owner.key, vault, encodeClose());
      expect((await readVault(rpc, vault, { factory }))?.closed).toBe(true);
    });
  });
});
