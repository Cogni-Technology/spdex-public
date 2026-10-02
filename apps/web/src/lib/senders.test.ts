/**
 * The wallet sender: it never broadcasts publicly without consent, holds a
 * private signature that came back too late, and hands over a private buy's
 * hash before it is posted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { signAsAsked } from "./signedTx.fixture.js";
import { addressOfKey, transactionHash } from "@spdex/chain";
import type { SubmitterConfig } from "@spdex/core";
import { walletSender } from "./senders.js";
import { LateSignature, PrivateSubmissionUnavailable, submitPrivately } from "./submit.js";
import { PRIVATE_CONFIRM_TIMEOUT_MS, PUBLIC_CONFIRM_TIMEOUT_MS, type Eip1193Provider } from "./wallet.js";

const KEY = `0x${"4c".repeat(32)}` as const;
const ADDRESS = addressOfKey(KEY);
const TO = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d" as const;
const CALL = { to: TO, data: "0xdeadbeef" as const, value: 1_000n };
const PUBLIC: SubmitterConfig = { mode: "wallet", url: null };
const RELAY: SubmitterConfig = { mode: "private", url: "https://relay.invalid/rpc" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("walletSender", () => {
  it("sends through the wallet, confirms through the user's endpoint", async () => {
    const provider: Eip1193Provider = {
      request: async ({ method }) => {
        if (method === "eth_sendTransaction") return `0x${"ab".repeat(32)}`;
        throw new Error(`unexpected ${method}`);
      },
    };
    const reads = async () => null;
    const sender = walletSender({ submitter: PUBLIC, account: ADDRESS, onPublicFallback: () => false, reads, provider });
    expect(sender.kind).toBe("wallet");
    expect(sender.confirm).toEqual({ rpc: reads, timeoutMs: PUBLIC_CONFIRM_TIMEOUT_MS });
    expect(await sender.send(CALL)).toEqual({ hash: `0x${"ab".repeat(32)}`, via: "wallet" });
  });

  it("private mode with a wallet that cannot sign privately stops, and never broadcasts publicly", async () => {
    const sent: string[] = [];
    const provider: Eip1193Provider = {
      request: async ({ method }) => {
        sent.push(method);
        if (method === "eth_signTransaction") throw Object.assign(new Error("not supported"), { code: 4200 });
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_sendTransaction") return `0x${"cd".repeat(32)}`;
        return "0x1";
      },
    };
    const reads = async (method: string) => (method === "eth_estimateGas" ? "0x5208" : "0x1");
    const sender = walletSender({ submitter: RELAY, account: ADDRESS, onPublicFallback: () => false, reads, provider });
    expect(sender.confirm.timeoutMs).toBe(PRIVATE_CONFIRM_TIMEOUT_MS);
    await expect(sender.send(CALL)).rejects.toBeInstanceOf(PrivateSubmissionUnavailable);
    expect(sent).not.toContain("eth_sendTransaction");
  });
});

describe("a private signature that comes back too late", () => {
  const signingWallet = (): Eip1193Provider => ({
    request: async ({ method, params }) => {
      if (method === "eth_signTransaction") return signAsAsked(params);
      if (method === "eth_chainId") return "0x1";
      throw new Error(`unexpected ${method}`);
    },
  });
  const reads = async (method: string) => (method === "eth_estimateGas" ? "0x5208" : "0x1");

  it("is not posted: the relay never sees it", async () => {
    let posted = 0;
    vi.stubGlobal("fetch", async () => {
      posted += 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${"ef".repeat(32)}` }));
    });
    const late = submitPrivately(signingWallet(), ADDRESS, CALL, RELAY.url!, reads, {
      notAfter: 1_000,
      now: () => 1_001_000,
    });
    await expect(late).rejects.toBeInstanceOf(LateSignature);
    expect(posted).toBe(0);

    // In time, it goes out as before.
    const onTime = await submitPrivately(signingWallet(), ADDRESS, CALL, RELAY.url!, reads, {
      notAfter: 1_000,
      now: () => 1_000_000,
    });
    expect(onTime.via).toBe("private");
    expect(posted).toBe(1);
  });

  it("walletSender passes its limit through; with none the wallet path is unchanged", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${"ef".repeat(32)}` })));
    const expired = walletSender({
      submitter: RELAY,
      account: ADDRESS,
      onPublicFallback: () => false,
      reads,
      provider: signingWallet(),
      notAfter: 1, // 1970: long past
    });
    await expect(expired.send(CALL)).rejects.toBeInstanceOf(LateSignature);
    const unlimited = walletSender({ submitter: RELAY, account: ADDRESS, onPublicFallback: () => false, reads, provider: signingWallet() });
    expect(await unlimited.send(CALL)).toEqual({ hash: `0x${"ef".repeat(32)}`, via: "private" });
  });
});

describe("walletSender — a private buy's hash, before it is posted", () => {
  let signed = "";
  const signingWallet = (): Eip1193Provider => ({
    request: async ({ method, params }) => {
      if (method === "eth_signTransaction") return (signed = signAsAsked(params));
      if (method === "eth_chainId") return "0x1";
      throw new Error(`unexpected ${method}`);
    },
  });
  const reads = async (method: string) => (method === "eth_estimateGas" ? "0x5208" : "0x1");

  it("hands over the hash of the signed bytes, then posts, and reports that hash", async () => {
    const order: string[] = [];
    // The bytes are signed before anything is posted, so `signed` is set by then.
    vi.stubGlobal("fetch", async () => {
      order.push("posted");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: transactionHash(signed) }));
    });
    const sender = walletSender({
      submitter: RELAY,
      account: ADDRESS,
      onPublicFallback: () => false,
      reads,
      provider: signingWallet(),
      onSigned: (hash) => void order.push(`signed ${hash}`),
    });
    expect(await sender.send(CALL)).toEqual({ hash: transactionHash(signed), via: "private" });
    expect(order).toEqual([`signed ${transactionHash(signed)}`, "posted"]);
  });
});
