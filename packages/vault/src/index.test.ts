/**
 * The vault's TypeScript layer against scripted reads: no node, no network.
 *
 * What these pin is the part a fork test would find only by accident — the
 * artifacts agree with themselves and with `@spdex/chain`'s addresses, every
 * encoder round-trips through the ABI, a vault's address is a function of its
 * factory, owner, nonce and every term, and a figure that could not be read
 * comes back unknown rather than zero. That the encodings are what the deployed
 * contracts accept — and that `predictVault` agrees with the factory's own — is
 * `test/integration/vault.test.ts`'s job. The buy fee is `fee.test.ts`'s, and
 * the batcher's encoders and decoders `batcher.test.ts`'s.
 */

import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getContractAddress,
  isAddress,
  keccak256,
  parseAbi,
  toBytes,
  toFunctionSelector,
} from "viem";
import type { Address, Hex } from "@spdex/core";
import {
  DETERMINISTIC_DEPLOYER,
  EXECUTE_GAS,
  FACTORY_ABI,
  FACTORY_LIMITS,
  KEEPER_GAS_HEADROOM_BPS,
  KEEPER_MIN_EXECUTE_GAS_LIMIT,
  MAX_EXECUTE_GAS_LIMIT,
  FACTORY_CREATION_CODE,
  FACTORY_CREATION_CODE_HASH,
  FACTORY_SALT,
  MAINNET_DEPLOYMENT,
  MAINNET_FACTORY,
  MAINNET_IMPLEMENTATION,
  OWNER_SEARCH_MAX_QUERIES,
  VAULT_ABI,
  VAULT_ARGS_LENGTH,
  VAULT_LIMITS,
  checksumAddress,
  decodeVaultError,
  decodeVaultEvent,
  deployFactoryCall,
  deploymentBlock,
  describeListingRefusal,
  describeMarketGap,
  encodeClose,
  encodeCreateVault,
  encodeExecute,
  encodeFund,
  encodeRescue,
  encodeVaultArgs,
  factoryAddress,
  findVaultsByOwner,
  factoryInitCode,
  fundingRoom,
  implementationAddress,
  marketOf,
  oracleReading,
  predictVault,
  readVault,
  readVaultCount,
  readVaultsPage,
  simulateFactoryDeployment,
  termsOfPlan,
  termsProblems,
  vaultAvailability,
  vaultBudget,
  vaultRuntimeCode,
  vaultsCreatedBy,
  whyNotNow,
  type FactoryDeployment,
  type VaultPlan,
  type VaultState,
  type VaultStatus,
  type VaultTerms,
} from "./index.js";
import { CONTRACTS, TOKENS, sqrtRatioAtTick } from "@spdex/chain";

const WETH: Address = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const SPX: Address = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c";
const PAIR: Address = "0x52c77b0cb827afbad022e6d6caf2c44452edbc39";
const POOL: Address = "0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3";
const VAULT: Address = "0x00000000000000000000000000000000000000aa";
const OWNER: Address = "0x00000000000000000000000000000000000000bb";
const NOW = 1_790_000_000n;

const plan = (overrides: Partial<VaultPlan> = {}): VaultPlan => ({
  marketIndex: 0n,
  amountPerBuy: 10n ** 16n,
  interval: 3600n,
  maxBuys: 10n,
  startAt: NOW,
  keeperReward: 69n * 10n ** 12n,
  maxSlippageBps: 300n,
  ...overrides,
});

const terms = (overrides: Partial<VaultTerms> = {}): VaultTerms => ({
  tokenOut: SPX,
  pair: PAIR,
  oraclePool: POOL,
  amountPerBuy: 10n ** 16n,
  interval: 3600n,
  maxBuys: 10n,
  startAt: NOW,
  keeperReward: 69n * 10n ** 12n,
  maxSlippageBps: 300n,
  ...overrides,
});

describe("artifacts", () => {
  it("agree with themselves: salt, code hash, and the mainnet factory and implementation", () => {
    expect(FACTORY_SALT).toBe(keccak256(toBytes("spdex.vault.factory.v1")));
    expect(keccak256(FACTORY_CREATION_CODE)).toBe(FACTORY_CREATION_CODE_HASH);
    expect(factoryAddress(MAINNET_DEPLOYMENT)).toBe(MAINNET_FACTORY);
    expect(factoryAddress(MAINNET_DEPLOYMENT)).toBe(
      getContractAddress({
        opcode: "CREATE2",
        from: DETERMINISTIC_DEPLOYER,
        salt: FACTORY_SALT,
        bytecode: `${FACTORY_CREATION_CODE}${encodeAbiParameters(
          [
            { type: "address" },
            { type: "address" },
            { type: "address" },
            {
              type: "tuple[]",
              components: [
                { type: "address", name: "tokenOut" },
                { type: "address", name: "pair" },
                { type: "address", name: "oraclePool" },
              ],
            },
          ],
          [WETH, MAINNET_DEPLOYMENT.uniswapV2Factory, MAINNET_DEPLOYMENT.uniswapV3Factory, [{ tokenOut: SPX, pair: PAIR, oraclePool: POOL }]],
        ).slice(2)}`,
      }).toLowerCase(),
    );
    expect(implementationAddress(MAINNET_FACTORY)).toBe(MAINNET_IMPLEMENTATION);
  });

  it("the address commits to every constructor argument, the market list above all", () => {
    const other = (d: Partial<FactoryDeployment>) => factoryAddress({ ...MAINNET_DEPLOYMENT, ...d });
    const elsewhere = "0x0000000000000000000000000000000000000001";
    expect(other({ weth: elsewhere })).not.toBe(MAINNET_FACTORY);
    expect(other({ uniswapV2Factory: elsewhere })).not.toBe(MAINNET_FACTORY);
    expect(other({ uniswapV3Factory: elsewhere })).not.toBe(MAINNET_FACTORY);
    expect(other({ markets: [] })).not.toBe(MAINNET_FACTORY);
    expect(other({ markets: [{ tokenOut: SPX, pair: PAIR, oraclePool: "0x00ed26e794b949e18b142f9108429b74ce08ac99" }] })).not.toBe(
      MAINNET_FACTORY,
    );
  });

  it("mainnet's deployment is exactly WETH to SPX, on the addresses @spdex/chain verifies", () => {
    expect(MAINNET_DEPLOYMENT).toEqual({
      weth: TOKENS.WETH.address,
      uniswapV2Factory: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
      uniswapV3Factory: CONTRACTS.uniV3Factory,
      markets: [{ tokenOut: TOKENS.SPX.address, pair: PAIR, oraclePool: POOL }],
    });
  });

  it("pins the limits, the hard funding cap above all", () => {
    // A change to any of these changes what every vault promises; it should
    // take editing this test as well as the contract.
    expect(VAULT_LIMITS).toEqual({
      MAX_FUNDING: 5n * 10n ** 17n,
      MIN_INTERVAL: 300n,
      MAX_INTERVAL: 366n * 86_400n,
      MAX_SLIPPAGE_BPS: 500n,
      MAX_REWARD_BPS: 69n,
      TWAP_WINDOW: 600n,
      MIN_ORACLE_DEPTH: 10n * 10n ** 18n,
      MIN_OBSERVATIONS: 100n,
      MAX_BUYS: 1_000n,
      MAX_START_DRIFT: 366n * 86_400n,
    });
    expect(FACTORY_LIMITS).toEqual({ MAX_MARKET_GAP_BPS: 200n });
  });

  it("the factory deployment is the deterministic deployer's format: salt, then init code", () => {
    const call = deployFactoryCall();
    expect(call.to).toBe(DETERMINISTIC_DEPLOYER);
    expect(call.value).toBe(0n);
    expect(call.factory).toBe(MAINNET_FACTORY);
    expect(call.data.slice(0, 66)).toBe(FACTORY_SALT);
    expect(call.data.slice(66)).toBe(factoryInitCode(MAINNET_DEPLOYMENT).slice(2));
  });
});

