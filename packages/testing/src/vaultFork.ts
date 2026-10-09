/**
 * The vault releases and the SPX holder registry on the shared fork, for the
 * tests that drive them from outside the package's own suites: the browser
 * suite (e2e/) above all.
 *
 * Everything here follows AGENTS.md's determinism rules: every key is fresh,
 * nothing moves the fork's clock, nothing is mined but by sending a
 * transaction, and the fork is never snapshotted or rewound. What it adds is
 * the three things a test of v2 needs and can't get from the pinned block:
 *
 * ## Every release, deployed
 *
 * No release is on the fork at its pinned block: v1 reached mainnet at block
 * 26,100,366, after it, and v2 not at all yet. `ensureReleasesOnFork` deploys
 * what is missing of every release in `DEPLOYMENTS`, the way anyone could,
 * through the deterministic deployer, in the order the constructors need
 * (`deployReleaseCalls`, from each release's own source and arguments: v2's
 * registry, factory and the batcher bound to no factory, built for WETH, which
 * every release from v2 on shares; v1's factory and its own batcher from its
 * frozen source). Another run may deploy a contract between the check and the
 * send; a deployment that loses that race reverts with the code there all the
 * same, so only the code is checked afterwards.
 *
 * ## An eligible address that never signs: a real holder, proven
 *
 * anvil can't prove a block it mined (its state root is zero), so a keeper's
 * or a batch's `rewardTo` that must be eligible is a real mainnet holder,
 * `0xb007…bb8e`, proven by a fresh key from a proof recorded from mainnet
 * (`packages/vault/test/fixtures/proofs`, written by `record-proofs.mjs`).
 * Anyone may submit anyone's proof. On a reused fork it is proven already:
 * `validUntil` is read first, and a `NotNewer` from a race means the same.
 *
 * ## An eligible address that must sign: a fresh key, written eligible
 *
 * Help run's connected wallet signs its batch privately, which an
 * impersonated holder can't do (anvil has no key to sign with). So that
 * wallet is a fresh key that buys at least 690 SPX with a real swap on the
 * fork, and is then made eligible by writing its `validUntil` record with
 * `anvil_setStorageAt`: the registry's mapping slot 0, at
 * `keccak256(abi.encode(key, 0))`, a layout `test_validUntilIsMappingSlotZero`
 * pins. It is the one write to the registry a test may make (AGENTS.md), and
 * `writeEligibleOnFork` refuses anything but a fresh key: one with no code and
 * no record, whose key the caller holds (`makeEligibleSigner` has it sign the
 * swap first).
 *
 * Imported by path (e2e/ imports `packages/testing/src/vaultFork.js`), not
 * re-exported from the package's index: it reads recorded proofs and pulls in
 * the vault package, which the red-team suite's users of `@spdex/testing`
 * don't need.
 */

import type { Address, Hex } from "@spdex/core";
import { addressOfKey, generateSpendingKey, prepareTransaction, signPrepared, type JsonRpc } from "@spdex/chain";
import {
  DEPLOYMENTS,
  FACTORY_ABI,
  LATEST_RELEASE,
  MAINNET_FACTORY,
  MAINNET_REGISTRY,
  MIN_SPX,
  PROOF_TTL,
  REGISTRY_ABI,
  SPX_TOKEN,
  V1_FACTORY_ABI,
  VAULT_ABI,
  decodeVaultError,
  deployReleaseCalls,
  proveCall,
  proveGasLimit,
  readHolderStatus,
  type HolderProof,
  type RawLog,
  type VaultPlan,
  type VaultRelease,
} from "@spdex/vault";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";
import holderB007At26000000 from "../../vault/test/fixtures/proofs/holder-b0072e68-26000000.json" with { type: "json" };
import holderB007At25999900 from "../../vault/test/fixtures/proofs/holder-b0072e68-25999900.json" with { type: "json" };

const ETHER = 10n ** 18n;
const lower = (value: string): Address => value.toLowerCase() as Address;
const hex = (value: bigint): Hex => `0x${value.toString(16)}`;

