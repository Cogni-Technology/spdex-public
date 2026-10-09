/**
 * The Permit2 batch, held to viem and to Permit2's own hashing.
 *
 * Core encodes the batch call and builds the typed data by hand, so it can
 * stay free of a codec. These tests are what make the hand-rolled bytes more
 * than a belief: the calldata must equal viem's `encodeFunctionData` for
 * Permit2's ABI, byte for byte, and the typed data must hash to exactly the
 * digest Permit2 computes on chain — its typehash strings, its domain without
 * a version — or a wallet would sign something Permit2 refuses.
 */

import { describe, expect, it } from "vitest";
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  toHex,
  type TypedDataDefinition,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  encodePermit2Approval,
  encodePermit2BatchTransfer,
  permit2BatchTypedData,
  permit2BatchTypedDataJson,
  MAX_UINT256,
  PERMIT2_ADDRESS,
  type Address,
  type Hex,
  type TipIntent,
} from "@spdex/core";
import { codeHashAt, permit2NonceBitmap, permit2Status, PERMIT2_NONCE_BITMAP_SELECTOR } from "./permit2.js";

const SPX = "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c" as const;
/** A throwaway key: anvil's #0, whose private key is public. */
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const OWNER = privateKeyToAccount(KEY).address.toLowerCase() as Address;

const RECIPIENTS: Address[] = [
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
];

function intentFor(count: number, chainId = 1): TipIntent {
  return {
    version: 1,
    chainId,
    account: OWNER,
    token: SPX,
    deliveredAmount: 10n ** 20n,
    transfers: RECIPIENTS.slice(0, count).map((recipient, index) => ({
      recipient,
      amount: 1_000_000n * BigInt(index + 1) + 7n,
      label: `r${index}`,
    })),
    nonce: "0x01",
  };
}

const permit2Abi = parseAbi([
  "struct TokenPermissions { address token; uint256 amount; }",
  "struct PermitBatchTransferFrom { TokenPermissions[] permitted; uint256 nonce; uint256 deadline; }",
  "struct SignatureTransferDetails { address to; uint256 requestedAmount; }",
  "function permitTransferFrom(PermitBatchTransferFrom permit, SignatureTransferDetails[] transferDetails, address owner, bytes signature)",
]);

describe("encodePermit2BatchTransfer", () => {
  for (const count of [1, 2, 5]) {
    for (const bytes of [65, 64]) {
      it(`matches viem for ${count} recipient(s) and a ${bytes}-byte signature`, () => {
        const intent = intentFor(count);
        const signature = toHex(Uint8Array.from({ length: bytes }, (_, i) => (i * 37 + 11) % 256));
        const permit = { nonce: (123n << 8n) | 45n, deadline: 1_790_001_200n, signature };
        const expected = encodeFunctionData({
          abi: permit2Abi,
          functionName: "permitTransferFrom",
          args: [
            {
              permitted: intent.transfers.map((t) => ({ token: SPX, amount: t.amount })),
              nonce: permit.nonce,
              deadline: permit.deadline,
            },
            intent.transfers.map((t) => ({ to: t.recipient, requestedAmount: t.amount })),
            OWNER,
            signature,
          ],
        });
        expect(encodePermit2BatchTransfer(intent, permit)).toBe(expected);
      });
    }
  }

  it("carries the largest nonce and deadline a uint256 holds", () => {
    const intent = intentFor(2);
    const permit = { nonce: MAX_UINT256, deadline: MAX_UINT256, signature: `0x${"cd".repeat(65)}` as Hex };
    const expected = encodeFunctionData({
      abi: permit2Abi,
      functionName: "permitTransferFrom",
      args: [
        { permitted: intent.transfers.map((t) => ({ token: SPX, amount: t.amount })), nonce: MAX_UINT256, deadline: MAX_UINT256 },
        intent.transfers.map((t) => ({ to: t.recipient, requestedAmount: t.amount })),
        OWNER,
        permit.signature,
      ],
    });
    expect(encodePermit2BatchTransfer(intent, permit)).toBe(expected);
  });

  it("refuses what cannot be encoded rather than truncating it", () => {
    const intent = intentFor(2);
    expect(() => encodePermit2BatchTransfer(intent, { nonce: MAX_UINT256 + 1n, deadline: 1n, signature: "0x" })).toThrow();
    expect(() => encodePermit2BatchTransfer(intent, { nonce: 1n, deadline: 1n, signature: "0xabc" })).toThrow();
  });
});

describe("encodePermit2Approval", () => {
  const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

  it("is approve(Permit2, max) to grant and approve(Permit2, 0) to revoke", () => {
    expect(encodePermit2Approval("grant")).toBe(
      encodeFunctionData({ abi: erc20, functionName: "approve", args: [PERMIT2_ADDRESS, MAX_UINT256] }),
    );
    expect(encodePermit2Approval("revoke")).toBe(
      encodeFunctionData({ abi: erc20, functionName: "approve", args: [PERMIT2_ADDRESS, 0n] }),
    );
  });
});