describe("encoding", () => {
  it("createVault carries the market's index and the plan, and nothing else", () => {
    const decoded = decodeFunctionData({ abi: FACTORY_ABI, data: encodeCreateVault(plan({ marketIndex: 0n })) });
    expect(decoded.functionName).toBe("createVault");
    const p = plan();
    expect(decoded.args).toEqual([p.marketIndex, p.amountPerBuy, p.interval, p.maxBuys, p.startAt, p.keeperReward, p.maxSlippageBps]);
  });

  it("a plan's terms are its market's addresses and the plan", () => {
    expect(termsOfPlan(plan())).toEqual(terms());
    expect(marketOf(plan({ marketIndex: 1n }))).toBeNull();
    expect(marketOf(plan({ marketIndex: -1n }))).toBeNull();
    expect(() => termsOfPlan(plan({ marketIndex: 1n }))).toThrow(RangeError);
  });

  it("the vault's calls are their selectors, and rescue names its token", () => {
    expect(encodeFund()).toBe(toFunctionSelector("fund()"));
    expect(encodeExecute()).toBe(toFunctionSelector("execute()"));
    expect(encodeClose()).toBe(toFunctionSelector("close()"));
    const rescue = decodeFunctionData({ abi: VAULT_ABI, data: encodeRescue(SPX) });
    expect(rescue.functionName).toBe("rescue");
    expect(String(rescue.args?.[0]).toLowerCase()).toBe(SPX);
  });
});

describe("where a vault lives", () => {
  it("its terms are packed into 112 bytes, in the contract's order", () => {
    const args = encodeVaultArgs(OWNER, terms());
    expect((args.length - 2) / 2).toBe(VAULT_ARGS_LENGTH);
    const at = (offset: number, bytes: number) => BigInt(`0x${args.slice(2 + offset * 2, 2 + (offset + bytes) * 2)}`);
    expect(at(0, 20)).toBe(BigInt(OWNER));
    expect(at(20, 20)).toBe(BigInt(SPX));
    expect(at(40, 20)).toBe(BigInt(PAIR));
    expect(at(60, 20)).toBe(BigInt(POOL));
    expect(at(80, 8)).toBe(terms().amountPerBuy);
    expect(at(88, 8)).toBe(terms().keeperReward);
    expect(at(96, 8)).toBe(NOW);
    expect(at(104, 4)).toBe(3600n);
    expect(at(108, 2)).toBe(10n);
    expect(at(110, 2)).toBe(300n);
  });

  it("its code is the EIP-1167 proxy for the implementation, then its terms", () => {
    const code = vaultRuntimeCode(MAINNET_IMPLEMENTATION, OWNER, terms());
    expect((code.length - 2) / 2).toBe(45 + VAULT_ARGS_LENGTH);
    expect(code).toBe(`0x363d3d373d3d3d363d73${MAINNET_IMPLEMENTATION.slice(2)}5af43d82803e903d91602b57fd5bf3${encodeVaultArgs(OWNER, terms()).slice(2)}`);
  });

  it("its address is a function of the factory, the owner, the nonce and every term", () => {
    const at = (input: Partial<Parameters<typeof predictVault>[0]>) =>
      predictVault({ factory: MAINNET_FACTORY, owner: OWNER, nonce: 0n, terms: terms(), ...input });
    const base = at({});
    expect(base).toMatch(/^0x[0-9a-f]{40}$/);
    expect(at({})).toBe(base);
    expect(at({ nonce: 1n })).not.toBe(base);
    expect(at({ owner: VAULT })).not.toBe(base);
    expect(at({ factory: VAULT })).not.toBe(base);
    for (const key of ["amountPerBuy", "interval", "maxBuys", "startAt", "keeperReward", "maxSlippageBps"] as const) {
      expect(at({ terms: terms({ [key]: terms()[key] + 1n }) }), key).not.toBe(base);
    }
    // By hand: CREATE2 over the ten-byte prefix and the runtime, salted with (owner, nonce).
    const runtime = vaultRuntimeCode(MAINNET_IMPLEMENTATION, OWNER, terms());
    expect(base).toBe(
      getContractAddress({
        opcode: "CREATE2",
        from: MAINNET_FACTORY,
        salt: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [OWNER, 0n])),
        bytecode: `0x61009d3d81600a3d39f3${runtime.slice(2)}`,
      }).toLowerCase(),
    );
  });
});

