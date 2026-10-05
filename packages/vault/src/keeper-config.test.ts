/**
 * The keeper's environment: every variable parses to the figure it names;
 * a file's contents are trimmed; an empty value is unset; a value and its
 * `_FILE` form together are refused; and no error ever repeats the value it
 * refused, since those values are URLs with API keys in them, and keys.
 */

import { describe, expect, it } from "vitest";
import { addressOfKey } from "@spdex/chain";
import { DEPLOYMENTS, MAINNET_DEPLOYMENT } from "./artifacts.js";
import { KeeperConfigError, keeperAddress, keeperConfig, keeperEnvFrom, rewardToOf } from "./keeper-config.js";
import { DEFAULT_KEEPER_POLICY } from "./keeper-plan.js";

const KEY = `0x${"42".repeat(32)}` as const;
const RPC = "https://eth-mainnet.example.com/v2/abcdefghijklmnopqrstuvwxyz012345";
const SEND = "https://rpc.mevblocker.io/noreverts";

const parse = (env: Record<string, string>, files: Record<string, string> = {}) =>
  keeperEnvFrom(env, {
    readFile: (path) => {
      const contents = files[path];
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
  });

/** The error a parse throws: its variable and message. */
function refusal(env: Record<string, string>, files: Record<string, string> = {}): { variable: string; message: string } {
  try {
    parse(env, files);
  } catch (error) {
    expect(error).toBeInstanceOf(KeeperConfigError);
    return { variable: (error as KeeperConfigError).variable, message: (error as Error).message };
  }
  throw new Error("accepted");
}

describe("keeperEnvFrom", () => {
  it("defaults to a dry run with the stranger's policy", () => {
    const env = parse({});
    expect(env).toMatchObject({ rpcUrl: null, sendUrl: null, sendPrivate: false, keeperKey: null, rewardTo: null, vaults: null, logLevel: "info", deployBatcher: false, prove: false, gasPerVault: 400_000n });
    expect(env.policy).toEqual(DEFAULT_KEEPER_POLICY);
    // A week's warning before the key's ether runs out at its recent spend.
    expect(env.policy.minRunwayDays).toBe(7);
    expect(env.watchdogSeconds).toBe(300);
    expect(env.heartbeatLogSeconds).toBe(300);
  });

  it("parses every variable", () => {
    const env = parse({
      SPDEX_KEEPER_RPC_URL: RPC,
      SPDEX_KEEPER_SEND_URL: SEND,
      SPDEX_KEEPER_KEY: KEY,
      SPDEX_KEEPER_REWARD_TO: "0x00000000000000000000000000000000000000AA",
      SPDEX_KEEPER_VAULTS: "0x00000000000000000000000000000000000000A1, 0x00000000000000000000000000000000000000a2",
      SPDEX_KEEPER_DATA_DIR: "/data",
      SPDEX_KEEPER_LOG_FILE: "-",
      SPDEX_KEEPER_LOG_LEVEL: "debug",
      SPDEX_KEEPER_INTERVAL_SECONDS: "30",
      SPDEX_KEEPER_SEND_WHEN: "deadline",
      SPDEX_KEEPER_DEADLINE_SHARE: "0.1",
      SPDEX_KEEPER_DEADLINE_MIN_SECONDS: "30",
      SPDEX_KEEPER_DEADLINE_MAX_SECONDS: "3600",
      SPDEX_KEEPER_TIP_GWEI: "0.03",
      SPDEX_KEEPER_MAX_FEE_GWEI: "5",
      SPDEX_KEEPER_MAX_LOSS_PER_BUY_ETH: "0.00006",
      SPDEX_KEEPER_MAX_LOSS_PER_DAY_ETH: "0.02",
      SPDEX_KEEPER_MAX_LOSS_PER_VAULT_PER_DAY_ETH: "0.0001",
      SPDEX_KEEPER_MAX_SUBSIDY_PER_OWNER_DAY_ETH: "0.0002",
      SPDEX_KEEPER_SUBSIDY_MIN_BUY_ETH: "0.0005",
      SPDEX_KEEPER_SUBSIDY_MIN_INTERVAL_SECONDS: "7200",
      SPDEX_KEEPER_CONFIRMATIONS: "1",
      SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS: "0",
      SPDEX_KEEPER_MIN_ETH: "0.05",
      SPDEX_KEEPER_HEARTBEAT_FILE: "/tmp/hb.json",
      SPDEX_KEEPER_HEARTBEAT_LOG_SECONDS: "60",
      SPDEX_KEEPER_HEARTBEAT_URL: "https://hc-ping.com/abc",
      SPDEX_KEEPER_DEPLOY_BATCHER: "1",
      SPDEX_KEEPER_PROVE: "1",
      SPDEX_KEEPER_MIN_RUNWAY_DAYS: "10",
      SPDEX_KEEPER_GAS_PER_VAULT: "550000",
      SPDEX_KEEPER_GIT_SHA: "e31a86e",
    });
    expect(env).toMatchObject({
      rpcUrl: RPC,
      sendUrl: SEND,
      sendPrivate: true,
      keeperKey: KEY,
      rewardTo: "0x00000000000000000000000000000000000000aa",
      vaults: ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2"],
      dataDir: "/data",
      logFile: "-",
      logLevel: "debug",
      heartbeatFile: "/tmp/hb.json",
      heartbeatLogSeconds: 60,
      heartbeatUrl: "https://hc-ping.com/abc",
      // Five intervals, at least 300.
      watchdogSeconds: 300,
      deployBatcher: true,
      prove: true,
      gasPerVault: 550_000n,
      gitSha: "e31a86e",
    });
    expect(env.policy).toEqual({
      ...DEFAULT_KEEPER_POLICY,
      sendWhen: "deadline",
      deadlineShareBps: 1_000n,
      deadlineMinSeconds: 30n,
      deadlineMaxSeconds: 3_600n,
      tip: 30_000_000n,
      maxFeePerGas: 5_000_000_000n,
      maxLossPerBuy: 60_000_000_000_000n,
      maxLossPerDay: 20_000_000_000_000_000n,
      maxLossPerVaultPerDay: 100_000_000_000_000n,
      maxSubsidyPerOwnerPerDay: 200_000_000_000_000n,
      subsidyMinBuy: 500_000_000_000_000n,
      subsidyMinInterval: 7_200n,
      confirmations: 1,
      maxHeadLagSeconds: 0n,
      minEth: 50_000_000_000_000_000n,
      minRunwayDays: 10,
      intervalSeconds: 30,
    });
    // Every URL is one the log's redactor removes.
    expect(env.secrets.urls).toEqual(expect.arrayContaining([RPC, SEND, "https://hc-ping.com/abc"]));
    expect(env.secrets.key).toBe(KEY);
    expect(env.unknown).toEqual([]);
  });

  it("lists a keeper variable it does not read, so a mistyped or retired name is not ignored in silence", () => {
    const env = parse(
      { SPDEX_KEEPER_URGENT_MAX_TIP_GWEI: "1", SPDEX_KEEPER_TIP_GWEI: "1", SPDEX_KEEPER_MAX_BATCH_GAS: "9000000", SPDEX_KEEPER_RPC_URL_FILE: "/x", SPDEX_FORK_URL: "http://127.0.0.1:8545" },
      { "/x": RPC },
    );
    expect(env.unknown).toEqual(["SPDEX_KEEPER_MAX_BATCH_GAS", "SPDEX_KEEPER_URGENT_MAX_TIP_GWEI"]);
    // A policy field without a variable keeps its default.
    expect(env.policy.maxBatchGas).toBe(DEFAULT_KEEPER_POLICY.maxBatchGas);
  });

  it("refuses private sending with no private endpoint to send through", () => {
    expect(refusal({ SPDEX_KEEPER_SEND_PRIVATE: "1" }).variable).toBe("SPDEX_KEEPER_SEND_PRIVATE");
    expect(parse({ SPDEX_KEEPER_SEND_URL: SEND, SPDEX_KEEPER_SEND_PRIVATE: "0" }).sendPrivate).toBe(false);
    expect(parse({ SPDEX_KEEPER_SEND_URL: SEND }).sendPrivate).toBe(true);
  });

  it("reads _FILE forms, trimmed, with or without 0x", () => {
    const env = parse(
      { SPDEX_KEEPER_KEY_FILE: "/run/secrets/keeper_key", SPDEX_KEEPER_RPC_URL_FILE: "/run/secrets/rpc_url", SPDEX_KEEPER_SEND_URL_FILE: "/run/secrets/send_url" },
      // openssl rand -hex 32 writes no 0x and a newline; an empty send_url file means none.
      { "/run/secrets/keeper_key": `${KEY.slice(2)}\n`, "/run/secrets/rpc_url": `  ${RPC}\n`, "/run/secrets/send_url": "\n" },
    );
    expect(env.keeperKey).toBe(KEY);
    expect(env.keyFile).toBe("/run/secrets/keeper_key");
    expect(env.rpcUrl).toBe(RPC);
    expect(env.sendUrl).toBeNull();
    expect(env.sendPrivate).toBe(false);
  });

  it("counts an empty value as unset", () => {
    const env = parse({ SPDEX_KEEPER_SEND_URL: "", SPDEX_KEEPER_KEY: "  ", SPDEX_KEEPER_TIP_GWEI: "", SPDEX_KEEPER_VAULTS: "" });
    expect(env).toMatchObject({ sendUrl: null, keeperKey: null, vaults: null });
    expect(env.policy.tip).toBe(DEFAULT_KEEPER_POLICY.tip);
  });

  it("refuses a value and its _FILE form together", () => {
    expect(refusal({ SPDEX_KEEPER_RPC_URL: RPC, SPDEX_KEEPER_RPC_URL_FILE: "/x" }).variable).toBe("SPDEX_KEEPER_RPC_URL");
    expect(refusal({ SPDEX_KEEPER_KEY: KEY, SPDEX_KEEPER_KEY_FILE: "/x" }, { "/x": KEY }).variable).toBe("SPDEX_KEEPER_KEY");
  });

  it("names the variable in every refusal, and never its value", () => {
    const cases: [Record<string, string>, string, string][] = [
      [{ SPDEX_KEEPER_RPC_URL: "not a url /v2/abcdefghijklmnopqrstuvwxyz" }, "SPDEX_KEEPER_RPC_URL", "abcdefghijklmnopqrstuvwxyz"],
      [{ SPDEX_KEEPER_SEND_URL: "ftp://secret-host.example/abcdefghijklmnop" }, "SPDEX_KEEPER_SEND_URL", "secret-host"],
      [{ SPDEX_KEEPER_KEY: `0x${"zz".repeat(32)}` }, "SPDEX_KEEPER_KEY", "zz".repeat(32)],
      [{ SPDEX_KEEPER_KEY: KEY.slice(0, 40) }, "SPDEX_KEEPER_KEY", KEY.slice(2, 40)],
      [{ SPDEX_KEEPER_KEY_FILE: "/missing" }, "SPDEX_KEEPER_KEY_FILE", "/missing"],
      [{ SPDEX_KEEPER_TIP_GWEI: "-1" }, "SPDEX_KEEPER_TIP_GWEI", "-1"],
      [{ SPDEX_KEEPER_TIP_GWEI: "0.0000000001" }, "SPDEX_KEEPER_TIP_GWEI", "0.0000000001"],
      [{ SPDEX_KEEPER_SEND_WHEN: "sometimes" }, "SPDEX_KEEPER_SEND_WHEN", "sometimes"],
      [{ SPDEX_KEEPER_REWARD_TO: "0x1234" }, "SPDEX_KEEPER_REWARD_TO", "0x1234"],
      [{ SPDEX_KEEPER_VAULTS: "0xabc,nope" }, "SPDEX_KEEPER_VAULTS", "nope"],
      [{ SPDEX_KEEPER_DEPLOY_BATCHER: "yes" }, "SPDEX_KEEPER_DEPLOY_BATCHER", "yes"],
      [{ SPDEX_KEEPER_CONFIRMATIONS: "0" }, "SPDEX_KEEPER_CONFIRMATIONS", "must be"],
      [{ SPDEX_KEEPER_DEADLINE_SHARE: "1.5" }, "SPDEX_KEEPER_DEADLINE_SHARE", "1.5"],
      [{ SPDEX_KEEPER_INTERVAL_SECONDS: "5" }, "SPDEX_KEEPER_INTERVAL_SECONDS", "5"],
      [{ SPDEX_KEEPER_PROVE: "yes" }, "SPDEX_KEEPER_PROVE", "yes"],
      [{ SPDEX_KEEPER_MIN_RUNWAY_DAYS: "-1" }, "SPDEX_KEEPER_MIN_RUNWAY_DAYS", "-1"],
      [{ SPDEX_KEEPER_MIN_RUNWAY_DAYS: "3.5" }, "SPDEX_KEEPER_MIN_RUNWAY_DAYS", "3.5"],
      // The batcher's own bounds on each vault's gas: below the least an honest buy needs, or above its sanity bound.
      [{ SPDEX_KEEPER_GAS_PER_VAULT: "399999" }, "SPDEX_KEEPER_GAS_PER_VAULT", "399999"],
      [{ SPDEX_KEEPER_GAS_PER_VAULT: "10000001" }, "SPDEX_KEEPER_GAS_PER_VAULT", "10000001"],
      [{ SPDEX_KEEPER_GAS_PER_VAULT: "4e5" }, "SPDEX_KEEPER_GAS_PER_VAULT", "4e5"],
    ];
    for (const [env, variable, value] of cases) {
      const { variable: named, message } = refusal(env);
      expect(named).toBe(variable);
      expect(message).toContain(variable);
      if (value !== "must be") expect(message).not.toContain(value);
    }
  });

  it("turns the runway warning off with 0 days, and proving on only with 1", () => {
    expect(parse({ SPDEX_KEEPER_MIN_RUNWAY_DAYS: "0" }).policy.minRunwayDays).toBe(0);
    expect(parse({ SPDEX_KEEPER_PROVE: "0" }).prove).toBe(false);
    expect(parse({ SPDEX_KEEPER_PROVE: "true" }).prove).toBe(true);
    // Both are settings this keeper reads, never "unknown".
    expect(parse({ SPDEX_KEEPER_PROVE: "1", SPDEX_KEEPER_MIN_RUNWAY_DAYS: "3" }).unknown).toEqual([]);
  });

  it("counts every *_URL in the environment as a secret, the fork's included", () => {
    const env = parse({ SPDEX_FORK_RPC_URL: "https://archive.example/v2/SECRETSECRETSECRET", SPDEX_KEEPER_RPC_URL: "http://127.0.0.1:8545" });
    expect(env.secrets.urls).toEqual(expect.arrayContaining(["https://archive.example/v2/SECRETSECRETSECRET", "http://127.0.0.1:8545"]));
  });
});

describe("keeperConfig", () => {
  it("fills in the registry, mainnet's WETH, no allowlist, a public send, no proving and the default policy", () => {
    const config = keeperConfig({ chainId: 690069 });
    expect(config).toEqual({
      chainId: 690069,
      deployments: DEPLOYMENTS,
      weth: MAINNET_DEPLOYMENT.weth,
      rewardTo: null,
      vaults: null,
      privateSend: false,
      prove: false,
      gasPerVault: 400_000n,
      policy: DEFAULT_KEEPER_POLICY,
    });
    // Both releases, each batch to its own batcher; v2's with its SPX holder registry.
    expect(config.deployments.map((d) => [d.id, d.registry === null])).toEqual([
      ["v1", true],
      ["v2", false],
    ]);
    expect(keeperAddress(config)).toBeNull();
    expect(rewardToOf(config)).toBeNull();
  });

  it("sends rewards to the keeper unless told otherwise, and lowercases addresses", () => {
    const keeper = addressOfKey(KEY);
    expect(rewardToOf(keeperConfig({ chainId: 1, keeperKey: KEY }))).toBe(keeper);
    const config = keeperConfig({ chainId: 1, keeperKey: KEY, rewardTo: "0x00000000000000000000000000000000000000AA", vaults: ["0x00000000000000000000000000000000000000A1"] });
    expect(rewardToOf(config)).toBe("0x00000000000000000000000000000000000000aa");
    expect(config.vaults).toEqual(["0x00000000000000000000000000000000000000a1"]);
  });

  it("refuses a policy outside the batcher's limits, and a batch gas limit above 16,000,000", () => {
    expect(() => keeperConfig({ chainId: 1, policy: { maxBatchGas: 16_000_001n } })).toThrow(KeeperConfigError);
    expect(keeperConfig({ chainId: 1, policy: { maxBatchGas: 16_000_000n } }).policy.maxBatchGas).toBe(16_000_000n);
    expect(() => keeperConfig({ chainId: 1, policy: { maxVaultsPerBatch: 151 } })).toThrow(KeeperConfigError);
    expect(() => keeperConfig({ chainId: 1, policy: { confirmations: 0 } })).toThrow(KeeperConfigError);
    expect(() => keeperConfig({ chainId: 1, policy: { minRunwayDays: -1 } })).toThrow(KeeperConfigError);
    expect(() => keeperConfig({ chainId: 1, policy: { minRunwayDays: Number.NaN } })).toThrow(KeeperConfigError);
  });
});