/** A key and its address, lowercase. */
export interface ForkKey {
  key: Hex;
  address: Address;
}

/** A mined transaction's receipt, as the fork returns it. */
export interface ForkReceipt {
  transactionHash: Hex;
  status: string;
  blockNumber: string;
  gasUsed: string;
  effectiveGasPrice: string;
  logs: (RawLog & { blockNumber?: string })[];
}

/**
 * A new random key holding `wei` of ether and nothing else, checked fresh
 * first (no transactions, no code, no ether), so `anvil_setBalance` never
 * lands on an account anything else uses.
 */
export async function freshForkKey(rpc: JsonRpc, wei: bigint): Promise<ForkKey> {
  const key = generateSpendingKey() as Hex;
  const address = lower(addressOfKey(key));
  const [nonce, code, balance] = (await Promise.all([
    rpc("eth_getTransactionCount", [address, "latest"]),
    rpc("eth_getCode", [address, "latest"]),
    rpc("eth_getBalance", [address, "latest"]),
  ])) as string[];
  if (BigInt(nonce!) !== 0n || code !== "0x" || BigInt(balance!) !== 0n) {
    throw new Error(`${address} is not a fresh address; refusing to set its balance`);
  }
  await rpc("anvil_setBalance", [address, hex(wei)]);
  return { key, address };
}

/**
 * Sign one transaction with `from`'s key, send it raw and wait until it is
 * mined. Throws for one that reverts, or that is refused at its estimate.
 * `gas` replaces the estimate's limit when given.
 */
