/**
 * The safety-test probe: "the endpoint cannot" is only what the endpoint
 * answered as "no such method"; everything else is "unknown", and the
 * scheduled path's provider never remembers an unknown as a no.
 */

import { describe, expect, it, vi } from "vitest";
import { SimulationUnavailableError, type SecondOpinion, type SimulationOutcome, type SimulationProvider } from "@spdex/chain";
import {
  DefiniteSimulationProvider,
  ObservedSimulationProvider,
  RpcTimeout,
  SecondOpinionMonitor,
  normalizeServiceUrl,
  sameOperatorWarning,
  sameService,
  sharedOperator,
  withTimeout,
} from "./simulation.js";

/** How `httpRpc` throws an answered error: `${method}: ${message}`, with the JSON-RPC code attached. */
const answered = (message: string, code?: number) =>
  Object.assign(new Error(`eth_simulateV1: ${message}`), code === undefined ? {} : { code });

describe("DefiniteSimulationProvider", () => {
  it("asks again after a failure that said nothing, and remembers only a definite answer", async () => {
    let probes = 0;
    let answer: () => unknown = () => {
      throw new TypeError("fetch failed");
    };
    const provider = new DefiniteSimulationProvider(async (method) => {
      if (method !== "eth_simulateV1") throw new Error(`unexpected ${method}`);
      probes += 1;
      return answer();
    });
    // The connection dropped at the first probe: this check is unverified…
    expect(await provider.isAvailable()).toBe(false);
    await expect(provider.simulate({ chainId: 1, account: "0x1111111111111111111111111111111111111111", calls: [] })).rejects.toBeInstanceOf(
      SimulationUnavailableError,
    );
    // …and the next one asks again, rather than remembering "cannot".
    answer = () => [{ calls: [] }];
    expect(await provider.isAvailable()).toBe(true);
    const asked = probes;
    expect(await provider.isAvailable()).toBe(true);
    expect(probes).toBe(asked);
  });

  it("remembers an endpoint that answered it has no such method", async () => {
    let probes = 0;
    const provider = new DefiniteSimulationProvider(async () => {
      probes += 1;
      throw answered("Method not found", -32601);
    });
    expect(await provider.isAvailable()).toBe(false);
    expect(await provider.isAvailable()).toBe(false);
    expect(probes).toBe(1);
  });
});

describe("the same service twice", () => {
  it("lowercases the scheme and host, drops a default port and a trailing slash, and keeps the path as typed", () => {
    expect(normalizeServiceUrl("HTTPS://Eth.Example.COM:443/v2/KeY/")).toBe("https://eth.example.com/v2/KeY");
    expect(normalizeServiceUrl("http://127.0.0.1:80")).toBe("http://127.0.0.1");
    expect(normalizeServiceUrl("http://127.0.0.1:8545/")).toBe("http://127.0.0.1:8545");
    expect(normalizeServiceUrl("ws://eth.example")).toBeNull();
    expect(normalizeServiceUrl("not a url")).toBeNull();
  });

  it("is the same service only when both normalise alike", () => {
    expect(sameService("https://eth.example/v2/abc", "https://ETH.example:443/v2/abc/")).toBe(true);
    // A key is case-sensitive: another key is another account, if not another operator.
    expect(sameService("https://eth.example/v2/abc", "https://eth.example/v2/ABC")).toBe(false);
    // Another name for the same machine is not the same address; the e2e suite relies on that.
    expect(sameService("http://127.0.0.1:8545", "http://localhost:8545")).toBe(false);
    expect(sameService(null, "https://eth.example")).toBe(false);
    expect(sameService("nonsense", "nonsense")).toBe(false);
  });

  it("never takes the path, where a key sits, for the operator", () => {
    expect(sharedOperator("https://eth-mainnet.g.alchemy.com/v2/SECRET", "https://eth-mainnet.g.alchemy.com/v2/OTHER")).toBe(
      "eth-mainnet.g.alchemy.com",
    );
    expect(sharedOperator("nonsense", "nonsense")).toBeNull();
  });

  it("warns when both are probably one operator's, by host or its last two labels", () => {
    expect(sharedOperator("https://eth-mainnet.g.alchemy.com/v2/a", "https://eth.alchemy.com/b")).toBe("alchemy.com");
    expect(sharedOperator("https://rpc.example.org", "https://rpc.example.org/other")).toBe("rpc.example.org");
    expect(sharedOperator("https://eth.llamarpc.com", "https://mainnet.infura.io/v3/x")).toBeNull();
    // Addresses and one-label names are compared whole.
    expect(sharedOperator("http://10.0.0.1:8545", "http://192.168.0.1:8545")).toBeNull();
    expect(sharedOperator("http://127.0.0.1:8545", "http://localhost:8545")).toBeNull();
    expect(sameOperatorWarning("alchemy.com")).toBe(
      "Both are at alchemy.com: probably the same operator, so not much of a second opinion.",
    );
  });
});

