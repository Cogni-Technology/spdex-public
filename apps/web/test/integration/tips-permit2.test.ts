/**
 * Batched tips against the fork: the real Engine, the real Guard with a real
 * simulation, a signature from the node, and Permit2 itself.
 *
 * The unit tests pin the bytes and the order of the steps against fakes. They
 * cannot show that Permit2 accepts what spDEX builds: that the typed data the
 * node signs verifies on chain, that the one transaction pays each recipient
 * exactly what the intent says, that the Guard's simulation agrees with what
 * then happens, and that the signature cannot be spent twice. This does, by
 * running `sendTips` (lib/tipFlow.ts) with the node standing in for the wallet.
 *
 * A development account, because only an unlocked account can have the node
 * sign `eth_signTypedData_v4`, which is the same path the e2e wallet takes.
 * Its inherited EIP-7702 delegation is stripped first, as the e2e fixtures
 * do: Permit2 checks a signature from an address with code through EIP-1271,
 * which the sweeper's code does not answer. Its balance is never set: it pays
 * for its own SPX out of its own ether. The recipients are fresh addresses,
 * so "received exactly" is measured from zero.
 *
 * Requires a fork: `pnpm anvil:fork` (SPDEX_FORK_URL picks which).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpRpc, permit2NonceBitmap, TOKENS } from "@spdex/chain";
import { recommendedConfig } from "@spdex/config";
import { MAX_UINT256, PERMIT2_ADDRESS, type Address, type TipPlan, type TipTransfer } from "@spdex/core";
import { Engine } from "../../src/lib/engine.js";
import { allowance, balanceOf } from "../../src/lib/erc20.js";
import { sendTips, type TipCall } from "../../src/lib/tipFlow.js";
import { buildPermit2Permission } from "../../src/lib/tips.js";

const FORK_URL = process.env["SPDEX_FORK_URL"] ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env["SPDEX_FORK_CHAIN_ID"] ?? "690069");
const rpc = httpRpc(FORK_URL);

/** anvil #7: no placeholder recipient, and not the account the e2e tipping specs draw. */
const ACCOUNT: Address = "0x14dc79964da2c08b23698b3d3cc7ca32193d9955";
const SPX = TOKENS.SPX;
const V2_ROUTER = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
const WETH = TOKENS.WETH.address;

const engine = new Engine({
  ...recommendedConfig(),
  chainId: CHAIN_ID,
  rpc: { url: FORK_URL, source: "user" },
});

function freshAddress(): Address {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Address;
}