/** Permit2's own digest, written the way SignatureTransfer and EIP712.sol compute it. */
function permit2Digest(intent: TipIntent, nonce: bigint, deadline: bigint): Hex {
  const domainTypeHash = keccak256(toHex("EIP712Domain(string name,uint256 chainId,address verifyingContract)"));
  const domain = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [domainTypeHash, keccak256(toHex("Permit2")), BigInt(intent.chainId), PERMIT2_ADDRESS],
    ),
  );
  const tokenPermissionsTypeHash = keccak256(toHex("TokenPermissions(address token,uint256 amount)"));
  const batchTypeHash = keccak256(
    toHex(
      "PermitBatchTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)",
    ),
  );
  const permissions = intent.transfers.map((t) =>
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
        [tokenPermissionsTypeHash, intent.token, t.amount],
      ),
    ),
  );
  const struct = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [batchTypeHash, keccak256(concat(permissions)), intent.account, nonce, deadline],
    ),
  );
  return keccak256(concat(["0x1901", domain, struct]));
}

/** The JSON a wallet receives, read back the way viem reads typed data. */
function asViem(json: string): TypedDataDefinition {
  const parsed = JSON.parse(json) as ReturnType<typeof permit2BatchTypedData>;
  const { EIP712Domain: _domain, ...types } = parsed.types;
  return {
    domain: { ...parsed.domain, chainId: parsed.domain.chainId },
    types: types as unknown as TypedDataDefinition["types"],
    primaryType: parsed.primaryType,
    message: {
      permitted: parsed.message.permitted.map((p) => ({ token: p.token, amount: BigInt(p.amount) })),
      spender: parsed.message.spender,
      nonce: BigInt(parsed.message.nonce),
      deadline: BigInt(parsed.message.deadline),
    },
  } as TypedDataDefinition;
}

describe("permit2BatchTypedData", () => {
  it("hashes to the digest Permit2 computes, on Ethereum and on the fork's chain id", () => {
    for (const chainId of [1, 690069]) {
      const intent = intentFor(3, chainId);
      const json = permit2BatchTypedDataJson(intent, 99n, 1_790_001_200n);
      expect(hashTypedData(asViem(json))).toBe(permit2Digest(intent, 99n, 1_790_001_200n));
    }
  });

  it("names the account as spender, Permit2 as verifier, and every amount in order", () => {
    const intent = intentFor(2);
    const typed = permit2BatchTypedData(intent, 5n, 6n);
    expect(typed.message.spender).toBe(OWNER);
    expect(typed.domain).toEqual({ name: "Permit2", chainId: 1, verifyingContract: PERMIT2_ADDRESS });
    expect(typed.message.permitted).toEqual(intent.transfers.map((t) => ({ token: SPX, amount: t.amount.toString() })));
    expect(typed.message.nonce).toBe("5");
    expect(typed.message.deadline).toBe("6");
  });

  it("is what a wallet signs: a signature over it recovers the account", async () => {
    const intent = intentFor(2);
    const json = permit2BatchTypedDataJson(intent, 1n, 2n);
    const signature = await privateKeyToAccount(KEY).signTypedData(asViem(json) as Parameters<ReturnType<typeof privateKeyToAccount>["signTypedData"]>[0]);
    const recovered = await recoverTypedDataAddress({ ...asViem(json), signature } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(recovered.toLowerCase()).toBe(OWNER);
  });

  it("builds the same string every time from the same intent", () => {
    expect(permit2BatchTypedDataJson(intentFor(2), 3n, 4n)).toBe(permit2BatchTypedDataJson(intentFor(2), 3n, 4n));
  });
});

describe("reading Permit2", () => {
  const answering = (answer: unknown) => async () => answer;

  it("hashes the code it is given, and the empty code of an empty address", async () => {
    expect(await codeHashAt(answering("0x6001"), PERMIT2_ADDRESS)).toBe(keccak256("0x6001"));
    expect(await codeHashAt(answering("0x"), PERMIT2_ADDRESS)).toBe(keccak256("0x"));
  });

  it("refuses an answer that is not code, rather than hashing it", async () => {
    await expect(codeHashAt(answering(null), PERMIT2_ADDRESS)).rejects.toThrow();
    await expect(codeHashAt(answering("0xabc"), PERMIT2_ADDRESS)).rejects.toThrow();
  });

  it("says no for other code or none, and unknown when the code can't be read", async () => {
    expect(await permit2Status(answering("0x"))).toBe(false);
    expect(await permit2Status(answering("0x6001"))).toBe(false);
    expect(await permit2Status(() => Promise.reject(new Error("429")))).toBe("unknown");
  });

  it("asks for one word of the owner's nonce bitmap, and refuses a non-answer", async () => {
    const calls: unknown[][] = [];
    const rpc = async (_method: string, params: unknown[]) => {
      calls.push(params);
      return `0x${"0".repeat(63)}5`;
    };
    expect(await permit2NonceBitmap(rpc, OWNER, 258n)).toBe(5n);
    const request = calls[0]![0] as { to: string; data: string };
    expect(request.to).toBe(PERMIT2_ADDRESS);
    expect(request.data).toBe(
      `${PERMIT2_NONCE_BITMAP_SELECTOR}${OWNER.slice(2).padStart(64, "0")}${(258).toString(16).padStart(64, "0")}`,
    );
    await expect(permit2NonceBitmap(answering("0x"), OWNER, 0n)).rejects.toThrow();
  });
});