describe("decoding", () => {
  it("reads VaultCreated and Bought, lowercasing addresses", () => {
    const event = FACTORY_ABI.find((i) => i.type === "event" && i.name === "VaultCreated")!;
    const created = decodeVaultEvent({
      address: MAINNET_FACTORY.toUpperCase().replace("0X", "0x"),
      topics: encodeEventTopics({ abi: FACTORY_ABI, eventName: "VaultCreated", args: { owner: OWNER, vault: VAULT } }) as Hex[],
      data: encodeAbiParameters(event.inputs.filter((input) => !input.indexed), [0n, terms(), 7n]),
    });
    expect(created).toEqual({
      name: "VaultCreated",
      emitter: MAINNET_FACTORY,
      owner: OWNER,
      vault: VAULT,
      marketIndex: 0n,
      terms: terms(),
      funded: 7n,
    });

    const bought = decodeVaultEvent({
      address: VAULT,
      topics: encodeEventTopics({ abi: VAULT_ABI, eventName: "Bought", args: { slot: 3n, keeper: OWNER } }) as Hex[],
      data: encodeAbiParameters(Array(6).fill({ type: "uint256" }), [10n, 20n, 1n, 18n, 4n, 60n * 10n ** 18n]),
    });
    expect(bought).toEqual({
      name: "Bought",
      emitter: VAULT,
      slot: 3n,
      amountIn: 10n,
      amountOut: 20n,
      keeper: OWNER,
      reward: 1n,
      floorOut: 18n,
      buyNumber: 4n,
      oracleDepth: 60n * 10n ** 18n,
    });
  });

  it("knows the events by the topics the contracts emit", () => {
    // The layouts other packages match by hand (the app's history reader, the Guard's tests).
    expect(encodeEventTopics({ abi: VAULT_ABI, eventName: "Bought" })[0]).toBe(
      "0xd2423a0b788a514c63e7297eb3d53ac18227830670fc6fa504be37ed61b296b6",
    );
    expect(encodeEventTopics({ abi: FACTORY_ABI, eventName: "VaultCreated" })[0]).toBe(
      "0xb888b71d90fcdc2e1651a455bddf729f7b1b568ec746d390afa2c35ac599e961",
    );
    // The old, shorter Bought no longer decodes: a log from an older build is not this one's.
    const old = parseAbi(["event Bought(uint256 indexed slot, uint256 amountIn, uint256 amountOut, address indexed keeper, uint256 reward)"]);
    expect(
      decodeVaultEvent({
        address: VAULT,
        topics: encodeEventTopics({ abi: old, eventName: "Bought", args: { slot: 0n, keeper: OWNER } }) as Hex[],
        data: encodeAbiParameters(Array(3).fill({ type: "uint256" }), [1n, 2n, 3n]),
      }),
    ).toBeNull();
  });

  /**
   * Phase-5b review 1, finding 5: any contract can emit VaultCreated with the
   * factory's exact signature — even one that ran the factory's own code by
   * delegatecall, on a market the factory never listed. Only the factory's own
   * logs count.
   */
  it("reads a creation only from the factory's own logs", () => {
    const event = FACTORY_ABI.find((i) => i.type === "event" && i.name === "VaultCreated")!;
    const log = (address: Address, vault: Address) => ({
      address,
      topics: encodeEventTopics({ abi: FACTORY_ABI, eventName: "VaultCreated", args: { owner: OWNER, vault } }) as Hex[],
      data: encodeAbiParameters(event.inputs.filter((input) => !input.indexed), [0n, terms(), 0n]),
    });
    const forger: Address = "0x00000000000000000000000000000000000000f0";
    const logs = [log(forger, "0x00000000000000000000000000000000000000f1"), log(MAINNET_FACTORY, VAULT)];
    const created = vaultsCreatedBy(MAINNET_FACTORY, logs);
    expect(created.map((e) => [e.emitter, e.vault])).toEqual([[MAINNET_FACTORY, VAULT]]);
    // The same logs decoded one by one include the look-alike, with its emitter: that is the trap.
    expect(logs.map(decodeVaultEvent).map((e) => e?.emitter)).toEqual([forger, MAINNET_FACTORY]);
    expect(vaultsCreatedBy(forger.toUpperCase().replace("0X", "0x") as Address, logs).map((e) => e.vault)).toEqual([
      "0x00000000000000000000000000000000000000f1",
    ]);
  });

  it("returns null for anything that is not one of its events, rather than guessing", () => {
    const transfer = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
    expect(
      decodeVaultEvent({
        address: VAULT,
        topics: encodeEventTopics({ abi: transfer, eventName: "Transfer", args: { from: OWNER, to: VAULT } }) as Hex[],
        data: encodeAbiParameters([{ type: "uint256" }], [1n]),
      }),
    ).toBeNull();
    // Right topic, truncated data.
    expect(
      decodeVaultEvent({
        address: VAULT,
        topics: encodeEventTopics({ abi: VAULT_ABI, eventName: "Funded" }) as Hex[],
        data: "0x1234",
      }),
    ).toBeNull();
  });

  it("names the vault's and the factory's own errors, with their figures", () => {
    const data = encodeErrorResult({ abi: VAULT_ABI, errorName: "PriceBelowFloor", args: [90n, 100n] });
    expect(decodeVaultError(data)).toEqual({ name: "PriceBelowFloor", args: [90n, 100n] });
    expect(decodeVaultError(encodeErrorResult({ abi: VAULT_ABI, errorName: "Reentrancy" }))).toEqual({
      name: "Reentrancy",
      args: [],
    });
    expect(decodeVaultError(encodeErrorResult({ abi: FACTORY_ABI, errorName: "UnknownMarket", args: [1n, 1n] }))).toEqual({
      name: "UnknownMarket",
      args: [1n, 1n],
    });
    // Same name, different contract, different figures: the vault's at a buy, the factory's for a list entry.
    expect(decodeVaultError(encodeErrorResult({ abi: FACTORY_ABI, errorName: "OracleTooThin", args: [0n, 1n, 2n] }))).toEqual({
      name: "OracleTooThin",
      args: [0n, 1n, 2n],
    });
    // A pool's "OLD", an out-of-gas: not ours to name.
    expect(decodeVaultError("0x08c379a0")).toBeNull();
    expect(decodeVaultError("0x")).toBeNull();
  });
});

describe("plans", () => {
  it("finds nothing wrong with a sound plan, and the budget is maxBuys × (buy + reward)", () => {
    expect(termsProblems(plan(), NOW)).toEqual([]);
    expect(vaultBudget(plan())).toBe(10n * (10n ** 16n + 69n * 10n ** 12n));
  });

  it("names each problem as the factory would", () => {
    expect(termsProblems(plan({ marketIndex: 1n }), NOW)).toEqual(["UnknownMarket"]);
    expect(termsProblems(plan({ amountPerBuy: 0n }), NOW)).toContain("AmountOutOfRange");
    expect(termsProblems(plan({ interval: 299n }), NOW)).toEqual(["IntervalOutOfRange"]);
    expect(termsProblems(plan({ maxBuys: 1_001n }), NOW)).toContain("BuysOutOfRange");
    expect(termsProblems(plan({ maxSlippageBps: 0n }), NOW)).toEqual(["SlippageOutOfRange"]);
    expect(termsProblems(plan({ keeperReward: 69n * 10n ** 12n + 1n }), NOW)).toEqual(["RewardTooLarge"]);
    expect(termsProblems(plan({ maxBuys: 50n }), NOW)).toEqual(["FundingCapExceeded"]);
    expect(termsProblems(plan({ startAt: NOW + 367n * 86_400n }), NOW)).toEqual(["StartOutOfRange"]);
    expect(termsProblems(plan({ keeperReward: 0n, maxBuys: 50n }), NOW)).toEqual([]); // exactly 0.5 ETH
  });
});

describe("gas for one buy", () => {
  it("signs an execute with at least EXECUTE_GAS plus 20%, and at most what the batcher gives a vault", () => {
    expect(EXECUTE_GAS).toBe(320_000n);
    expect(KEEPER_MIN_EXECUTE_GAS_LIMIT).toBe((EXECUTE_GAS * KEEPER_GAS_HEADROOM_BPS) / 10_000n);
    expect(KEEPER_MIN_EXECUTE_GAS_LIMIT).toBe(384_000n);
    expect(KEEPER_MIN_EXECUTE_GAS_LIMIT < MAX_EXECUTE_GAS_LIMIT).toBe(true);
    expect(MAX_EXECUTE_GAS_LIMIT).toBe(400_000n);
  });
});

// ─── Scripted reads ──────────────────────────────────────────────────────────

type Call = { to: Address; data: Hex };

/** A reader that answers each call from a table keyed by target and selector; unknown calls "revert". */
function scriptedReader(answers: Record<string, Hex>) {
  const seen: Call[] = [];
  return {
    seen,
    multicall: async (calls: Call[]) => {
      seen.push(...calls);
      return calls.map((call) => answers[`${call.to.toLowerCase()}:${call.data.slice(0, 10)}`] ?? "0x");
    },
  };
}

const sel = (signature: string) => toFunctionSelector(signature);
// Every view readVault asks for takes no arguments, so its signature is its name and "()".
const vaultAnswer = (functionName: string, result: unknown): [string, Hex] => [
  `${VAULT}:${sel(`${functionName}()`)}`,
  encodeFunctionResult({ abi: VAULT_ABI, functionName: functionName as never, result: result as never }),
];

function vaultAnswers(overrides: Record<string, unknown> = {}): Record<string, Hex> {
  const values: Record<string, unknown> = {
    terms: terms(),
    owner: OWNER,
    closed: false,
    buysDone: 2,
    totalOut: 12_345n,
    totalRewards: 10n ** 15n,
    status: [true, NOW, 8n, 8n * (10n ** 16n + 69n * 10n ** 12n), true],
    quote: [5_000n, 4_800n, 60n * 10n ** 18n],
    ...overrides,
  };
  return Object.fromEntries(Object.entries(values).map(([name, value]) => vaultAnswer(name, value)));
}

const noRpc = async () => {
  throw new Error("no network in unit tests");
};

const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11";
const clockAnswer = (now: bigint): Record<string, Hex> => ({
  [`${MULTICALL3}:${sel("getCurrentBlockTimestamp()")}`]: encodeAbiParameters([{ type: "uint256" }], [now]),
});