async function mined(hash: string): Promise<{ status: string }> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { status: string } | null;
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${hash} was not mined`);
}

/** Send from the account, as its wallet would, and wait for it to succeed. */
async function send(call: { to: string; data: string; value?: bigint }): Promise<string> {
  const hash = (await rpc("eth_sendTransaction", [
    { from: ACCOUNT, to: call.to, data: call.data, value: `0x${(call.value ?? 0n).toString(16)}`, gas: "0x2dc6c0" },
  ])) as string;
  const receipt = await mined(hash);
  if (BigInt(receipt.status) !== 1n) throw new Error(`${hash} reverted`);
  return hash;
}

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

let delivered = 0n;

beforeAll(async () => {
  try {
    await rpc("eth_chainId", []);
  } catch (error) {
    throw new Error(
      `No fork reachable at ${FORK_URL}. Start one with \`pnpm anvil:fork\`.\n` +
        `Underlying: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // See the header: a plain account, so Permit2 checks the signature by ecrecover.
  await rpc("anvil_setCode", [ACCOUNT, "0x"]);

  // Some SPX, bought with the account's own ether: swapExactETHForTokens.
  const before = await balanceOf(rpc, SPX.address, ACCOUNT);
  await send({
    to: V2_ROUTER,
    value: 5n * 10n ** 16n,
    data: `0x7ff36ab5${word("0")}${word("80")}${word(ACCOUNT)}${word("2540be3ff")}${word("2")}${word(WETH)}${word(SPX.address)}`,
  });
  delivered = (await balanceOf(rpc, SPX.address, ACCOUNT)) - before;

  // Start from an account that never gave Permit2 the permission, whatever an
  // earlier run left: the first batched tip is the one that asks for it.
  const revoke = buildPermit2Permission("revoke", { chainId: CHAIN_ID, account: ACCOUNT, token: SPX.address });
  await send(revoke.call);
});

describe("tips batched through Permit2, on the fork", () => {
  it("finds Permit2 to be the contract spDEX knows", async () => {
    expect(await engine.permit2Available()).toBe(true);
  });

  const recipients = [freshAddress(), freshAddress()];
  const sent: TipCall[] = [];
  const typed: string[] = [];
  /** What the wallet was asked, in order: "sign", or the kind of transaction. */
  const asked: string[] = [];
  let batch: TipPlan | null = null;

  it("pays each recipient exactly, in one transaction, after one signature and then the standing permission", async () => {
    expect(delivered).toBeGreaterThan(0n);
    // Uneven shares, so an amount paid to the wrong recipient would show.
    const transfers: TipTransfer[] = [
      { recipient: recipients[0]!, amount: (delivered * 30n) / 10_000n, label: "first" },
      { recipient: recipients[1]!, amount: (delivered * 20n) / 10_000n, label: "second" },
    ];
    const spxBefore = await balanceOf(rpc, SPX.address, ACCOUNT);

    const outcome = await sendTips({
      checks: {
        checkTips: async (plan) => {
          if (plan.mode === "permit2-batch") batch = plan;
          const verdict = await engine.checkTips(plan);
          // Every check the flow makes runs against a real simulation.
          expect(verdict.level, JSON.stringify(verdict.violations)).toBe("verified");
          return verdict;
        },
        checkTipSignature: async (request) => {
          const verdict = await engine.checkTipSignature(request);
          expect(verdict.level, JSON.stringify(verdict.violations)).toBe("verified");
          return verdict;
        },
        checkTipPermission: async (plan) => {
          const verdict = await engine.checkTipPermission(plan);
          expect(verdict.level, JSON.stringify(verdict.violations)).toBe("verified");
          return verdict;
        },
        permit2Available: () => engine.permit2Available(),
      },
      chainId: CHAIN_ID,
      account: ACCOUNT,
      token: SPX,
      delivered,
      transfers,
      readAllowance: () => allowance(rpc, SPX.address, ACCOUNT, PERMIT2_ADDRESS),
      readNonceBitmap: (w) => permit2NonceBitmap(rpc, ACCOUNT, w),
      // The node signs for its unlocked account, exactly as the e2e wallet relays it.
      signTypedData: (data) => {
        asked.push("sign");
        typed.push(data);
        return rpc("eth_signTypedData_v4", [ACCOUNT, data]);
      },
      send: async (call) => {
        asked.push(call.to === PERMIT2_ADDRESS ? "batch" : "permission");
        sent.push(call);
        await send(call);
      },
      onStep: () => {},
    });

    expect(outcome.mode, outcome.note).toBe("permit2-batch");
    expect(typed).toHaveLength(1);
    // The signature, made while Permit2 had no permission at all (it doesn't
    // depend on one), then the standing permission, then the one batch.
    expect(asked).toEqual(["sign", "permission", "batch"]);
    expect(sent.map((call) => call.to)).toEqual([SPX.address, PERMIT2_ADDRESS]);

    for (const transfer of transfers) {
      expect(await balanceOf(rpc, SPX.address, transfer.recipient)).toBe(transfer.amount);
    }
    const total = transfers.reduce((sum, t) => sum + t.amount, 0n);
    expect(spxBefore - (await balanceOf(rpc, SPX.address, ACCOUNT))).toBe(total);
    // SPX spends an allowance down even from the maximum, and logs the new
    // figure as an Approval to Permit2: the one approval the Guard lets a batch
    // show (see TipGuard's effects check), and why "given" on the Tip row means
    // "at least half the maximum" rather than "exactly the maximum".
    expect(await allowance(rpc, SPX.address, ACCOUNT, PERMIT2_ADDRESS)).toBe(MAX_UINT256 - total);
  });

  it("refuses to spend the same signature twice: Permit2 reverts, and the Guard says so first", async () => {
    expect(batch).not.toBeNull();
    const call = batch!.calls[0]!;
    // Replayed as it was: Permit2 has marked the nonce used.
    await expect(rpc("eth_call", [{ from: ACCOUNT, to: call.to, data: call.data }, "latest"])).rejects.toThrow();
    const verdict = await engine.checkTips(batch!);
    expect(verdict.signable).toBe(false);
    expect(verdict.violations.map((v) => v.code)).toContain("SIMULATION_REVERTED");
  });

  it("asks for no permission the second time, and a fresh nonce", async () => {
    const recipient = freshAddress();
    const other = freshAddress();
    const calls: TipCall[] = [];
    const outcome = await sendTips({
      checks: engine,
      chainId: CHAIN_ID,
      account: ACCOUNT,
      token: SPX,
      delivered,
      transfers: [
        { recipient, amount: 1_000n, label: "a" },
        { recipient: other, amount: 2_000n, label: "b" },
      ],
      readAllowance: () => allowance(rpc, SPX.address, ACCOUNT, PERMIT2_ADDRESS),
      readNonceBitmap: (w) => permit2NonceBitmap(rpc, ACCOUNT, w),
      signTypedData: (data) => rpc("eth_signTypedData_v4", [ACCOUNT, data]),
      send: async (call) => {
        calls.push(call);
        await send(call);
      },
      onStep: () => {},
    });
    expect(outcome.mode, outcome.note).toBe("permit2-batch");
    expect(calls.map((call) => call.to)).toEqual([PERMIT2_ADDRESS]);
    expect(await balanceOf(rpc, SPX.address, recipient)).toBe(1_000n);
    expect(await balanceOf(rpc, SPX.address, other)).toBe(2_000n);
  });

  it("revokes the permission through the Guard, leaving Permit2 unable to move anything", async () => {
    const plan = buildPermit2Permission("revoke", { chainId: CHAIN_ID, account: ACCOUNT, token: SPX.address });
    const verdict = await engine.checkTipPermission(plan);
    expect(verdict.level, JSON.stringify(verdict.violations)).toBe("verified");
    await send(plan.call);
    expect(await allowance(rpc, SPX.address, ACCOUNT, PERMIT2_ADDRESS)).toBe(0n);
  });
});

describe("an account whose own code answers for its signatures", () => {
  /*
   * Permit2 checks a signature by ecrecover only when the owner has no code.
   * An EIP-7702 account has code (its delegation designator), so Permit2 asks
   * that code instead (EIP-1271), and the delegate decides. The one every
   * anvil account carries on mainnet, and so on the fork until stripped, is
   * a sweeper that does not answer. The batch then reverts, the Guard's
   * simulation sees it before anything is sent, and the tips go as separate
   * transfers, which need no signature. Put back afterwards, as a plain
   * account, the way beforeAll found it.
   */
  const SWEEPER_DELEGATION = "0xef01008a67b5020ee254ef48e3b6a04927f39baf7e408a";

  afterAll(async () => {
    await rpc("anvil_setCode", [ACCOUNT, "0x"]);
    await send(buildPermit2Permission("revoke", { chainId: CHAIN_ID, account: ACCOUNT, token: SPX.address }).call);
  });

  it("sends separate transfers, and says why, when Permit2 would refuse the signature", async () => {
    await rpc("anvil_setCode", [ACCOUNT, SWEEPER_DELEGATION]);
    const recipients = [freshAddress(), freshAddress()];
    const transfers: TipTransfer[] = [
      { recipient: recipients[0]!, amount: 3_000n, label: "first" },
      { recipient: recipients[1]!, amount: 2_000n, label: "second" },
    ];
    const calls: TipCall[] = [];
    const verdicts: string[][] = [];
    const outcome = await sendTips({
      checks: {
        checkTips: async (plan) => {
          const verdict = await engine.checkTips(plan);
          verdicts.push([plan.mode ?? "transfers", ...verdict.violations.map((v) => v.code)]);
          return verdict;
        },
        checkTipSignature: (request) => engine.checkTipSignature(request),
        checkTipPermission: (plan) => engine.checkTipPermission(plan),
        permit2Available: () => engine.permit2Available(),
      },
      chainId: CHAIN_ID,
      account: ACCOUNT,
      token: SPX,
      delivered,
      transfers,
      readAllowance: () => allowance(rpc, SPX.address, ACCOUNT, PERMIT2_ADDRESS),
      readNonceBitmap: (w) => permit2NonceBitmap(rpc, ACCOUNT, w),
      signTypedData: (data) => rpc("eth_signTypedData_v4", [ACCOUNT, data]),
      send: async (call) => {
        calls.push(call);
        await send(call);
      },
      onStep: () => {},
    });

    expect(outcome.mode, outcome.note).toBe("transfers");
    expect(outcome.note).toContain("in 2 separate transfers: the one transaction would fail on chain");
    // The batch was refused on its simulation alone, and the transfers passed.
    expect(verdicts).toEqual([["permit2-batch", "SIMULATION_REVERTED"], ["transfers"]]);
    // The standing permission (revoked by the test before), asked after the
    // signature, then a transfer each, and nothing to Permit2.
    expect(calls.map((call) => call.to)).toEqual([SPX.address, SPX.address, SPX.address]);
    for (const transfer of transfers) {
      expect(await balanceOf(rpc, SPX.address, transfer.recipient)).toBe(transfer.amount);
    }
  });
});
