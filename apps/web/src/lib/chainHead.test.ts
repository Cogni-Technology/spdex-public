import { describe, expect, it } from "vitest";
import { blockText, ChainHead, finalText, RETRY_MS, SLOW_MS, type HeadEnv, type HeadView } from "./chainHead.js";

/** A clock that moves only when a read takes time or the head waits to retry. */
function fakeEnv(options: { online?: boolean } = {}) {
  const env = {
    time: 0,
    wall: Date.UTC(2026, 9, 1, 14, 2),
    isOnline: options.online ?? true,
    slept: [] as number[],
    now: () => env.time,
    wallClock: () => env.wall,
    sleep: async (ms: number) => {
      env.slept.push(ms);
      env.time += ms;
    },
    online: () => env.isOnline,
  };
  return env satisfies HeadEnv;
}

/** An rpc that answers each call from `answers` in turn (the last repeats), taking `took` ms of the fake clock. */
function scripted(env: ReturnType<typeof fakeEnv>, answers: (string | Error)[], took = 50) {
  const calls: string[] = [];
  const rpc = async (method: string) => {
    calls.push(method);
    env.time += took;
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { rpc, calls };
}

describe("the chain head", () => {
  it("reads nothing before a service is chosen", async () => {
    const head = new ChainHead(null, fakeEnv());
    await head.read();
    expect(head.view()).toEqual({ state: "none", block: null, readAt: null, reading: false });
  });

  it("reads the block once, and says when", async () => {
    const env = fakeEnv();
    const { rpc, calls } = scripted(env, ["0x18cba80"]);
    const head = new ChainHead(rpc, env);
    const seen: HeadView[] = [];
    head.subscribe(() => seen.push(head.view()));
    await head.read();
    expect(calls).toEqual(["eth_blockNumber"]);
    expect(head.view()).toEqual({ state: "online", block: 0x18cba80n, readAt: env.wall, reading: false });
    expect(seen[0]?.reading).toBe(true);
  });

  it("shares a read in flight rather than asking twice", async () => {
    const env = fakeEnv();
    const { rpc, calls } = scripted(env, ["0x10"]);
    const head = new ChainHead(rpc, env);
    await Promise.all([head.read(), head.read()]);
    expect(calls).toHaveLength(1);
  });

  it("is SLOW when the read took 3 seconds or more", async () => {
    const env = fakeEnv();
    const head = new ChainHead(scripted(env, ["0x10"], SLOW_MS).rpc, env);
    await head.read();
    expect(head.view().state).toBe("slow");
  });

  it("tries a failed read once more after 5 seconds, and is OFFLINE after two", async () => {
    const env = fakeEnv();
    const { rpc, calls } = scripted(env, [new Error("fetch failed"), "0x20"]);
    const head = new ChainHead(rpc, env);
    await head.read();
    expect(env.slept).toEqual([RETRY_MS]);
    expect(calls).toHaveLength(2);
    expect(head.view()).toMatchObject({ state: "online", block: 0x20n });

    const env2 = fakeEnv();
    const down = scripted(env2, [new Error("fetch failed")]);
    const head2 = new ChainHead(down.rpc, env2);
    await head2.read();
    expect(down.calls).toHaveLength(2);
    // A block that couldn't be read is unknown, never 0.
    expect(head2.view()).toEqual({ state: "offline", block: null, readAt: null, reading: false });
    expect(blockText(head2.view())).toBe("unknown");
  });

  it("is BUSY on a rate limit, without a retry", async () => {
    for (const code of [429, -32005]) {
      const env = fakeEnv();
      const { rpc, calls } = scripted(env, [Object.assign(new Error("limited"), { code })]);
      const head = new ChainHead(rpc, env);
      await head.read();
      expect(calls).toHaveLength(1);
      expect(head.view().state).toBe("busy");
    }
  });

  it("is OFFLINE at once, with no request, when the browser says it is offline", async () => {
    const env = fakeEnv({ online: false });
    const { rpc, calls } = scripted(env, ["0x10"]);
    const head = new ChainHead(rpc, env);
    await head.read();
    expect(calls).toEqual([]);
    expect(head.view().state).toBe("offline");
  });

  it("drops a cancelled read and never sends its retry", async () => {
    const env = fakeEnv();
    const { rpc, calls } = scripted(env, [new Error("fetch failed"), "0x30"]);
    const head = new ChainHead(rpc, env);
    const reading = head.read();
    head.cancel();
    await reading;
    expect(calls).toHaveLength(1);
    expect(head.view()).toMatchObject({ block: null, reading: false });
  });
});

describe("the widget's words", () => {
  it("writes the block with the time it was read, or says it is reading or unknown", () => {
    const readAt = new Date(2026, 9, 1, 14, 2).getTime();
    expect(blockText({ state: "online", block: 26_000_359n, readAt, reading: false }, "en-GB")).toBe("#26,000,359 · 14:02");
    // A day period stays with its time: the row can only break at " · ".
    expect(blockText({ state: "online", block: 26_000_359n, readAt, reading: false }, "en-US")).toMatch(/^#26,000,359 · \d\d:\d\d\u00a0[AP]M$/);
    expect(blockText({ state: "reading", block: null, readAt: null, reading: true })).toBe("…");
    expect(blockText({ state: "busy", block: null, readAt: null, reading: false })).toBe("unknown");
  });

  it("writes how far finality trails the head, and unknown for anything it doesn't know", () => {
    expect(finalText(1_064n, 1_000n)).toBe("−64 blk · ~13 min");
    expect(finalText(1_000n, "unsupported")).toBe("unknown");
    expect(finalText(null, 1_000n)).toBe("unknown");
    expect(finalText(1_000n, null)).toBe("unknown");
    expect(finalText(1_000n, "reading")).toBe("…");
  });
});
