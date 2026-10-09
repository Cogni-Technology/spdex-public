/**
 * An allowance inside Permit2, as a real Permit2 logs it on the fork.
 *
 * The red-team cases build Permit2's `Approval` and `Permit` logs by hand.
 * This pins those shapes to the contract itself: a real simulation of
 * `Permit2.approve`, and of `Permit2.permit` with a signature the node makes,
 * decoded by `observeEffects` into an approval inside Permit2 for the right
 * owner, token, spender and amount. It also shows why the Guard must refuse
 * one: with the ERC-20 permission a batched tip gives Permit2, the spender
 * of such an allowance takes the balance with no signature at all.
 *
 * Nothing here changes the fork. Every step is `eth_simulateV1` or a
 * signature, and the account's code is cleared only inside the simulation.
 *
 * Requires a fork: `pnpm anvil:fork` (SPDEX_FORK_URL picks which).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { EthSimulateV1Provider, TOKENS, httpRpc, type SimLog } from "@spdex/chain";
import {
  encodePermit2Approval,
  PERMIT2_ADDRESS,
  type Address,
  type Hex,
} from "@spdex/core";
import { observeEffects } from "../../src/effects.js";

/** The environment, read without Node's types, which this package does not carry. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const FORK_URL = env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);

/** anvil #8: unlocked on the node, so it can sign; nothing is sent from it. */
const OWNER: Address = "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f";
const ATTACKER: Address = "0x6666666666666666666666666666666666666666";
const SPX = TOKENS.SPX.address as Address;
const V2_FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const MAX_160 = (1n << 160n) - 1n;
const MAX_48 = (1n << 48n) - 1n;

const word = (value: string | bigint) =>
  (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "").toLowerCase()).padStart(64, "0");

/** `Permit2.approve(token, spender, amount, expiration)`: an allowance with no signature. */
const permit2Approve = (token: Address, spender: Address, amount: bigint, expiration: bigint): Hex =>
  `0x87517c45${word(token)}${word(spender)}${word(amount)}${word(expiration)}` as Hex;

/** `Permit2.transferFrom(from, to, amount, token)`: what the holder of that allowance sends. */
const permit2TransferFrom = (from: Address, to: Address, amount: bigint, token: Address): Hex =>
  `0x36c78516${word(from)}${word(to)}${word(amount)}${word(token)}` as Hex;

interface RawCall {
  from: Address;
  to: Address;
  data: Hex;
}

/** One simulated block of calls, each from its own sender; the fork is not changed. */
async function simulate(calls: RawCall[], codeless: Address[] = []): Promise<{ status: string; logs: SimLog[] }[]> {
  const overrides = Object.fromEntries(codeless.map((address) => [address, { code: "0x" }]));
  const result = (await rpc("eth_simulateV1", [
    {
      blockStateCalls: [{ calls, stateOverrides: overrides }],
      traceTransfers: true,
      validation: false,
    },
    "latest",
  ])) as { calls: { status: string; logs?: { address: string; topics: string[]; data: string }[] }[] }[];
  return result[0]!.calls.map((call) => ({
    status: call.status,
    logs: (call.logs ?? []).map((log) => ({
      address: log.address.toLowerCase() as Address,
      topics: log.topics.map((topic) => topic.toLowerCase() as Hex),
      data: log.data as Hex,
    })),
  }));
}