export async function sendFromKey(
  rpc: JsonRpc,
  chainId: number,
  from: ForkKey,
  call: { to: Address; data: Hex; value?: bigint; gas?: bigint },
): Promise<ForkReceipt> {
  const prepared = await prepareTransaction(rpc, { from: from.address, to: call.to, data: call.data, value: call.value ?? 0n, chainId });
  const signed = await signPrepared(from.key, call.gas === undefined ? prepared : { ...prepared, gas: call.gas });
  await rpc("eth_sendRawTransaction", [signed.raw]);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const receipt = (await rpc("eth_getTransactionReceipt", [signed.hash])) as ForkReceipt | null;
    if (receipt !== null) {
      if (BigInt(receipt.status) !== 1n) throw new Error(`${signed.hash} reverted`);
      return receipt;
    }
    if (Date.now() > deadline) throw new Error(`${signed.hash} was not mined within a minute`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const hasCode = async (rpc: JsonRpc, address: Address): Promise<boolean> =>
  ((await rpc("eth_getCode", [address, "latest"])) as string) !== "0x";

// ── Both releases ─────────────────────────────────────────────────────────────

/**
 * Put each release's contracts on the fork, those not there yet, in order,
 * from a fresh key, tolerating a race with another run: by default every
 * release `DEPLOYMENTS` lists, newest first. A contract two releases share
 * (the batcher, from v2 on) is deployed once and found there after. Afterwards
 * every one of them has code, or this throws.
 */
export async function ensureReleasesOnFork(
  rpc: JsonRpc,
  chainId: number,
  releases: readonly VaultRelease[] = DEPLOYMENTS.map((d) => d.id).reverse(),
): Promise<void> {
  let deployer: ForkKey | null = null;
  for (const release of releases) {
    for (const call of deployReleaseCalls(release)) {
      if (await hasCode(rpc, call.address)) continue;
      deployer ??= await freshForkKey(rpc, 2n * ETHER);
      try {
        await sendFromKey(rpc, chainId, deployer, { to: call.to, data: call.data, value: call.value });
      } catch {
        // Refused at its estimate or reverted: most likely deployed by
        // another run in between. The code says.
      }
      if (!(await hasCode(rpc, call.address))) throw new Error(`nothing at ${call.address} after deploying ${release}'s ${call.name}`);
    }
  }
}

/**
 * v1's `createVault`, seven arguments and no community window or turns: what
 * a v1 vault was made with before v2 shipped. The app never makes one now, so
 * a test that needs a v1 vault on the fork (one the app still lists, funds,
 * triggers and closes) makes it this way, on v1's factory.
 */
export function encodeV1CreateVault(plan: Omit<VaultPlan, "communityWindow" | "turnBuckets">): Hex {
  return encodeFunctionData({
    abi: V1_FACTORY_ABI,
    functionName: "createVault",
    args: [plan.marketIndex, plan.amountPerBuy, plan.interval, plan.maxBuys, plan.startAt, plan.keeperReward, plan.maxSlippageBps],
  });
}

/**
 * Every vault the latest release's factory (v2's) lists at `block`, its buys
 * and its buys made inside their community window paid to a community keeper
 * (`windowBuys`), summed:
 * read one vault and one call at a time, the plain way, so a test can hold
 * the app's batched read (Collective DCA) against it. Throws on any call that
 * doesn't answer: unknown is never counted as zero.
 */
export async function v2BuysAt(rpc: JsonRpc, block: bigint): Promise<{ vaults: number; buys: bigint; windowBuys: bigint }> {
  const at = hex(block);
  const call = async (to: Address, data: Hex, what: string): Promise<Hex> => {
    const answer = (await rpc("eth_call", [{ to, data }, at])) as string;
    if (typeof answer !== "string" || answer === "0x") throw new Error(`${what} answered nothing at block ${block}`);
    return answer as Hex;
  };
  const factory = lower(MAINNET_FACTORY);
  const count = decodeFunctionResult({
    abi: FACTORY_ABI,
    functionName: "vaultCount",
    data: await call(factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: "vaultCount" }), "vaultCount()"),
  });
  const vaults = decodeFunctionResult({
    abi: FACTORY_ABI,
    functionName: "vaultsPage",
    data: await call(factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: "vaultsPage", args: [0n, count] }), "vaultsPage()"),
  });
  if (BigInt(vaults.length) !== count) throw new Error(`the latest release's factory counts ${count} vaults and lists ${vaults.length}`);
  let buys = 0n;
  let windowBuys = 0n;
  for (const vault of vaults) {
    const to = lower(vault);
    buys += BigInt(
      decodeFunctionResult({ abi: VAULT_ABI, functionName: "buysDone", data: await call(to, encodeFunctionData({ abi: VAULT_ABI, functionName: "buysDone" }), `${to}'s buysDone()`) }),
    );
    windowBuys += BigInt(
      decodeFunctionResult({ abi: VAULT_ABI, functionName: "windowBuys", data: await call(to, encodeFunctionData({ abi: VAULT_ABI, functionName: "windowBuys" }), `${to}'s windowBuys()`) }),
    );
  }
  return { vaults: vaults.length, buys, windowBuys };
}

// ── The registry ──────────────────────────────────────────────────────────────

/** `validUntil(holder)` on the latest release's registry (v2's), at the latest block. */
export async function validUntilOnFork(rpc: JsonRpc, holder: Address, registry: Address = MAINNET_REGISTRY): Promise<bigint> {
  const data = (await rpc("eth_call", [
    { to: registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "validUntil", args: [lower(holder)] }) },
    "latest",
  ])) as Hex;
  return BigInt(decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "validUntil", data }));
}

/** Where the registry keeps `holder`'s `validUntil`: mapping slot 0, so `keccak256(abi.encode(holder, 0))`. */
export function validUntilSlot(holder: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [lower(holder), 0n]));
}

/** A proof recorded from mainnet, as `packages/vault/scripts/record-proofs.mjs` writes it. */
export interface RecordedProof {
  holder: string;
  blockNumber: number;
  blockHash: string;
  stateRoot: string;
  timestamp: number;
  balance: string;
  header: string;
  accountProof: string[];
  storageProof: string[];
}

/** A recorded proof as the package's `HolderProof`, ready for `proveCall`. */
export function recordedHolderProof(recorded: RecordedProof): HolderProof {
  return {
    holder: lower(recorded.holder),
    blockNumber: BigInt(recorded.blockNumber),
    blockHash: recorded.blockHash.toLowerCase() as Hex,
    timestamp: BigInt(recorded.timestamp),
    balance: BigInt(recorded.balance),
    header: recorded.header.toLowerCase() as Hex,
    accountProof: recorded.accountProof.map((node) => node.toLowerCase() as Hex),
    storageProof: recorded.storageProof.map((node) => node.toLowerCase() as Hex),
    validUntil: BigInt(recorded.timestamp) + PROOF_TTL,
  };
}

