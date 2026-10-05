/**
 * Community keeping on the fork, through the app's own layer and the real
 * Engine: a proof that a real SPX holder held 690 SPX, built in the browser's
 * way from the fork's own answers, pasted back as another service's answers,
 * and checked by the Engine's vault Guard, which reads the block's hash from
 * the service itself (`blockHash` wired in engine.ts) — without that read
 * every proof is refused, so a verified proof here is the wiring at work.
 *
 * Anvil can't prove the blocks it mines (their state roots aren't real), so
 * every proof here is of the pinned block, 26,000,000, which the fork serves
 * from mainnet's own state; its hash is in EIP-2935's history while the fork's
 * head is within 8,191 blocks of it. The holder is `0xd751…5b7e`, an ordinary
 * account with 1,992 SPX there, which every suite leaves unproven on the
 * shared fork: these proofs are checked and test-run, never sent. If anything
 * ever proves it, the same proof is refused as `NotNewer`, and the test says
 * which it saw. Every key is fresh; nothing moves the fork's clock or mines.
 * Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { addressOfKey, generateSpendingKey, httpRpc, prepareTransaction, signPrepared } from "@spdex/chain";
import { recommendedConfig } from "@spdex/config";
import type { Address, Hex, SpdexConfig } from "@spdex/core";
import {
  MAINNET_REGISTRY,
  MIN_SPX,
  buildHolderProof,
  checkPastedProof,
  deployReleaseCalls,
  encodeProve,
  parsePastedProof,
  proofRequests,
  readHolderStatus,
  type HolderProof,
} from "@spdex/vault";
import { Engine } from "../../src/lib/engine.js";
import { otherAddressText, proveIntent, standingLines } from "../../src/lib/network/keeping.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);
const ETHER = 10n ** 18n;
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

/** A real mainnet SPX holder, an ordinary account: 1,992 SPX at the pinned block, never proven on the shared fork. */
const HOLDER = "0xd75110fc7a983e50e4b3a03434a8b524db4b5b7e" as Address;
/** The pinned block: the newest whose state is mainnet's own. */
const PINNED = 26_000_000n;

async function freshAccount(amount: bigint): Promise<{ key: Hex; address: Address }> {
  const key = generateSpendingKey();
  const address = addressOfKey(key);
  expect(await rpc("eth_getCode", [address, "latest"])).toBe("0x");
  await rpc("anvil_setBalance", [address, hex(amount)]);
  return { key, address };
}

async function send(key: Hex, call: { to: Address; data: Hex; value: bigint }): Promise<void> {
  const prepared = await prepareTransaction(rpc, { from: addressOfKey(key), to: call.to, data: call.data, value: call.value, chainId: CHAIN_ID });
  const { raw, hash } = await signPrepared(key, prepared);
  await rpc("eth_sendRawTransaction", [raw]);
  for (let attempt = 0; attempt < 400; attempt++) {
    if ((await rpc("eth_getTransactionReceipt", [hash])) !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no receipt for ${hash}`);
}

/** v2's registry, factory and batcher, those not on the fork yet; another suite may win the race, and the code is there all the same. */
async function ensureV2(): Promise<void> {
  let deployer: { key: Hex } | null = null;
  for (const call of deployReleaseCalls("v2")) {
    if (((await rpc("eth_getCode", [call.address, "latest"])) as string) !== "0x") continue;
    deployer ??= await freshAccount(2n * ETHER);
    await send(deployer.key, { to: call.to, data: call.data, value: call.value }).catch(() => undefined);
    expect((await rpc("eth_getCode", [call.address, "latest"])) as string).not.toBe("0x");
  }
}

describe("Community keeping on the fork", () => {
  const config: SpdexConfig = {
    ...recommendedConfig(),
    chainId: CHAIN_ID,
    rpc: { url: FORK_URL, source: "user" },
    // A check that didn't test-run can't pass as one that did.
    guard: { ...recommendedConfig().guard, requireSimulation: true },
  };
  const engine = new Engine(config);
  let account: Address;
  let built: HolderProof;

  beforeAll(async () => {
    expect(Number(BigInt((await rpc("eth_chainId", [])) as string))).toBe(CHAIN_ID);
    await ensureV2();
    account = (await freshAccount(ETHER)).address;
    built = await buildHolderProof(rpc, HOLDER, { block: PINNED });
  }, 120_000);

  it("reads a holder's standing the way the panel shows it: an account, holding enough", async () => {
    expect(engine.vaultRegistry).toBe(MAINNET_REGISTRY);
    const status = await readHolderStatus(rpc, HOLDER, { registry: engine.vaultRegistry });
    expect(status.state).toBe("read");
    if (status.state !== "read") return;
    expect(status.isAccount).toBe(true);
    expect(status.balance! >= MIN_SPX).toBe(true);
    expect(standingLines(status).holding).toBe("You hold 1,992 SPX; 690 is the bar.");
    // A contract is told it can never be paid, before anyone pays for a proof.
    const contract = await readHolderStatus(rpc, engine.vaultRegistry, { registry: engine.vaultRegistry });
    expect(contract.state === "read" && contract.isAccount).toBe(false);
    expect(otherAddressText(contract)).toBe("Only an ordinary account can be paid as a community keeper; this address is a contract.");
  });

  it("builds a proof of the pinned block, and the Engine's vault Guard verifies it with the block's hash it reads itself", async () => {
    expect(built.blockNumber).toBe(PINNED);
    expect(built.balance).toBe(199_200_000_000n);
    const intent = proveIntent(built, account, CHAIN_ID);
    const { plan, verdict } = await engine.checkVaultProof(intent);
    // Built here from the intent: one call, to the registry, no ether, exactly this proof.
    expect(plan.calls).toEqual([{ to: MAINNET_REGISTRY, data: encodeProve(built), value: 0n }]);
    const status = await readHolderStatus(rpc, HOLDER, { registry: engine.vaultRegistry });
    const proven = status.state === "read" && status.validUntil !== null && status.validUntil > 0n;
    if (!proven) {
      expect(verdict.violations).toEqual([]);
      expect(verdict.level).toBe("verified");
    } else {
      // Something proved this holder on the shared fork: the same proof would change nothing.
      expect(verdict.level).toBe("rejected");
      expect(verdict.violations.map((v) => v.detail?.["reason"])).toContain("NotNewer");
    }
  });

  it("makes the same proof from the two answers pasted back as another service's, checked against the person's own", async () => {
    const answers = await Promise.all(
      proofRequests(HOLDER, PINNED).map(async (request, i) => ({ jsonrpc: "2.0", id: i + 1, result: await rpc(request.method, request.params) })),
    );
    // In either order, one after the other, as a person pastes them.
    const text = `${JSON.stringify(answers[1])}\n${JSON.stringify(answers[0])}`;
    const pasted = await checkPastedProof(rpc, parsePastedProof(text, HOLDER));
    expect(pasted).toEqual(built);
  });

  it("refuses a proof sent with another block's hash, before anything is test-run", async () => {
    const other = (await rpc("eth_getBlockByNumber", [hex(PINNED - 1n), false])) as { hash: Hex };
    const { verdict } = await engine.checkVaultProof({ ...proveIntent(built, account, CHAIN_ID), blockHash: other.hash });
    expect(verdict.level).toBe("rejected");
    expect(verdict.violations.map((v) => v.code)).toContain("VAULT_MALFORMED");
    expect(verdict.violations.some((v) => v.detail?.["blockNumber"] === PINNED.toString())).toBe(true);
  });
});