describe("readVault", () => {
  it("reads everything in one round trip, whether the factory vouches for it, and the chain's time", async () => {
    const reader = scriptedReader({
      ...vaultAnswers(),
      ...clockAnswer(NOW + 100n),
      [`${MAINNET_FACTORY}:${sel("isVault(address)")}`]: encodeFunctionResult({
        abi: FACTORY_ABI,
        functionName: "isVault",
        result: true,
      }),
    });
    const state = await readVault(noRpc, VAULT, { factory: MAINNET_FACTORY, reader });
    expect(state).toEqual({
      address: VAULT,
      owner: OWNER,
      terms: terms(),
      closed: false,
      buysDone: 2n,
      totalOut: 12_345n,
      totalRewards: 10n ** 15n,
      status: { due: true, nextBuyAt: NOW, buysLeft: 8n, wethBalance: 8n * (10n ** 16n + 69n * 10n ** 12n), funded: true },
      quote: { spotOut: 5_000n, floorOut: 4_800n, oracleDepth: 60n * 10n ** 18n },
      fromFactory: true,
      chainTime: NOW + 100n,
    });
    expect(fundingRoom(state!)).toBe(0n);
    // One batch: the eight views, the clock, and the factory.
    expect(reader.seen).toHaveLength(10);
  });

  it("an oracle that cannot answer is an unknown quote, never a zero floor; an unread clock is unknown too", async () => {
    const answers = vaultAnswers();
    delete answers[`${VAULT}:${sel("quote()")}`];
    const state = await readVault(noRpc, VAULT, { reader: scriptedReader(answers) });
    expect(state!.quote).toBeNull();
    expect(state!.fromFactory).toBeNull();
    expect(state!.chainTime).toBeNull();
  });

  it("is null for an address that does not answer like a vault", async () => {
    expect(await readVault(noRpc, VAULT, { reader: scriptedReader({}) })).toBeNull();
  });

  it("reports no next buy for a finished plan, and room to fund for a partly funded one", async () => {
    const finished = await readVault(noRpc, VAULT, {
      reader: scriptedReader(vaultAnswers({ status: [false, 0n, 0n, 0n, false] })),
    });
    expect(finished!.status.nextBuyAt).toBeNull();

    const partly = await readVault(noRpc, VAULT, {
      reader: scriptedReader(vaultAnswers({ status: [true, NOW, 8n, 10n ** 16n, true] })),
    });
    expect(fundingRoom(partly!)).toBe(8n * (10n ** 16n + 69n * 10n ** 12n) - 10n ** 16n);
  });
});

describe("whyNotNow", () => {
  const vaultState = (overrides: Omit<Partial<VaultState>, "status"> & { status?: Partial<VaultStatus> } = {}): VaultState => {
    const { status, ...rest } = overrides;
    return {
      address: VAULT,
      owner: OWNER,
      terms: terms(),
      closed: false,
      buysDone: 0n,
      totalOut: 0n,
      totalRewards: 0n,
      status: { due: true, nextBuyAt: NOW, buysLeft: 10n, wethBalance: 10n ** 17n, funded: true, ...status },
      quote: { spotOut: 1_000n, floorOut: 970n, oracleDepth: 60n * 10n ** 18n },
      fromFactory: true,
      chainTime: NOW + 100n,
      ...rest,
    };
  };

  it("is null exactly when a buy is due, funded and inside its floor", () => {
    expect(whyNotNow(vaultState())).toBeNull();
  });

  it("gives the first reason, in the order the vault would refuse it", () => {
    expect(whyNotNow(vaultState({ closed: true }))).toBe("closed by its owner");
    expect(whyNotNow(vaultState({ status: { buysLeft: 0n } }))).toBe("every buy is done");
    expect(whyNotNow(vaultState({ status: { funded: false, due: false } }))).toBe("not funded for its next buy");
    expect(whyNotNow(vaultState({ status: { due: false, nextBuyAt: NOW + 3_600n } }))).toBe("next buy due at 2026-09-21T15:13:20.000Z (chain time)");
    expect(whyNotNow(vaultState({ status: { due: false }, quote: null }))).toMatch(/oracle cannot answer/);
    expect(whyNotNow(vaultState({ quote: { spotOut: 900n, floorOut: 1_000n, oracleDepth: 60n * 10n ** 18n } }))).toBe(
      "the price is 10.00% outside its floor; the buy waits for the market",
    );
  });
});

describe("the factory's vault list", () => {
  const list: Address[] = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2"];

  /** An endpoint answering `vaultCount` and `vaultsPage` for MAINNET_FACTORY from `list`, as the factory does. */
  function factoryRpc() {
    const calls: { to: string; data: Hex; block: string }[] = [];
    const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
      if (method !== "eth_call") throw new Error(`the method ${method} does not exist`);
      const [call, block] = params as [{ to: string; data: Hex }, string];
      calls.push({ ...call, block });
      if (call.to !== MAINNET_FACTORY) throw new Error("execution reverted");
      const decoded = decodeFunctionData({ abi: FACTORY_ABI, data: call.data });
      if (decoded.functionName === "vaultCount") {
        return encodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultCount", result: BigInt(list.length) });
      }
      if (decoded.functionName === "vaultsPage") {
        const [offset, limit] = decoded.args;
        const page = list.slice(Number(offset), Number(offset + (limit < 1_000n ? limit : 1_000n)));
        return encodeFunctionResult({ abi: FACTORY_ABI, functionName: "vaultsPage", result: page.map((a) => a.toUpperCase().replace("0X", "0x") as Address) });
      }
      throw new Error("execution reverted");
    };
    return { rpc, calls };
  }

  it("counts the factory's vaults and reads them a page at a time, oldest first, lowercased", async () => {
    const { rpc, calls } = factoryRpc();
    expect(await readVaultCount(rpc, MAINNET_FACTORY)).toBe(2n);
    expect(await readVaultsPage(rpc, MAINNET_FACTORY, 0n, 500n)).toEqual(list);
    expect(await readVaultsPage(rpc, MAINNET_FACTORY, 1n, 500n)).toEqual([list[1]]);
    expect(await readVaultsPage(rpc, MAINNET_FACTORY, 2n, 500n)).toEqual([]);
    expect(calls.map((call) => [call.data.slice(0, 10), call.block])).toEqual([
      ["0xa7c6a100", "latest"],
      ["0xab7ec471", "latest"],
      ["0xab7ec471", "latest"],
      ["0xab7ec471", "latest"],
    ]);
  });

  it("throws when the list cannot be read, rather than calling it empty", async () => {
    const { rpc } = factoryRpc();
    await expect(readVaultCount(rpc, VAULT)).rejects.toThrow();
    await expect(readVaultsPage(rpc, VAULT, 0n, 10n)).rejects.toThrow();
  });

  it("finds the factory's deployment block by a binary search for the first block with code", async () => {
    const rpc = async (method: string, params: unknown[]) => {
      if (method === "eth_blockNumber") return "0x18cba80";
      return BigInt(params[1] as string) >= 25_123_456n ? "0x60" : "0x";
    };
    expect(await deploymentBlock(rpc, MAINNET_FACTORY)).toBe(25_123_456n);
  });
});