/**
 * The real mainnet SPX holder the fork's tests pay as an eligible `rewardTo`:
 * an ordinary account (no code), 1,210 SPX at the pinned block, which no test
 * ever sends SPX to or from.
 */
export const FORK_HOLDER: Address = "0xb0072e684e532bd1dcc442b5ed22097db205bb8e";

/** `FORK_HOLDER`'s recorded proofs, newest first: the pinned block's, then one 100 blocks before it. */
export const FORK_HOLDER_PROOFS: readonly RecordedProof[] = [holderB007At26000000, holderB007At25999900];

/**
 * Make `FORK_HOLDER` eligible on the fork, as anyone could: submit its newest
 * recorded proof from a fresh key, or the older one where the fork can no
 * longer check the newer's block — unless it is proven already, by this
 * proof or a newer one, which `validUntil` says. Returns its `validUntil`.
 *
 * Throws, saying what to do, once the fork has mined past the recorded
 * blocks: the registry checks a block's hash among the last 8,191 only, so a
 * fork that old is restarted (`pnpm anvil:fork`), never moved to another block.
 */
export async function ensureHolderProven(rpc: JsonRpc, chainId: number): Promise<bigint> {
  await ensureReleasesOnFork(rpc, chainId, [LATEST_RELEASE]);
  for (const recorded of FORK_HOLDER_PROOFS) {
    const proof = recordedHolderProof(recorded);
    const stored = await validUntilOnFork(rpc, FORK_HOLDER);
    if (stored >= proof.validUntil) return stored;
    const call = proveCall(proof);
    const prover = await freshForkKey(rpc, ETHER / 10n);
    let estimate: bigint;
    try {
      estimate = BigInt((await rpc("eth_estimateGas", [{ from: prover.address, to: call.to, data: call.data }])) as string);
    } catch (error) {
      // Proven by another run in between: as good.
      if (decodeVaultError((error as { data?: string }).data ?? "0x")?.name === "NotNewer") return validUntilOnFork(rpc, FORK_HOLDER);
      // The fork can no longer check this block's hash: the older proof, if it can.
      continue;
    }
    await sendFromKey(rpc, chainId, prover, { to: call.to, data: call.data, gas: proveGasLimit(estimate) });
    return validUntilOnFork(rpc, FORK_HOLDER);
  }
  throw new Error(
    `${FORK_HOLDER} can't be proven from its recorded proofs: the fork has mined more than 8,191 blocks past them. ` +
      "Restart `pnpm anvil:fork`; never move the pinned block.",
  );
}

/** Uniswap v2's router on mainnet: the swap that buys a fresh key its SPX, with no approval needed. */
const UNISWAP_V2_ROUTER: Address = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
const WETH: Address = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

/** SPX held by `owner`, at the latest block. Throws rather than reading a failed call as zero. */
export async function spxBalanceOnFork(rpc: JsonRpc, owner: Address): Promise<bigint> {
  const raw = (await rpc("eth_call", [{ to: SPX_TOKEN, data: `0x70a08231${lower(owner).slice(2).padStart(64, "0")}` }, "latest"])) as string;
  if (!/^0x[0-9a-f]{64}$/i.test(raw)) throw new Error(`SPX's balanceOf(${owner}) answered ${JSON.stringify(raw)}`);
  return BigInt(raw);
}

/** The fork's time as its next block will carry it: the idle head's lags, by as long as nothing was sent. */
export async function forkChainTime(rpc: JsonRpc): Promise<bigint> {
  const pending = (await rpc("eth_getBlockByNumber", ["pending", false])) as { timestamp: string };
  return BigInt(pending.timestamp);
}

