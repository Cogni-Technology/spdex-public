/**
 * Permit2 on the fork is the Permit2 spDEX knows.
 *
 * `PERMIT2_CODE_HASH` in `@spdex/core` was read from this fork once. This
 * reads it again on every run, so the constant the Guard compares against
 * cannot drift from the code actually deployed at the pinned block. It also
 * checks the one thing about the typed data that only the contract can
 * answer: the domain separator Permit2 computes for this chain is the one
 * spDEX's typed data hashes to. (Permit2 caches the separator for chain 1 and
 * rebuilds it on any other id, the fork's included, so this exercises the
 * rebuilt one.)
 *
 * Requires a fork: `pnpm anvil:fork`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { hashDomain } from "viem";
import { PERMIT2_ADDRESS, PERMIT2_BATCH_TYPES, PERMIT2_CODE_HASH } from "@spdex/core";
import { httpRpc } from "../../src/reader.js";
import { codeHashAt, permit2NonceBitmap, permit2Status } from "../../src/permit2.js";

const FORK_URL = process.env.SPDEX_FORK_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.SPDEX_FORK_CHAIN_ID ?? "690069");
const rpc = httpRpc(FORK_URL);

beforeAll(async () => {
  try {
    await rpc("eth_chainId", []);
  } catch (error) {
    throw new Error(
      `No fork reachable at ${FORK_URL}. Start one with \`pnpm anvil:fork\`.\n` +
        `Underlying: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

describe("Permit2 at the pinned block", () => {
  it("has exactly the code spDEX pinned", async () => {
    expect(await codeHashAt(rpc, PERMIT2_ADDRESS)).toBe(PERMIT2_CODE_HASH);
    expect(await permit2Status(rpc)).toBe(true);
  });

  it("computes the domain separator spDEX's typed data hashes to, for this chain", async () => {
    // DOMAIN_SEPARATOR()
    const onChain = (await rpc("eth_call", [{ to: PERMIT2_ADDRESS, data: "0x3644e515" }, "latest"])) as string;
    const ours = hashDomain({
      domain: { name: "Permit2", chainId: BigInt(CHAIN_ID), verifyingContract: PERMIT2_ADDRESS },
      types: { EIP712Domain: [...PERMIT2_BATCH_TYPES.EIP712Domain] },
    });
    expect(onChain).toBe(ours);
  });

  it("answers a nonce word for an owner who never used one with zero", async () => {
    const fresh = `0x${"5a".repeat(20)}` as const;
    expect(await permit2NonceBitmap(rpc, fresh, 12345n)).toBe(0n);
  });
});
