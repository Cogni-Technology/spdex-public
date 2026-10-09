import { describe, expect, it } from "vitest";
import type { Hex } from "@spdex/core";
import {
  FinalizedHead,
  finalityText,
  FINALIZED_POLL_MS,
  GIVE_UP_MS,
  knownFinality,
  minutesToFinal,
  RECEIPT_POLL_MS,
  watchFinality,
  type FinalityView,
  type WatchEnv,
} from "./finality.js";

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
let nextHash = 1;

/** A clock that moves only when the watcher sleeps. */
function fakeEnv(): WatchEnv & { time: number } {
  const env = {
    time: 0,
    now: () => env.time,
    sleep: async (ms: number) => {
      env.time += ms;
    },
    whenVisible: async () => undefined,
  };
  return env;
}

interface Script {
  /** The block the receipt names at each read, in turn (the last repeats); null for "not mined". */
  receipt: (bigint | null)[];
  /** The finalized block at each read, in turn (the last repeats), or an error to throw. */
  finalized: (bigint | Error | null)[];
  /** The hash each block has, by number; a block's receipt hash is `hash(1000 + block)` unless replaced here. */
  blockHashes?: Record<string, Hex>;
}

function scripted(script: Script) {
  const reads = { receipt: 0, finalized: 0, block: 0 };
  const rpc = async (method: string, params: unknown[]) => {
    if (method === "eth_getTransactionReceipt") {
      const block = script.receipt[Math.min(reads.receipt++, script.receipt.length - 1)];
      if (block === null || block === undefined) return null;
      return { from: `0x${"11".repeat(20)}`, status: "0x1", blockNumber: hex(block), blockHash: hash(1000 + Number(block)), logs: [] };
    }
    if (method === "eth_getBlockByNumber" && params[0] === "finalized") {
      const answer = script.finalized[Math.min(reads.finalized++, script.finalized.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer === null || answer === undefined ? null : { number: hex(answer) };
    }
    if (method === "eth_getBlockByNumber") {
      reads.block += 1;
      const n = Number(BigInt(params[0] as string));
      return { hash: script.blockHashes?.[String(n)] ?? hash(1000 + n) };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, reads };
}

async function watch(script: Script): Promise<{ views: FinalityView[]; reads: { receipt: number; finalized: number; block: number }; env: ReturnType<typeof fakeEnv> }> {
  const { rpc, reads } = scripted(script);
  const env = fakeEnv();
  const views: FinalityView[] = [];
  const head = new FinalizedHead(rpc, env.now);
  await new Promise<void>((resolve) => {
    watchFinality(rpc, hash(nextHash++), (view) => {
      views.push(view);
      if (["final", "unknown", "gave-up"].includes(view.state)) resolve();
    }, { env, head });
  });
  return { views, reads, env };
}

describe("the state machine", () => {
  it("goes sent → included → final, checking the block's hash once", async () => {
    const { views, reads } = await watch({ receipt: [null, 100n], finalized: [60n, 90n, 100n] });
    expect(views.map((v) => v.state)).toEqual(["sent", "included", "included", "included", "final"]);
    expect(views[2]).toEqual({ state: "included", block: 100n, finalized: 60n });
    expect(views.at(-1)).toEqual({ state: "final", block: 100n });
    expect(reads.block).toBe(1);
  });

  it("says finality is unknown when the service doesn't report a finalized block", async () => {
    const refused = Object.assign(new Error("eth_getBlockByNumber: invalid block tag"), { code: -32602 });
    expect((await watch({ receipt: [5n], finalized: [refused] })).views.at(-1)).toEqual({ state: "unknown", block: 5n });
    expect((await watch({ receipt: [5n], finalized: [null] })).views.at(-1)).toEqual({ state: "unknown", block: 5n });
  });

  it("rides out failed reads and rate limits, however many, without calling finality unknown", async () => {
    const limited = Object.assign(new Error("rate limited"), { code: -32005 });
    const { views } = await watch({ receipt: [5n], finalized: [new Error("fetch failed"), limited, 5n] });
    expect(views.at(-1)).toEqual({ state: "final", block: 5n });
    // A network that stays down (no answer, so no code) is not the service
    // saying it has no finalized blocks: the badge waits, and gives up in time.
    const down = await watch({ receipt: [5n], finalized: [new Error("fetch failed")] });
    expect(down.views.map((v) => v.state)).not.toContain("unknown");
    expect(down.views.at(-1)).toEqual({ state: "gave-up", stage: "included", block: 5n });
    const throttled = await watch({ receipt: [5n], finalized: [limited] });
    expect(throttled.views.at(-1)).toEqual({ state: "gave-up", stage: "included", block: 5n });
  });

  it("keeps finality on for the session after a network drop", async () => {
    let fail = true;
    const rpc = async (method: string, params: unknown[]) => {
      if (method !== "eth_getBlockByNumber" || params[0] !== "finalized") throw new Error(`unexpected ${method}`);
      if (fail) throw new Error("fetch failed");
      return { number: "0x7" };
    };
    let time = 0;
    const head = new FinalizedHead(rpc, () => time);
    for (let i = 0; i < 5; i++) {
      expect(await head.get()).toBeNull();
      time += FINALIZED_POLL_MS;
    }
    fail = false;
    expect(await head.get()).toBe(7n);
  });

  it("notices a replaced block, and follows the transaction to where it landed", async () => {
    const { views } = await watch({
      receipt: [100n, 101n],
      finalized: [100n, 101n],
      blockHashes: { "100": hash(77) },
    });
    expect(views.map((v) => v.state)).toEqual(["sent", "included", "replaced", "included", "included", "final"]);
    expect(views[3]).toEqual({ state: "included", block: 101n, finalized: null });
    expect(views.at(-1)).toEqual({ state: "final", block: 101n });
  });

  it("gives up after 45 minutes without inclusion", async () => {
    const { views, env } = await watch({ receipt: [null], finalized: [1n] });
    expect(views.map((v) => v.state)).toEqual(["sent", "gave-up"]);
    expect(views.at(-1)).toEqual({ state: "gave-up", stage: "sent", block: null });
    expect(env.time).toBeGreaterThanOrEqual(GIVE_UP_MS);
    expect(env.time).toBeLessThan(GIVE_UP_MS + RECEIPT_POLL_MS);
  });

  it("gives up after 45 minutes without finality", async () => {
    const { views } = await watch({ receipt: [9n], finalized: [1n] });
    expect(views.at(-1)).toEqual({ state: "gave-up", stage: "included", block: 9n });
  });

  it("remembers a final transaction for the session, so a badge shown again reads nothing", async () => {
    const { rpc, reads } = scripted({ receipt: [3n], finalized: [3n] });
    const env = fakeEnv();
    const target = hash(999_999);
    await new Promise<void>((resolve) =>
      watchFinality(rpc, target, (v) => v.state === "final" && resolve(), { env, head: new FinalizedHead(rpc, env.now) }),
    );
    const before = { ...reads };
    const again: FinalityView[] = [];
    watchFinality(rpc, target, (v) => again.push(v), { env });
    expect(again).toEqual([{ state: "final", block: 3n }]);
    expect(reads).toEqual(before);
    expect(knownFinality(target.toUpperCase().replace("0X", "0x"))).toEqual({ state: "final", block: 3n });
  });
});

describe("one finalized read for the page", () => {
  it("answers every badge from one read every 30 seconds", async () => {
    let reads = 0;
    let time = 0;
    const head = new FinalizedHead(async () => {
      reads += 1;
      return { number: "0x10" };
    }, () => time);
    await Promise.all([head.get(), head.get(), head.get()]);
    expect(reads).toBe(1);
    time += FINALIZED_POLL_MS - 1;
    expect(await head.get()).toBe(16n);
    expect(reads).toBe(1);
    time += 1;
    await head.get();
    expect(reads).toBe(2);
  });
});

describe("the words", () => {
  it("say each state plainly, and credit the service", () => {
    expect(finalityText({ state: "sent" })).toBe("Sent: waiting to be included");
    expect(finalityText({ state: "included", block: 26_001_249n, finalized: null })).toBe("Included in block 26,001,249 · final in about 15 min");
    expect(finalityText({ state: "final", block: 1n })).toBe("Final ✓: your network service reports this block as finalized");
    expect(finalityText({ state: "unknown", block: 1n })).toBe("Finality unknown: your network service doesn't report finalized blocks.");
    expect(finalityText({ state: "replaced" })).toBe("The block it was in was replaced; checking where it landed…");
    expect(finalityText({ state: "gave-up", stage: "sent", block: null })).toContain("the relay may have dropped it, and then nothing was spent");
    expect(finalityText({ state: "gave-up", stage: "included", block: 1n })).toBe("Not reported final after 45 minutes. Look it up on an explorer.");
  });

  it("estimates from how far finality is behind, a checkpoint at a time", () => {
    expect(minutesToFinal(100n, 36n)).toBe(13);
    expect(minutesToFinal(100n, 20n)).toBe(19);
    expect(minutesToFinal(100n, 99n)).toBe(6);
    expect(minutesToFinal(100n, 100n)).toBe(1);
    expect(minutesToFinal(100n, null)).toBe(15);
    expect(finalityText({ state: "included", block: 26_001_249n, finalized: 10n })).toBe("Included in block 26,001,249 · not final yet");
  });
});
