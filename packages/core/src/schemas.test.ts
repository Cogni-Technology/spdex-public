import { describe, expect, it } from "vitest";
import { AddressSchema, BigIntSchema, isAddressEqual } from "./primitives.js";
import { SwapIntentSchema, TxPlanSchema } from "./intent.js";
import { ModuleManifestSchema, isImplementedKind } from "./manifest.js";
import { SpdexConfigSchema } from "./config.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const SPX = "0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

describe("AddressSchema", () => {
  it("normalises checksummed addresses to lowercase", () => {
    // Every Guard check is an equality comparison. A checksummed address
    // comparing unequal to its lowercase twin would silently disable a safety
    // check, so normalisation happens once, at the schema boundary.
    expect(AddressSchema.parse(WETH)).toBe(WETH.toLowerCase());
  });

  it("makes checksummed and lowercase forms compare equal after parsing", () => {
    const a = AddressSchema.parse(WETH);
    const b = AddressSchema.parse(WETH.toLowerCase());
    expect(a).toBe(b);
    expect(isAddressEqual(a, b)).toBe(true);
  });

  it("rejects wrong-length and non-hex addresses", () => {
    expect(() => AddressSchema.parse("0x1234")).toThrow();
    expect(() => AddressSchema.parse(`0x${"z".repeat(40)}`)).toThrow();
    expect(() => AddressSchema.parse(WETH.slice(2))).toThrow();
  });
});

describe("BigIntSchema", () => {
  it("accepts bigint, decimal string and safe integer alike", () => {
    expect(BigIntSchema.parse(5n)).toBe(5n);
    expect(BigIntSchema.parse("5")).toBe(5n);
    expect(BigIntSchema.parse(5)).toBe(5n);
  });

  it("preserves values beyond Number.MAX_SAFE_INTEGER", () => {
    const big = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    expect(BigIntSchema.parse(big).toString()).toBe(big);
  });

  it("rejects floats and non-numeric strings", () => {
    expect(() => BigIntSchema.parse(1.5)).toThrow();
    expect(() => BigIntSchema.parse("1.5")).toThrow();
    expect(() => BigIntSchema.parse("abc")).toThrow();
  });
});

const intent = {
  version: 1 as const,
  chainId: 1,
  account: ACCOUNT,
  recipient: ACCOUNT,
  tokenIn: SPX,
  tokenOut: WETH,
  maxAmountIn: "1000000000000000000",
  minAmountOut: "990000000000000",
  deadline: "1790000000",
  nonce: "0xdeadbeef",
};

describe("SwapIntentSchema", () => {
  it("parses a well-formed intent and coerces amounts to bigint", () => {
    const parsed = SwapIntentSchema.parse(intent);
    expect(parsed.maxAmountIn).toBe(1000000000000000000n);
    expect(parsed.tokenOut).toBe(WETH.toLowerCase());
  });

  it("rejects an intent missing its bounds", () => {
    const { minAmountOut: _omitted, ...withoutMinOut } = intent;
    expect(() => SwapIntentSchema.parse(withoutMinOut)).toThrow();
  });
});

describe("TxPlanSchema", () => {
  it("parses a plan with approvals and calls", () => {
    const plan = TxPlanSchema.parse({
      version: 1,
      intent,
      approvals: [{ token: SPX, spender: WETH, amount: "1000000000000000000" }],
      calls: [{ to: WETH, data: "0xabcdef", value: "0" }],
      meta: { venueId: "venue-uniswap-v3", poolIds: ["0xpool"], quotedAmountOut: "1", gasEstimate: "150000" },
    });
    expect(plan.calls[0]?.to).toBe(WETH.toLowerCase());
    expect(plan.approvals[0]?.amount).toBe(1000000000000000000n);
  });
});