beforeAll(async () => {
  try {
    await rpc("eth_chainId", []);
  } catch (error) {
    throw new Error(
      `No fork reachable at ${FORK_URL}. Start one with \`pnpm anvil:fork\`.\n` +
        `Underlying: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // The simulation provider the Guard uses must be one that can run here.
  expect(await new EthSimulateV1Provider(rpc).isAvailable()).toBe(true);
});

describe("Permit2's own allowances, decoded from the real contract", () => {
  it("reads Permit2.approve as an allowance inside Permit2, not as nothing", async () => {
    const [approved] = await simulate([
      { from: OWNER, to: PERMIT2_ADDRESS, data: permit2Approve(SPX, ATTACKER, MAX_160, MAX_48) },
    ]);
    expect(approved!.status).toBe("0x1");
    const effects = observeEffects(approved!.logs);
    expect(effects.undecodable).toBe(0);
    expect(effects.approvals).toEqual([
      { token: SPX, owner: OWNER, spender: ATTACKER, amount: MAX_160, via: "permit2" },
    ]);
  });

  it("reads Permit2.permit, from a signature, the same way", async () => {
    // A PermitSingle for the attacker, signed by the node for its unlocked
    // account: the shape a phished signature would have.
    const nonce = 0n;
    const sigDeadline = BigInt(Math.floor(Date.now() / 1000) + 3_600) + 10n ** 7n;
    const typed = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        PermitSingle: [
          { name: "details", type: "PermitDetails" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
        PermitDetails: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
      },
      primaryType: "PermitSingle",
      domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2_ADDRESS },
      message: {
        details: { token: SPX, amount: MAX_160.toString(), expiration: MAX_48.toString(), nonce: nonce.toString() },
        spender: ATTACKER,
        sigDeadline: sigDeadline.toString(),
      },
    };
    const signature = ((await rpc("eth_signTypedData_v4", [OWNER, JSON.stringify(typed)])) as string).replace(/^0x/, "");
    expect(signature).toHaveLength(130);

    // permit(address owner, ((address,uint160,uint48,uint48),address,uint256) permitSingle, bytes signature)
    const data = (`0x2b67b570${word(OWNER)}${word(SPX)}${word(MAX_160)}${word(MAX_48)}${word(nonce)}` +
      `${word(ATTACKER)}${word(sigDeadline)}${word(0x100n)}${word(65n)}${signature.padEnd(128 + 64, "0")}`) as Hex;
    // The owner's inherited delegation is cleared inside the simulation, so
    // Permit2 checks the signature by ecrecover as it would for a plain account.
    const [permitted] = await simulate([{ from: ATTACKER, to: PERMIT2_ADDRESS, data }], [OWNER]);
    expect(permitted!.status).toBe("0x1");
    const effects = observeEffects(permitted!.logs);
    expect(effects.undecodable).toBe(0);
    expect(effects.approvals).toEqual([
      { token: SPX, owner: OWNER, spender: ATTACKER, amount: MAX_160, via: "permit2" },
    ]);
  });

  it("is worth refusing: with the tip's permission, that allowance takes the balance with no signature", async () => {
    // Any SPX holder will do, since nothing is signed: the SPX/WETH v2 pair.
    const pairWord = (await rpc("eth_call", [
      { to: V2_FACTORY, data: `0xe6a43905${word(SPX)}${word(TOKENS.WETH.address)}` },
      "latest",
    ])) as string;
    const holder = `0x${pairWord.slice(-40)}` as Address;
    const balanceWord = (await rpc("eth_call", [{ to: SPX, data: `0x70a08231${word(holder)}` }, "latest"])) as string;
    const balance = BigInt(balanceWord);
    expect(balance).toBeGreaterThan(0n);

    const steps = await simulate([
      // What the first batched tip asks for: approve(Permit2, max) on SPX.
      { from: holder, to: SPX, data: encodePermit2Approval("grant") },
      // What a hostile swap would slip in, from the owner's own transaction.
      { from: holder, to: PERMIT2_ADDRESS, data: permit2Approve(SPX, ATTACKER, MAX_160, MAX_48) },
      // Later, and by the attacker alone.
      { from: ATTACKER, to: PERMIT2_ADDRESS, data: permit2TransferFrom(holder, ATTACKER, balance, SPX) },
    ]);
    expect(steps.map((step) => step.status)).toEqual(["0x1", "0x1", "0x1"]);
    const moved = observeEffects(steps[2]!.logs).deltas.get(`${SPX}:${ATTACKER}`)?.delta;
    expect(moved).toBe(balance);

    // Without the ERC-20 permission, the same pull fails: the tip's grant is
    // what arms an allowance inside Permit2.
    const unarmed = await simulate([
      { from: holder, to: PERMIT2_ADDRESS, data: permit2Approve(SPX, ATTACKER, MAX_160, MAX_48) },
      { from: ATTACKER, to: PERMIT2_ADDRESS, data: permit2TransferFrom(holder, ATTACKER, balance, SPX) },
    ]);
    expect(unarmed[1]!.status).toBe("0x0");
  });
});