describe("withTimeout", () => {
  it("passes answers and errors through, and gives up after the limit", async () => {
    vi.useFakeTimers();
    try {
      const fast = withTimeout(async () => "0x1", 1_000);
      await expect(fast("eth_blockNumber", [])).resolves.toBe("0x1");
      const failing = withTimeout(async () => {
        throw new Error("eth_blockNumber: nope");
      }, 1_000);
      await expect(failing("eth_blockNumber", [])).rejects.toThrow("nope");

      const hanging = withTimeout(() => new Promise(() => {}), 8_000)("eth_simulateV1", []);
      const settled = expect(hanging).rejects.toBeInstanceOf(RpcTimeout);
      await vi.advanceTimersByTimeAsync(8_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ObservedSimulationProvider and SecondOpinionMonitor", () => {
  const outcome = (secondOpinion?: SecondOpinion): SimulationOutcome => ({
    status: "success",
    gasUsed: 21_000n,
    logs: [],
    ...(secondOpinion === undefined ? {} : { secondOpinion }),
  });
  const provider = (answer: SimulationOutcome): SimulationProvider => ({
    kind: "eth_simulateV1",
    isAvailable: async () => true,
    simulate: async () => answer,
  });
  const request = { chainId: 1, account: "0x0000000000000000000000000000000000000001" as const, calls: [] };

  it("returns exactly what the provider returned, and reports its second opinion", async () => {
    const monitor = new SecondOpinionMonitor({ kind: "on", host: "second.example", last: null, sameOperator: null });
    let heard = 0;
    monitor.subscribe(() => (heard += 1));

    const unavailable = outcome({ kind: "unavailable", host: "second.example", reason: "timeout" });
    const observed = new ObservedSimulationProvider(provider(unavailable), (o) => monitor.heard(o));
    expect(await observed.simulate(request)).toBe(unavailable);
    expect(monitor.status).toEqual({ kind: "on", host: "second.example", last: "unavailable", sameOperator: null });

    // The same answer again changes nothing, so nobody re-renders for it.
    await observed.simulate(request);
    expect(heard).toBe(1);

    const agrees = outcome({ kind: "agrees", host: "second.example" });
    await new ObservedSimulationProvider(provider(agrees), (o) => monitor.heard(o)).simulate(request);
    expect(monitor.status.kind === "on" && monitor.status.last).toBe("agrees");
    expect(heard).toBe(2);
  });

  it("never lets a failing listener change a check", async () => {
    const plain = outcome({ kind: "disagrees", host: "second.example", reason: "result", detail: "x" });
    const observed = new ObservedSimulationProvider(provider(plain), () => {
      throw new Error("strip broke");
    });
    expect(await observed.simulate(request)).toBe(plain);
    expect(observed.kind).toBe("eth_simulateV1");
    expect(await observed.isAvailable()).toBe(true);
  });

  it("has nothing to record while off or pointed at the main service", () => {
    const off = new SecondOpinionMonitor({ kind: "off" });
    off.heard({ kind: "unavailable", host: "x", reason: "y" });
    expect(off.status).toEqual({ kind: "off" });
    const same = new SecondOpinionMonitor({ kind: "same" });
    same.heard({ kind: "agrees", host: "x" });
    expect(same.status).toEqual({ kind: "same" });
  });
});