describe("ModuleManifestSchema", () => {
  const manifest = {
    id: "venue-uniswap-v3",
    version: "1.0.0",
    apiVersion: "1.0.0",
    kind: "venue",
    displayName: "Uniswap v3",
    description: "Routes through Uniswap v3 pools.",
    capabilities: ["chain:read"],
    contracts: [WETH, SPX],
    limits: { maxFuel: "1000000", maxMemory: "16777216", maxCallsPerQuote: 64 },
    sha256: "a".repeat(64),
    publicKey: "0xabcd",
    signature: "0x1234",
  };

  it("parses a valid manifest and lowercases its contract allowlist", () => {
    const parsed = ModuleManifestSchema.parse(manifest);
    expect(parsed.contracts).toContain(WETH.toLowerCase());
  });

  it("rejects an unknown capability", () => {
    // Capabilities are additive-only and closed: a module cannot invent one to
    // request reach the host never agreed to grant.
    expect(() =>
      ModuleManifestSchema.parse({ ...manifest, capabilities: ["signer:sign"] }),
    ).toThrow();
  });

  it("rejects a malformed id or non-semver version", () => {
    expect(() => ModuleManifestSchema.parse({ ...manifest, id: "Venue_V3" })).toThrow();
    expect(() => ModuleManifestSchema.parse({ ...manifest, version: "v1" })).toThrow();
  });

  it("accepts reserved kinds as valid but marks them unimplemented", () => {
    // Declared-but-unimplemented kinds are how new module types land later
    // without widening the contract for existing modules — which is exactly
    // how `tracker` and `scheduler` arrived.
    const policy = ModuleManifestSchema.parse({ ...manifest, kind: "policy" });
    expect(policy.kind).toBe("policy");
    expect(isImplementedKind(policy.kind)).toBe(false);
    expect(isImplementedKind("venue")).toBe(true);
  });

  it("admits every kind that ships a module", () => {
    // `tracker` shipped before it was listed here. Nothing enforced the list
    // then; the host's load seam does now, and a missing entry would make pool
    // statistics vanish rather than fail loudly.
    for (const kind of ["venue", "tiplist", "tracker", "scheduler"] as const) {
      expect(isImplementedKind(kind)).toBe(true);
    }
  });
});

describe("SpdexConfigSchema", () => {
  const config = {
    schemaVersion: 9,
    preset: "recommended",
    chainId: 1,
    rpc: { url: "https://example.invalid/rpc", source: "user" },
    slippageBps: 50,
    deadlineSeconds: 600,
    strictSandbox: false,
    modules: [{ id: "venue-uniswap-v3", version: "1.0.0", source: "builtin", enabled: true }],
    submitter: { mode: "wallet", url: null },
    pools: { mode: "recommended", allow: [], deny: [] },
    router: { chunkCount: 10, maxSplits: 4, minSplitGainBps: 5 },
    guard: { requireSimulation: false, oracleDivergenceBps: 200, secondOpinion: { url: null } },
    tips: { enabled: false, recipients: [] },
    dca: { enabled: false, plans: [] },
    extraTrustedContracts: [],
  };

  it("parses a recommended-preset config", () => {
    expect(SpdexConfigSchema.parse(config).preset).toBe("recommended");
  });

  it("carries a schemaVersion so exported configs stay openable", () => {
    expect(() => SpdexConfigSchema.parse({ ...config, schemaVersion: 99 })).toThrow();
  });

  it("supports pinning to a single pool via allowlist mode", () => {
    const pinned = SpdexConfigSchema.parse({
      ...config,
      preset: "custom",
      pools: {
        mode: "allowlist",
        allow: [{ venueId: "venue-uniswap-v3", poolId: "0xpool", label: "SPX/WETH 1%" }],
        deny: [],
      },
    });
    expect(pinned.pools.mode).toBe("allowlist");
    expect(pinned.pools.allow).toHaveLength(1);
  });

  it("rejects out-of-range slippage", () => {
    expect(() => SpdexConfigSchema.parse({ ...config, slippageBps: 0 })).toThrow();
    expect(() => SpdexConfigSchema.parse({ ...config, slippageBps: 10_000 })).toThrow();
  });

  it("holds a second opinion's url, absent and null both meaning none", () => {
    const withUrl = { ...config, guard: { ...config.guard, secondOpinion: { url: "https://second.invalid/rpc" } } };
    expect(SpdexConfigSchema.parse(withUrl).guard.secondOpinion.url).toBe("https://second.invalid/rpc");
    const omitted = { ...config, guard: { ...config.guard, secondOpinion: {} } };
    expect(SpdexConfigSchema.parse(omitted).guard.secondOpinion.url).toBeNull();
    expect(() =>
      SpdexConfigSchema.parse({ ...config, guard: { ...config.guard, secondOpinion: { url: "second opinion" } } }),
    ).toThrow();
  });

  it("refuses a v9 config without the second-opinion setting, rather than guessing one", () => {
    const { secondOpinion: _, ...guard } = config.guard;
    expect(() => SpdexConfigSchema.parse({ ...config, guard })).toThrow();
  });
});