/**
 * Buy SPX for a fresh key with a real swap of `spend` of its own ether
 * (0.15 ETH by default, about 1,200 SPX at the pinned block) through Uniswap
 * v2's router, signed with its key. Returns what it holds afterwards, at
 * least 690 SPX or this throws. The SPX is the fork's: no block before the
 * fork's own shows it, so no proof can be built of it.
 */
export async function buySpxOnFork(rpc: JsonRpc, chainId: number, account: ForkKey, spend: bigint = (15n * ETHER) / 100n): Promise<bigint> {
  const address = lower(account.address);
  const word = (value: string) => value.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  // swapExactETHForTokens(amountOutMin, path, to, deadline): the path's offset
  // is 0x80, four head words in.
  const swap = ("0x7ff36ab5" + word("0") + word("80") + word(address) + word("2540be3ff") + word("2") + word(WETH) + word(SPX_TOKEN)) as Hex;
  await sendFromKey(rpc, chainId, account, { to: UNISWAP_V2_ROUTER, data: swap, value: spend });
  const spx = await spxBalanceOnFork(rpc, address);
  if (spx < MIN_SPX) throw new Error(`the swap bought ${address} only ${spx} SPX units, under the ${MIN_SPX} a keeper holds; spend more`);
  return spx;
}

/**
 * Write a fresh key's `validUntil` in the registry: the one write to the
 * registry a test may make (see the file comment). By default the fork's now
 * plus a proof's 30 days, as if it had just proven; a test of the lapse
 * banner passes a nearer time. Refuses a key that isn't fresh to the registry
 * — one with code, or with a record already — and one whose key isn't the
 * caller's, so a real holder's record is never written. Checks afterwards,
 * through the app's own reader, that the registry records what was written;
 * whether that makes it eligible is the registry's to say (it holds 690 SPX
 * too, `buySpxOnFork`), and is returned.
 */
export async function writeEligibleOnFork(
  rpc: JsonRpc,
  account: ForkKey,
  validUntil?: bigint,
): Promise<{ validUntil: bigint; eligible: boolean | null }> {
  const address = lower(account.address);
  if (lower(addressOfKey(account.key)) !== address) throw new Error(`the key given is not ${address}'s`);
  if (await hasCode(rpc, address)) throw new Error(`${address} has code: only a fresh key is ever written eligible`);
  if ((await validUntilOnFork(rpc, address)) !== 0n) throw new Error(`${address} already has a registry record: only a fresh key is ever written eligible`);
  const until = validUntil ?? (await forkChainTime(rpc)) + PROOF_TTL;
  if (until <= 0n || until >= 2n ** 64n) throw new Error(`validUntil ${until} doesn't fit the registry's uint64`);
  await rpc("anvil_setStorageAt", [MAINNET_REGISTRY, validUntilSlot(address), `0x${until.toString(16).padStart(64, "0")}`]);
  const status = await readHolderStatus(rpc, address);
  if (status.state !== "read" || status.validUntil !== until) {
    throw new Error(`${address}'s record didn't read back as written: ${JSON.stringify(status, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }
  return { validUntil: until, eligible: status.eligible };
}

/**
 * Make a fresh key an eligible community keeper on the fork, the one way a
 * test may (see the file comment): buy its SPX with a real swap
 * (`buySpxOnFork`), then write its `validUntil` (`writeEligibleOnFork`),
 * and check that the registry finds it eligible.
 */
export async function makeEligibleSigner(
  rpc: JsonRpc,
  chainId: number,
  account: ForkKey,
  options: { spend?: bigint; validUntil?: bigint } = {},
): Promise<{ spx: bigint; validUntil: bigint }> {
  if ((await validUntilOnFork(rpc, account.address)) !== 0n) {
    throw new Error(`${account.address} already has a registry record: only a fresh key is ever written eligible`);
  }
  const spx = await buySpxOnFork(rpc, chainId, account, options.spend);
  const { validUntil, eligible } = await writeEligibleOnFork(rpc, account, options.validUntil);
  if (eligible !== true) throw new Error(`${account.address} holds ${spx} SPX units and a record until ${validUntil}, and the registry doesn't find it eligible`);
  return { spx, validUntil };
}