describe("oracleReading", () => {
  it("is the vault's arithmetic: the mean tick, and the harmonic-mean liquidity as a virtual WETH reserve", () => {
    // Constant liquidity l over the window, at tick 0: the depth is l either way round.
    const l = 10n ** 18n;
    const perLiquidity = (600n << 128n) / l;
    const flat = oracleReading({ tickCumulatives: [0n, 0n], secondsPerLiquidity: [0n, perLiquidity], wethIsToken0: true });
    expect(flat.meanTick).toBe(0);
    expect(flat.depth - l).toBeGreaterThanOrEqual(0n);
    expect(flat.depth - l).toBeLessThan(l / 10n ** 12n);

    // SPX/WETH 0.3% at the pinned block, WETH as token0: about 57.6 WETH (Math.t.sol pins the same).
    const tick = -144_610;
    const liquidity = 41_721_308_557_234_405n;
    const spx = oracleReading({
      tickCumulatives: [0n, BigInt(tick) * 600n],
      secondsPerLiquidity: [0n, (600n << 128n) / liquidity],
      wethIsToken0: true,
    });
    expect(spx.meanTick).toBe(tick);
    expect(spx.depth).toBeGreaterThan(57n * 10n ** 18n);
    expect(spx.depth).toBeLessThan(58n * 10n ** 18n);
    // And the other way round, the reserve is L·√P rather than L/√P.
    const asToken1 = oracleReading({
      tickCumulatives: [0n, BigInt(tick) * 600n],
      secondsPerLiquidity: [0n, (600n << 128n) / liquidity],
      wethIsToken0: false,
    });
    expect(asToken1.depth).toBe((liquidity * sqrtRatioAtTick(tick)) >> 96n);
  });

  it("wraps the accumulator like the pool, and reads no growth as no depth", () => {
    const l = 10n ** 18n;
    const max = (1n << 160n) - 1n;
    const half = (300n << 128n) / l;
    const wrapped = oracleReading({ tickCumulatives: [0n, 0n], secondsPerLiquidity: [max - half + 1n, half], wethIsToken0: true });
    expect(wrapped.depth).toBeGreaterThan(l - l / 10n ** 12n);
    expect(oracleReading({ tickCumulatives: [0n, 0n], secondsPerLiquidity: [5n, 5n], wethIsToken0: true }).depth).toBe(0n);
  });
});

describe("vaultAvailability", () => {
  const ETH = 10n ** 18n;

  /** SPX's market as it was at the pinned block, and what to break in it. */
  interface ScriptedMarket {
    /** The pair's WETH and SPX reserves; WETH is token0. */
    reserves: [bigint, bigint];
    /** Observations the pool keeps (slot0's cardinality). */
    observations: number;
    /** Harmonic-mean liquidity over the window; 0 for a pool that cannot answer `observe` ("OLD"). */
    liquidity: bigint;
    tick: number;
  }
  const spx: ScriptedMarket = {
    reserves: [2_500n * ETH, 1_311_917_741_192_500n],
    observations: 1_800,
    liquidity: 41_721_308_557_234_405n,
    tick: -144_610,
  };

  function reader(market: ScriptedMarket | "unreadable") {
    return {
      multicall: async (calls: Call[]) => {
        if (market === "unreadable") return calls.map(() => "0x");
        return calls.map((call) => {
          const target = call.to.toLowerCase();
          const selector = call.data.slice(0, 10);
          if (target === PAIR) {
            return encodeAbiParameters([{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }], [...market.reserves, 0]);
          }
          if (target !== POOL) return "0x";
          if (selector === sel("slot0()")) {
            return encodeAbiParameters(
              ["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"].map((type) => ({ type })),
              [sqrtRatioAtTick(market.tick), market.tick, 0, market.observations, market.observations, 0, true],
            );
          }
          if (market.liquidity === 0n) return "0x";
          return encodeAbiParameters(
            [{ type: "int56[]" }, { type: "uint160[]" }],
            [
              [0n, BigInt(market.tick) * 600n],
              [0n, (600n << 128n) / market.liquidity],
            ],
          );
        });
      },
    };
  }
  /** A factory deployed or not, and what simulating its deployment answers: success, a revert with this data, or no answer. */
  const rpcWithFactory =
    (deployed: boolean, deployment: "succeeds" | Hex | "unanswered" = "succeeds") =>
    async (method: string, params: unknown[] = []) => {
      if (method === "eth_getCode") return deployed ? "0x60" : "0x";
      if (method === "eth_call" && (params[0] as { to?: string }).to === undefined) {
        if (deployment === "succeeds") return "0x6080";
        if (deployment === "unanswered") throw new Error("eth_call: method not available");
        throw Object.assign(new Error("eth_call: execution reverted"), { data: deployment });
      }
      throw new Error(method);
    };

  it("offers a vault when the factory is deployed and SPX's market is healthy", async () => {
    const result = await vaultAvailability(rpcWithFactory(true), { reader: reader(spx) });
    expect(result).toMatchObject({
      available: true,
      factory: MAINNET_FACTORY,
      factoryDeployed: true,
      factoryDeployable: null,
      market: { index: 0, tokenOut: SPX, pair: PAIR, oraclePool: POOL },
      marketHealthy: true,
      reasons: [],
    });
    expect(result.oracleDepth).toBeGreaterThan(57n * ETH);
    expect(result.oracleDepth).toBeLessThan(58n * ETH);
    expect(result.marketGapBps).not.toBeNull();
    expect(result.marketGapBps! < 200n && result.marketGapBps! > -200n).toBe(true);
  });

  it("does not offer one before the factory is deployed, and says the deployment is anyone's to send when it would succeed", async () => {
    const result = await vaultAvailability(rpcWithFactory(false), { reader: reader(spx) });
    expect(result).toMatchObject({ available: false, factoryDeployed: false, factoryDeployable: true, marketHealthy: true });
    expect(result.reasons).toEqual([expect.stringMatching(/not deployed on this chain yet; deploying it is one transaction anyone can send/)]);

    const unknown = await vaultAvailability(noRpc, { reader: reader(spx) });
    expect(unknown).toMatchObject({ available: false, factoryDeployed: null, factoryDeployable: null, marketHealthy: true });
  });

  /**
   * Phase-5b review 2, finding 3: the reason offered the deployment whatever
   * the market's state, and a deployment that fails says nothing through the
   * deterministic deployer. It is simulated as a plain creation now, and the
   * constructor's own error is the reason. Before the fix this said "anyone can
   * send".
   */
  it("says why the deployment would be refused, in the constructor's own terms, rather than offering it", async () => {
    const refused = encodeErrorResult({
      abi: FACTORY_ABI,
      errorName: "MarketsDisagree",
      args: [0n, 470_000_000_000n, 500_000_000_000n],
    });
    const result = await vaultAvailability(rpcWithFactory(false, refused), { reader: reader(spx) });
    expect(result).toMatchObject({ available: false, factoryDeployed: false, factoryDeployable: false });
    expect(result.reasons).toEqual([
      "the vault factory is not deployed on this chain yet, and deploying it would be refused right now: market 0's pool and pair disagree by 6.00% right now (the factory allows 2.00%)",
    ]);

    const unanswered = await vaultAvailability(rpcWithFactory(false, "unanswered"), { reader: reader(spx) });
    expect(unanswered).toMatchObject({ available: false, factoryDeployed: false, factoryDeployable: null });
    expect(unanswered.reasons[0]).toMatch(/would not say whether deploying it would succeed/);
  });

  it("says why an unhealthy market is not offered, one reason each", async () => {
    const cases: [Partial<ScriptedMarket>, RegExp][] = [
      [{ liquidity: spx.liquidity / 10n }, /too thin to price a buy right now \(5\.7 WETH of depth over ten minutes; the vault needs 10\.0\)/],
      [{ observations: 51 }, /too short a history \(51 observations; the vault needs 100\)/],
      [{ liquidity: 0n }, /cannot answer a 10-minute average right now/],
      [{ tick: -145_100 }, /quotes 4\.\d\d% fewer tokens per WETH than its pair right now \(the listing allowed 2\.00%\)/],
      [{ tick: -144_100 }, /quotes [45]\.\d\d% more tokens per WETH than its pair right now \(the listing allowed 2\.00%\)/],
      [{ reserves: [0n, 0n] }, /v2 pair holds no liquidity/],
    ];
    for (const [change, reason] of cases) {
      const result = await vaultAvailability(rpcWithFactory(true), { reader: reader({ ...spx, ...change }) });
      expect(result, String(reason)).toMatchObject({ available: false, factoryDeployed: true, marketHealthy: false });
      expect(result.reasons).toEqual([expect.stringMatching(reason)]);
    }
    // Inside the allowance, the same market is healthy.
    const near = await vaultAvailability(rpcWithFactory(true), { reader: reader({ ...spx, tick: -144_700 }) });
    expect(near.available).toBe(true);
  });

  /**
   * Phase-5b reviews 1 and 2: the gap reason said "buys wait until they agree"
   * either way. No vault checks the gap; when the pool quotes fewer tokens than
   * the pair, buys go ahead with a floor looser against the pair by the gap
   * (`test_r5b_buysContinueWhileThePoolAndPairDisagreeBeyondTheListingGap`
   * shows it on chain). Before the fix the first expectation failed.
   */
  it("words the gap by its direction, because no vault re-checks it", async () => {
    const fewer = await vaultAvailability(rpcWithFactory(true), { reader: reader({ ...spx, tick: -145_100 }) });
    expect(fewer.marketGapBps! < -200n).toBe(true);
    expect(fewer.reasons[0]).toMatch(/buys still go ahead, and each buy's floor sits 4\.\d\d% further below the pair's price than its plan's allowance until the pool catches up$/);
    expect(fewer.reasons[0]).not.toMatch(/wait/);

    const more = await vaultAvailability(rpcWithFactory(true), { reader: reader({ ...spx, tick: -144_100 }) });
    expect(more.marketGapBps! > 200n).toBe(true);
    expect(more.reasons[0]).toMatch(/a buy waits while the gap is more than its plan's allowance less the pair's 0\.3% fee$/);
  });

  it("words the gap for one plan, as a vault's card shows it", () => {
    expect(describeMarketGap(-531n, 100n)).toBe(
      "the market's oracle pool quotes 5.31% fewer tokens per WETH than its pair right now (the listing allowed 2.00%): buys still go ahead, and this plan's floor sits about 6.31% below the pair's price rather than 1.00% until the pool catches up",
    );
    // A 3% allowance, less the pair's 0.3% fee, is refused by a 3% gap and not by a 2.5% one.
    expect(describeMarketGap(300n, 300n)).toMatch(/: this plan's buys wait until the gap is under about 2\.70%$/);
    expect(describeMarketGap(250n, 300n)).toMatch(/: this plan's buys still go ahead, its allowance being wider than the gap$/);
    expect(describeMarketGap(250n, 500n)).toMatch(/: this plan's buys still go ahead, its allowance being wider than the gap$/);
  });

  it("an unreadable market is unknown, not unhealthy, and an unknown index is no market", async () => {
    const unreadable = await vaultAvailability(rpcWithFactory(true), { reader: reader("unreadable") });
    expect(unreadable).toMatchObject({ available: false, marketHealthy: null, oracleDepth: null, marketGapBps: null, reasons: ["could not read the market"] });

    const missing = await vaultAvailability(rpcWithFactory(true), { marketIndex: 1, reader: reader(spx) });
    expect(missing).toMatchObject({ available: false, market: null, marketHealthy: null, reasons: ["market 1 is not on this factory's list"] });
  });
});

describe("simulateFactoryDeployment", () => {
  const call = (answer: () => unknown) => async (method: string, params: unknown[]) => {
    expect(method).toBe("eth_call");
    // A plain creation: the init code, and no recipient.
    expect(params[0]).toEqual({ data: factoryInitCode(MAINNET_DEPLOYMENT) });
    return answer();
  };

  it("passes when the creation code runs, and names the constructor's refusal when it does not", async () => {
    expect(await simulateFactoryDeployment(call(() => "0x6080"))).toEqual({ deployable: true });
    const data = encodeErrorResult({ abi: FACTORY_ABI, errorName: "PoolNotFromUniswap", args: [0n] });
    expect(
      await simulateFactoryDeployment(
        call(() => {
          throw Object.assign(new Error("eth_call: execution reverted"), { data });
        }),
      ),
    ).toEqual({
      deployable: false,
      error: { name: "PoolNotFromUniswap", args: [0n] },
      reason: "market 0's pool is not one Uniswap v3 lists on this chain",
    });
    // An endpoint that only prints the data in its message.
    const printed = await simulateFactoryDeployment(
      call(() => {
        throw new Error(`execution reverted: custom error ${data}`);
      }),
    );
    expect(printed).toMatchObject({ deployable: false, error: { name: "PoolNotFromUniswap" } });
  });

  it("throws when the endpoint would not run it, rather than calling that a refusal", async () => {
    await expect(
      simulateFactoryDeployment(
        call(() => {
          throw new Error("eth_call: method not available");
        }),
      ),
    ).rejects.toThrow(/method not available/);
  });

  it("words every constructor refusal with its figures", () => {
    const words = (name: string, args: bigint[] = []) => describeListingRefusal({ name, args });
    expect(words("OracleHistoryTooShort", [0n, 1n, 100n])).toBe("market 0's pool keeps too short a history (1 observations; the factory needs 100)");
    expect(words("OracleTooThin", [0n, 5n * 10n ** 18n, 10n * 10n ** 18n])).toBe(
      "market 0's pool is too thin right now (5.0 WETH of depth over ten minutes; the factory needs 10.0)",
    );
    expect(words("PairNotFromUniswap", [0n])).toBe("market 0's pair is not the one Uniswap v2 lists on this chain");
    expect(describeListingRefusal(null)).toBe("its creation code reverts without a reason");
  });

});

// ─── Finding an owner's vaults ───────────────────────────────────────────────

describe("findVaultsByOwner", () => {
  const OTHER: Address = "0x00000000000000000000000000000000000000cc";
  const vaultAt = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
  const createdEvent = FACTORY_ABI.find((i) => i.type === "event" && i.name === "VaultCreated")!;

  interface Log {
    address: string;
    topics: Hex[];
    data: Hex;
    blockNumber: Hex;
    logIndex: Hex;
  }

  /** A `VaultCreated` log at `block`, by default the factory's, for OWNER. */
  const created = (vault: Address, block: number, options: { owner?: Address; emitter?: Address; logIndex?: number } = {}): Log => ({
    address: options.emitter ?? MAINNET_FACTORY,
    topics: encodeEventTopics({ abi: FACTORY_ABI, eventName: "VaultCreated", args: { owner: options.owner ?? OWNER, vault } }) as Hex[],
    data: encodeAbiParameters(createdEvent.inputs.filter((input) => !input.indexed), [0n, terms(), 0n]),
    blockNumber: `0x${block.toString(16)}`,
    logIndex: `0x${(options.logIndex ?? 0).toString(16)}`,
  });

  interface Filter {
    address: string;
    fromBlock: string;
    toBlock: string;
    topics: (string | null)[];
  }

  /**
   * An endpoint holding `logs`, answering `nonces` with `count` (a figure, or
   * one by block: a number, or "latest") and the latest block with `head`. It
   * filters by block range, emitter and owner topic the way a node does —
   * unless `ignoresFilters`, as a careless one might — and refuses any range
   * wider than `maxSpan`, or one `refuse` rejects. `calls` has the block each
   * `nonces` was asked at.
   */
  function chain(input: {
    count: bigint | ((block: number | "latest") => bigint);
    head?: number | (() => number);
    logs?: Log[];
    maxSpan?: number;
    ignoresFilters?: boolean;
    refuse?: (from: number, to: number) => string | null;
  }) {
    const queries: { from: number; to: number; refused: boolean; filter: Filter }[] = [];
    const methods: string[] = [];
    const calls: (number | "latest")[] = [];
    const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
      methods.push(method);
      if (method === "eth_call") {
        const tag = params[1] as string;
        const block = tag === "latest" ? "latest" : Number(BigInt(tag));
        calls.push(block);
        const count = typeof input.count === "function" ? input.count(block) : input.count;
        return encodeAbiParameters([{ type: "uint256" }], [count]);
      }
      if (method === "eth_blockNumber") {
        const head = typeof input.head === "function" ? input.head() : (input.head ?? 1_000);
        return `0x${head.toString(16)}`;
      }
      if (method !== "eth_getLogs") throw new Error(`the method ${method} does not exist`);
      const filter = params[0] as Filter;
      const from = Number(BigInt(filter.fromBlock));
      const to = Number(BigInt(filter.toBlock));
      const why = to - from + 1 > (input.maxSpan ?? Infinity) ? `block range is too wide (max is ${input.maxSpan})` : (input.refuse?.(from, to) ?? null);
      queries.push({ from, to, refused: why !== null, filter });
      if (why !== null) throw new Error(why);
      return (input.logs ?? []).filter((log) => {
        const block = Number(BigInt(log.blockNumber));
        if (block < from || block > to) return false;
        if (input.ignoresFilters) return true;
        return log.address.toLowerCase() === filter.address.toLowerCase() && log.topics[0] === filter.topics[0] && log.topics[1] === filter.topics[1];
      });
    };
    return { rpc, queries, methods, calls };
  }

  /** How many of OWNER's vaults `logs` hold at or below `block`: the factory's count there. */
  const countIn = (logs: Log[]) => (block: number | "latest") =>
    BigInt(logs.filter((log) => block === "latest" || Number(BigInt(log.blockNumber)) <= block).length);

  it("counts first: an owner who created nothing costs one call and no log query", async () => {
    const endpoint = chain({ count: 0n });
    expect(await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER)).toEqual({ vaults: [], expected: 0n, complete: true });
    expect(endpoint.methods).toEqual(["eth_call"]);
  });

  it("counts again at the block it searches to, so a newer vault never stands in for an older one it didn't reach", async () => {
    // Three vaults; the third made between the first count and the read of the
    // newest block. Counted at "latest" before it existed, two, and the logs
    // up to the newest block name the two newest: "complete", with the oldest
    // missing and nothing said. Counted at the block searched to, three.
    const logs = [created(vaultAt(1), 100), created(vaultAt(2), 900), created(vaultAt(3), 995)];
    const raced = chain({ count: (block) => (block === "latest" ? 2n : countIn(logs)(block)), head: 1_000, logs });
    const found = await findVaultsByOwner(raced.rpc, MAINNET_FACTORY, OWNER, { chunk: 50n });
    expect(found).toMatchObject({ vaults: [vaultAt(3), vaultAt(2), vaultAt(1)], expected: 3n, complete: true });
    expect(raced.calls).toEqual(["latest", 1_000]);

    // A node whose newest block lags the one "latest" was read at: the third
    // vault isn't there yet, so it is neither counted nor looked for, and the
    // two that are, are all of them.
    const lagging = chain({ count: countIn(logs), head: 990, logs });
    expect(await findVaultsByOwner(lagging.rpc, MAINNET_FACTORY, OWNER, { chunk: 50n })).toMatchObject({
      vaults: [vaultAt(2), vaultAt(1)],
      expected: 2n,
      complete: true,
    });
  });

  it("keeps the count when the newest block, or the count there, can't be read: the owner has vaults, and says so", async () => {
    const noHead = chain({ count: 2n });
    const rpc = async (method: string, params: unknown[]) => {
      if (method === "eth_blockNumber") throw new Error("upstream timed out");
      return noHead.rpc(method, params);
    };
    expect(await findVaultsByOwner(rpc, MAINNET_FACTORY, OWNER)).toEqual({
      vaults: [],
      expected: 2n,
      complete: false,
      refusal: "upstream timed out",
    });
    expect(noHead.queries).toEqual([]);

    const noState = chain({ count: 3n });
    const pruned = async (method: string, params: unknown[]) => {
      if (method === "eth_call" && params[1] !== "latest") throw new Error("header not found");
      return noState.rpc(method, params);
    };
    expect(await findVaultsByOwner(pruned, MAINNET_FACTORY, OWNER)).toEqual({
      vaults: [],
      expected: 3n,
      complete: false,
      refusal: "header not found",
    });
  });

  describe("with the vaults the caller already knows", () => {
    const vaultOf = (nonce: bigint, owner: Address = OWNER) => predictVault({ factory: MAINNET_FACTORY, owner, nonce, terms: terms() });
    const known = (nonce: bigint) => ({ vault: vaultOf(nonce), terms: terms() });

    it("reads no log when they are every vault the factory counts", async () => {
      const endpoint = chain({ count: 2n });
      expect(await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER, { known: [known(1n), known(0n)] })).toEqual({
        vaults: [],
        expected: 2n,
        complete: true,
      });
      expect(endpoint.methods).toEqual(["eth_call", "eth_blockNumber", "eth_call"]);
    });

    it("looks only for the rest, and a vault made after the count doesn't stand in for one of them", async () => {
      // Two counted. The caller knows the second (nonce 1) and a third made
      // since (nonce 2), which the count doesn't include: the first is still
      // to find, and is.
      const endpoint = chain({ count: 2n, logs: [created(vaultOf(0n), 100), created(vaultOf(1n), 900)] });
      const found = await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER, { chunk: 50n, known: [known(1n), known(2n)] });
      expect(found).toMatchObject({ vaults: [vaultOf(1n), vaultOf(0n)], expected: 2n, complete: true, searchedFrom: 51n });
      // Were the third counted, the search would have stopped at the second
      // and called itself complete.
      expect(endpoint.queries.length).toBeGreaterThan(1);
    });

    it("counts only what its address proves: this owner's, on the terms given", async () => {
      const endpoint = chain({ count: 1n });
      const elsewhere = { vault: vaultOf(0n, "0x00000000000000000000000000000000000000dd"), terms: terms() };
      const misdescribed = { vault: vaultOf(0n), terms: terms({ maxBuys: 9n }) };
      for (const claim of [elsewhere, misdescribed]) {
        expect(await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER, { known: [claim] })).toMatchObject({
          vaults: [],
          expected: 1n,
          complete: false,
        });
      }
    });
  });

  it("reads the factory's logs for this owner newest first, and stops once it has every vault the factory counts", async () => {
    const logs = [created(vaultAt(1), 900), created(vaultAt(2), 950), created(vaultAt(3), 990)];
    // An older vault it has no reason to reach: all three are found before it.
    const endpoint = chain({ count: 3n, logs: [created(vaultAt(9), 100), ...logs] });
    const found = await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER, { chunk: 50n });
    expect(found).toEqual({ vaults: [vaultAt(3), vaultAt(2), vaultAt(1)], expected: 3n, complete: true, searchedFrom: 851n });
    expect(endpoint.queries.map(({ from, to }) => [from, to])).toEqual([
      [951, 1000],
      [901, 950],
      [851, 900],
    ]);
    // Asked of the factory, for this owner: the owner is the event's first indexed topic.
    const filter = endpoint.queries[0]!.filter;
    expect(filter.address).toBe(MAINNET_FACTORY);
    expect(filter.topics).toEqual(
      encodeEventTopics({ abi: FACTORY_ABI, eventName: "VaultCreated", args: { owner: OWNER } }).slice(0, 2),
    );
  });

  it("lists two vaults created in one block newest first", async () => {
    const endpoint = chain({ count: 2n, logs: [created(vaultAt(1), 990, { logIndex: 3 }), created(vaultAt(2), 990, { logIndex: 7 })] });
    expect((await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER)).vaults).toEqual([vaultAt(2), vaultAt(1)]);
  });

  it("narrows its window each time the endpoint refuses one, and never widens again", async () => {
    const endpoint = chain({ count: 2n, head: 10_000, maxSpan: 500, logs: [created(vaultAt(1), 8_700), created(vaultAt(2), 9_990)] });
    const found = await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER);
    expect(found).toMatchObject({ vaults: [vaultAt(2), vaultAt(1)], complete: true, searchedFrom: 8_501n });
    expect(endpoint.queries.map(({ from, to, refused }) => [to - from + 1, refused])).toEqual([
      [10_001, true], // the first window, 100,000 blocks, clipped at block 0
      [10_000, true],
      [2_000, true],
      [500, false],
      [500, false],
      [500, false],
    ]);
  });

  it("starts from the caller's window, then narrows through the usual ones below it", async () => {
    const endpoint = chain({ count: 1n, maxSpan: 100, logs: [created(vaultAt(1), 950)] });
    await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER, { chunk: 700n });
    expect(endpoint.queries.map(({ from, to }) => to - from + 1)).toEqual([700, 500, 100]);
  });

  it("keeps only the factory's own logs, for this owner, each once, from an endpoint that ignores the filter", async () => {
    const forger: Address = "0x00000000000000000000000000000000000000f0";
    const endpoint = chain({
      count: 2n,
      ignoresFilters: true,
      logs: [
        created(vaultAt(1), 800),
        created(vaultAt(0xf1), 850, { emitter: forger }),
        created(vaultAt(0xc1), 900, { owner: OTHER }),
        created(vaultAt(2), 950),
        created(vaultAt(2), 950, { logIndex: 1 }),
      ],
    });
    const found = await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER);
    expect(found).toMatchObject({ vaults: [vaultAt(2), vaultAt(1)], expected: 2n, complete: true });
  });

  it("says how many it could not reach when its range runs out", async () => {
    const logs = [created(vaultAt(1), 100), created(vaultAt(2), 400), created(vaultAt(3), 990)];
    const endpoint = chain({ count: 3n, logs });
    const found = await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER, { maxRange: 700n, chunk: 300n });
    expect(found).toEqual({ vaults: [vaultAt(3), vaultAt(2)], expected: 3n, complete: false, searchedFrom: 301n });
    expect(Math.min(...endpoint.queries.map((q) => q.from))).toBe(301);
  });

  it("never reads below the oldest block it is given, nor below block 0", async () => {
    const floored = chain({ count: 2n, logs: [created(vaultAt(1), 900), created(vaultAt(2), 990)] });
    expect(await findVaultsByOwner(floored.rpc, MAINNET_FACTORY, OWNER, { oldestBlock: 950n, chunk: 30n })).toEqual({
      vaults: [vaultAt(2)],
      expected: 2n,
      complete: false,
      searchedFrom: 950n,
    });
    expect(floored.queries.map(({ from, to }) => [from, to])).toEqual([
      [971, 1000],
      [950, 970],
    ]);

    const young = chain({ count: 1n, head: 30 });
    expect(await findVaultsByOwner(young.rpc, MAINNET_FACTORY, OWNER)).toEqual({ vaults: [], expected: 1n, complete: false, searchedFrom: 0n });
    expect(young.queries.map(({ from, to }) => [from, to])).toEqual([[0, 30]]);
  });

  it("searches from the block it is given rather than the latest, and counts there: a later vault is not missing then", async () => {
    const logs = [created(vaultAt(1), 400), created(vaultAt(2), 990)];
    const endpoint = chain({ count: countIn(logs), logs });
    const found = await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER, { newestBlock: 500n, maxRange: 501n });
    expect(found).toEqual({ vaults: [vaultAt(1)], expected: 1n, complete: true, searchedFrom: 0n });
    expect(endpoint.methods).not.toContain("eth_blockNumber");
    expect(endpoint.calls).toEqual(["latest", 500]);
  });

  it("stops after its most queries on an endpoint that answers ten blocks at a time, and says it is incomplete", async () => {
    const endpoint = chain({ count: 1n, head: 100_000, maxSpan: 10, logs: [created(vaultAt(1), 50_000)] });
    const found = await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER);
    expect(endpoint.queries).toHaveLength(OWNER_SEARCH_MAX_QUERIES);
    // Five refusals on the way down to ten blocks, then ten blocks a query.
    const answered = OWNER_SEARCH_MAX_QUERIES - 5;
    expect(found).toEqual({ vaults: [], expected: 1n, complete: false, searchedFrom: BigInt(100_000 - 10 * answered + 1) });
  });

  it("reports an endpoint that answers no log query at all, with its words, rather than throwing", async () => {
    const endpoint = chain({ count: 2n, refuse: () => "eth_getLogs is disabled" });
    const found = await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER);
    expect(found).toEqual({ vaults: [], expected: 2n, complete: false, refusal: "eth_getLogs is disabled" });
    // The first window and every narrower one, each refused once.
    expect(endpoint.queries.map((q) => q.to - q.from + 1)).toEqual([1_001, 1_001, 1_001, 500, 100, 10]);
  });

  it("keeps what it found before an endpoint stopped answering", async () => {
    const endpoint = chain({
      count: 2n,
      logs: [created(vaultAt(1), 100), created(vaultAt(2), 900)],
      refuse: (from) => (from < 800 ? "missing trie node (pruned)" : null),
    });
    const found = await findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER, { chunk: 100n });
    expect(found).toEqual({
      vaults: [vaultAt(2)],
      expected: 2n,
      complete: false,
      searchedFrom: 801n,
      refusal: "missing trie node (pruned)",
    });
  });

  it("throws when the factory's first count can't be read: nothing is known", async () => {
    const rpc = async (method: string) => {
      throw new Error(`${method}: connection refused`);
    };
    await expect(findVaultsByOwner(rpc, MAINNET_FACTORY, OWNER)).rejects.toThrow(/connection refused/);
  });

  it("refuses a search with no room to search in", async () => {
    const endpoint = chain({ count: 1n });
    await expect(findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER, { maxRange: 0n })).rejects.toThrow(RangeError);
    await expect(findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER, { chunk: 0n })).rejects.toThrow(RangeError);
    await expect(findVaultsByOwner(endpoint.rpc, MAINNET_FACTORY, OWNER, { maxQueries: 0 })).rejects.toThrow(RangeError);
    expect(endpoint.methods).toEqual([]);
  });
});

describe("checksumAddress", () => {
  it("gives the EIP-55 form of the SPX contract, which strict checks accept", () => {
    const spx = checksumAddress(SPX);
    expect(isAddress(spx, { strict: true })).toBe(true);
    expect(spx).toBe("0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C");
  });
});
