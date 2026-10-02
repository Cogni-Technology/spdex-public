/**
 * Tip splits — routing a slice of a swap's output to people the user chose.
 *
 * ## Why this is not part of the swap
 *
 * The obvious design folds tips into the swap: reduce `minAmountOut` by the
 * tip and have the venue send the difference elsewhere. It was rejected. That
 * makes every venue module a participant in moving money to a third party, and
 * it means the Guard's core invariant — "nothing but tokenIn leaves your
 * account" — has to grow an exception that a malicious module can aim at.
 *
 * A tip is therefore a *separate action with its own proof*: plain ERC-20
 * transfers, built by the host, from the amount the swap actually delivered,
 * checked against their own intent. No module is involved in composing them,
 * so no module can influence them. One recipient costs one transaction. Two
 * or more go out in one transaction through Uniswap's Permit2 (see "Batching"
 * below), which is a contract spDEX did not write and nobody controls, rather
 * than one of its own.
 *
 * ## Why the amount comes from the balance, not the quote
 *
 * Tipping a percentage of the *quoted* output would overpay whenever a swap
 * underdelivers — the user's slippage becomes the recipient's gain, which is
 * exactly backwards. The host reads the delivered balance and tips a share of
 * that, so the recipient's share and the user's exposure move together.
 *
 * ## Why the config stores addresses, not handles
 *
 * A registry module maps a name to an address, and it is untrusted — the same
 * position the token list is in, for the same reason: it decides which contract
 * a word points at. Resolution therefore happens once, when the user picks
 * someone, and the *address* is what is written to the config. A registry that
 * changes its mind later, or is swapped for a hostile one, cannot silently
 * redirect a tip the user already agreed to.
 */

import { z } from "zod";
import { AddressSchema, BigIntSchema, HexSchema, type Address, type Hex } from "./primitives.js";

/**
 * Ceiling on the total tipped, in basis points.
 *
 * Host-enforced and not configurable. Tipping is meant to be a rounding error
 * the user does not have to think about, and a UI bug or a bad import that set
 * it to 90% would be indistinguishable from theft. A hard ceiling means the
 * worst case is an annoyance rather than a loss.
 */
export const MAX_TOTAL_TIP_BPS = 500;

/**
 * Cap on recipients. Sent as separate transfers each one is a transaction and
 * its gas; batched, each is another entry the wallet shows and the Guard
 * checks, so the cap holds either way.
 */
export const MAX_TIP_RECIPIENTS = 5;

/**
 * Someone the user has chosen to tip, as stored in their config.
 *
 * `label` and `handle` are display only. The address is what the money follows,
 * and it is the only field the Guard reasons about.
 */
export const TipRecipientSchema = z.object({
  address: AddressSchema,
  label: z.string().min(1).max(64),
  /** Where the name came from — an X handle, eventually. Never trusted. */
  handle: z.string().max(64).optional(),
  /** Which registry resolved this address, recorded so provenance is visible. */
  source: z.string().max(64).optional(),
  bps: z.number().int().min(1).max(MAX_TOTAL_TIP_BPS),
});
export type TipRecipient = z.infer<typeof TipRecipientSchema>;

export const TipPolicySchema = z
  .object({
    enabled: z.boolean(),
    recipients: z.array(TipRecipientSchema).max(MAX_TIP_RECIPIENTS),
  })
  .refine(
    (policy) => policy.recipients.reduce((sum, r) => sum + r.bps, 0) <= MAX_TOTAL_TIP_BPS,
    { message: `tips may not total more than ${MAX_TOTAL_TIP_BPS} bps` },
  )
  .refine(
    (policy) =>
      new Set(policy.recipients.map((r) => r.address.toLowerCase())).size ===
      policy.recipients.length,
    // Two entries for one address is not a bigger tip, it is a confusing one:
    // the UI would show two rows and the recipient would receive their sum.
    { message: "the same address appears twice" },
  );
export type TipPolicy = z.infer<typeof TipPolicySchema>;

/** Total share tipped, in basis points. */
export function totalTipBps(policy: TipPolicy): number {
  if (!policy.enabled) return 0;
  return policy.recipients.reduce((sum, r) => sum + r.bps, 0);
}

/**
 * One transfer the host intends to make.
 *
 * Amounts are absolute rather than a share, because by the time this exists the
 * swap has happened and the delivered amount is known. A share would leave the
 * Guard recomputing a number the host already committed to.
 */
export const TipTransferSchema = z.object({
  recipient: AddressSchema,
  amount: BigIntSchema,
  label: z.string().max(64),
});
export type TipTransfer = z.infer<typeof TipTransferSchema>;

/**
 * The promise a tip plan is judged against.
 *
 * Mirrors `SwapIntent`: authored by the host, never by a module, and compared
 * against observed effects rather than believed.
 */
export const TipIntentSchema = z.object({
  version: z.literal(1),
  chainId: z.number().int().positive(),
  /** Who pays. */
  account: AddressSchema,
  /** What is sent — always the token the swap just delivered. */
  token: AddressSchema,
  /**
   * What the swap actually delivered, which the transfers are a share of.
   *
   * Carried so the Guard can check the share independently rather than trusting
   * the arithmetic that produced the amounts.
   */
  deliveredAmount: BigIntSchema,
  transfers: z.array(TipTransferSchema).min(1).max(MAX_TIP_RECIPIENTS),
  nonce: HexSchema,
});
export type TipIntent = z.infer<typeof TipIntentSchema>;

/**
 * How a tip plan pays: one ERC-20 transfer per recipient, or every recipient
 * in one Permit2 transaction.
 */
export type TipMode = "transfers" | "permit2-batch";

export interface TipPlan {
  version: 1;
  intent: TipIntent;
  /**
   * Absent means `"transfers"`, which is what every plan was before batching
   * existed, so a caller or a test written then still means what it meant.
   */
  mode?: TipMode;
  /**
   * The signed permit the one call carries. Present exactly when `mode` is
   * `"permit2-batch"`; the Guard re-encodes the call from it and the intent.
   */
  permit?: Permit2BatchPermit;
  calls: { to: `0x${string}`; data: `0x${string}`; value: bigint }[];
}

/** `transfer(address,uint256)`. */
export const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

/**
 * Encode an ERC-20 transfer.
 *
 * Exported from core so the host that *builds* a tip call and the Guard that
 * *checks* one derive the bytes from the same function. Two implementations
 * would eventually disagree, and the check would be verifying its own copy of
 * the bug rather than the call being signed.
 */
export function encodeTipTransfer(recipient: string, amount: bigint): `0x${string}` {
  if (amount < 0n) throw new RangeError("tip amount cannot be negative");
  const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  return `${ERC20_TRANSFER_SELECTOR}${word(recipient)}${word(amount.toString(16))}` as `0x${string}`;
}

// ── Batching: every recipient in one transaction, through Permit2 ─────────

/*
 * Two or more recipients used to cost a wallet prompt, a fee and a wait each.
 * They now go out in one transaction, through Uniswap's Permit2, in two steps:
 *
 *   1. The user signs a `PermitBatchTransferFrom` (EIP-712): these amounts of
 *      this token, with this nonce, until this deadline, for this spender. A
 *      signature, not a transaction, so no fee and nothing sent.
 *   2. The user sends one transaction themselves:
 *      `Permit2.permitTransferFrom(permit, transferDetails, owner, signature)`,
 *      and Permit2 moves each amount from them to each recipient.
 *
 * The spender in step 1 is the user. Permit2 hashes `msg.sender` in as the
 * spender when it checks the signature, so a permit whose spender is you can
 * be spent only by a transaction you send. A leaked or phished copy of the
 * signature is useless to anyone else.
 *
 * Why Permit2 and not the token's own permit: SPX has no EIP-2612 `permit`
 * (its `DOMAIN_SEPARATOR` and `nonces` revert). Why not a contract of spDEX's
 * own: "No contract anyone controls" is a rule this repository keeps, and
 * Permit2 is already deployed, widely used, and has no owner either.
 *
 * What it costs: Permit2 can only move a token the user has approved it for,
 * so the first batched tip asks for `approve(PERMIT2, max)` on that token,
 * once, and it stands, unlimited, until revoked in Expert → Tips. It is not
 * "a signature per spend". Permit2 moves the token for either of two things
 * the user gives: a signature (like the tips' own, whose spender is the user
 * and which the Guard checks before the wallet is asked), or an allowance
 * inside Permit2, which the user's own transaction can set with no signature
 * at all and which then lets its spender pull again and again. spDEX sees
 * only the signatures it asks for, never another site's. So the Guard reads
 * Permit2's allowances in every simulation and refuses any a plan would set,
 * the swap's static checks refuse any call to Permit2, and the docs say
 * plainly that a Permit2 signature for this token is worth as much as a
 * transaction. Revoking (`approve(PERMIT2, 0)`) stops Permit2 moving the
 * token at all; it does not clear allowances inside Permit2, which come back
 * into force if the permission is given again.
 *
 * Everything below is pure and dependency-free, like `encodeTipTransfer`, so
 * the host that builds a batch and the Guard that checks one derive the typed
 * data and the calldata from the same functions.
 */

/**
 * Uniswap's canonical Permit2. The same address on every chain it is on: it
 * was deployed through the deterministic CREATE2 deployer, so the address
 * commits to its creation code.
 */
export const PERMIT2_ADDRESS: Address = "0x000000000022d473030f116ddee9f6b43ac78ba3";

/**
 * keccak256 of the code at `PERMIT2_ADDRESS` on Ethereum, and so on a fork of
 * it (`packages/chain/test/integration/permit2.test.ts` reads it again from the
 * fork on every run).
 *
 * The address alone commits to the creation code, not to the code now there:
 * Permit2 bakes its chain id and domain separator into its runtime code as
 * immutables. So this hash is Ethereum's alone. On any other chain it differs
 * even for the genuine contract, spDEX does not treat that contract as known,
 * and tips there go out as separate transfers.
 */
export const PERMIT2_CODE_HASH: Hex = "0xc67d1657868aa5146eaf24fb879fb1fdec3d2d493b3683a61c9c2f4fb2851131";

/** True only for the hash of the Permit2 spDEX knows. Unknown (null) is not it. */
export function isPermit2CodeHash(hash: string | null | undefined): boolean {
  return typeof hash === "string" && hash.toLowerCase() === PERMIT2_CODE_HASH;
}

/** 2^256 - 1, the largest uint256: the conventional Permit2 approval. */
export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * The longest a tip signature may stay valid for, from now. A constant, like
 * the tip ceiling. A signature is a standing promise until its deadline, and
 * one that lived for days would be a promise nobody remembers making.
 */
export const MAX_PERMIT2_DEADLINE_SECONDS = 30 * 60;

/**
 * The deadline the host asks for: twenty minutes, inside the Guard's thirty.
 * Measured by the page's clock. Permit2 compares it with `block.timestamp`,
 * so a chain whose clock runs behind the page's (the local fork's does, by
 * days), or a page clock running fast, leaves the permit valid on chain for
 * longer than twenty minutes, and a page clock running slow shortens them.
 * The Guard holds the same line against the same clock, so its thirty
 * minutes are the page's minutes too. It does not also measure against the
 * chain's latest block: on the fork that would refuse every batch, and the
 * permit's spender is the user, so a longer life lets nobody else spend it.
 */
export const PERMIT2_TIP_DEADLINE_SECONDS = 20 * 60;

/** A permit's nonce and deadline: what the user signs besides the amounts. */
export interface Permit2BatchTerms {
  /**
   * Permit2's unordered nonce: the high 248 bits pick a word of the owner's
   * nonce bitmap, the low 8 bits a bit in it. Each nonce can be used once.
   */
  nonce: bigint;
  /** Unix seconds. Permit2 refuses the signature once `block.timestamp` is past it. */
  deadline: bigint;
}

export interface Permit2BatchPermit extends Permit2BatchTerms {
  /** The owner's signature over `permit2BatchTypedData(intent, nonce, deadline)`. */
  signature: Hex;
}

/** True when `nonce` fits a uint256. */
export function isPermit2Nonce(nonce: bigint): boolean {
  return nonce >= 0n && nonce <= MAX_UINT256;
}

/** Where a nonce lives in the owner's bitmap: `nonceBitmap(owner, word)`, bit `bit`. */
export function permit2NoncePosition(nonce: bigint): { word: bigint; bit: number } {
  if (!isPermit2Nonce(nonce)) throw new RangeError("a Permit2 nonce is a uint256");
  return { word: nonce >> 8n, bit: Number(nonce & 0xffn) };
}

/** The nonce for bit `bit` of word `word`. */
export function permit2Nonce(word: bigint, bit: number): bigint {
  if (word < 0n || word >= 1n << 248n) throw new RangeError("a nonce word is 248 bits");
  if (!Number.isInteger(bit) || bit < 0 || bit > 255) throw new RangeError("a nonce bit is 0 to 255");
  return (word << 8n) | BigInt(bit);
}

/**
 * Permit2's EIP-712 types for a batch, in the exact order the contract hashes
 * them. Permit2's domain has a name, a chain id and a verifying contract, and
 * no version.
 */
export const PERMIT2_BATCH_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  PermitBatchTransferFrom: [
    { name: "permitted", type: "TokenPermissions[]" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

/** The `eth_signTypedData_v4` payload for a batch of tips. uint256s are decimal strings. */
export interface Permit2BatchTypedData {
  types: typeof PERMIT2_BATCH_TYPES;
  primaryType: "PermitBatchTransferFrom";
  domain: { name: "Permit2"; chainId: number; verifyingContract: Address };
  message: {
    permitted: { token: Address; amount: string }[];
    spender: Address;
    nonce: string;
    deadline: string;
  };
}

/**
 * What the user signs for a batch of tips: one `TokenPermissions` per
 * transfer, in the intent's order, every one for the intent's token, with the
 * account as the spender.
 *
 * Pure, so the host building the request and the Guard checking it produce
 * the same object from the same intent. The Guard compares the string the
 * wallet will be handed with `JSON.stringify` of this, byte for byte.
 */
export function permit2BatchTypedData(intent: TipIntent, nonce: bigint, deadline: bigint): Permit2BatchTypedData {
  if (!isPermit2Nonce(nonce)) throw new RangeError("a Permit2 nonce is a uint256");
  if (deadline < 0n || deadline > MAX_UINT256) throw new RangeError("a Permit2 deadline is a uint256");
  const token = intent.token.toLowerCase() as Address;
  return {
    types: PERMIT2_BATCH_TYPES,
    primaryType: "PermitBatchTransferFrom",
    domain: { name: "Permit2", chainId: intent.chainId, verifyingContract: PERMIT2_ADDRESS },
    message: {
      permitted: intent.transfers.map((transfer) => ({ token, amount: transfer.amount.toString() })),
      spender: intent.account.toLowerCase() as Address,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
    },
  };
}

/** The exact string handed to `eth_signTypedData_v4`, and the one the Guard compares. */
export function permit2BatchTypedDataJson(intent: TipIntent, nonce: bigint, deadline: bigint): string {
  return JSON.stringify(permit2BatchTypedData(intent, nonce, deadline));
}

/**
 * `permitTransferFrom(((address,uint256)[],uint256,uint256),(address,uint256)[],address,bytes)`:
 * Permit2's batch transfer with a signature.
 */
export const PERMIT2_BATCH_TRANSFER_SELECTOR = "0xedd9444b";

const abiWord = (value: bigint | string): string => {
  const hex = typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "").toLowerCase();
  if (hex.length > 64) throw new RangeError("value does not fit in a word");
  return hex.padStart(64, "0");
};

/**
 * Encode the one call that pays every recipient:
 * `permitTransferFrom(permit, transferDetails, owner, signature)` with
 * `permit.permitted[i] = {token, amount_i}`, `transferDetails[i] = {to:
 * recipient_i, requestedAmount: amount_i}`, and the account as `owner`.
 *
 * Hand-rolled ABI, like `encodeTipTransfer`, so core stays free of a codec;
 * the unit tests hold it to viem's `encodeFunctionData` byte for byte. The
 * layout, after the selector: four head words (offsets to the permit, the
 * details and the signature, and the owner inline), then the permit (its own
 * offset to `permitted`, the nonce, the deadline, then the array), the
 * details array, and the signature's length and bytes, right-padded.
 */
export function encodePermit2BatchTransfer(intent: TipIntent, permit: Permit2BatchPermit): Hex {
  if (!isPermit2Nonce(permit.nonce)) throw new RangeError("a Permit2 nonce is a uint256");
  if (permit.deadline < 0n || permit.deadline > MAX_UINT256) throw new RangeError("a Permit2 deadline is a uint256");
  if (!/^0x([0-9a-fA-F]{2})*$/.test(permit.signature)) throw new RangeError("a signature is whole bytes of hex");
  for (const transfer of intent.transfers) {
    if (transfer.amount < 0n) throw new RangeError("tip amount cannot be negative");
  }

  const count = BigInt(intent.transfers.length);
  const head = 4n * 32n;
  const permitSize = (4n + 2n * count) * 32n;
  const detailsSize = (1n + 2n * count) * 32n;
  const signature = permit.signature.slice(2).toLowerCase();
  const signatureBytes = BigInt(signature.length / 2);
  const padded = signature.padEnd(Math.ceil(signature.length / 64) * 64, "0");

  const words = [
    abiWord(head),
    abiWord(head + permitSize),
    abiWord(intent.account),
    abiWord(head + permitSize + detailsSize),
    // The permit: offset of `permitted` inside the tuple, nonce, deadline.
    abiWord(3n * 32n),
    abiWord(permit.nonce),
    abiWord(permit.deadline),
    abiWord(count),
    ...intent.transfers.flatMap((transfer) => [abiWord(intent.token), abiWord(transfer.amount)]),
    // The transfer details, in the same order.
    abiWord(count),
    ...intent.transfers.flatMap((transfer) => [abiWord(transfer.recipient), abiWord(transfer.amount)]),
    abiWord(signatureBytes),
  ];
  return `${PERMIT2_BATCH_TRANSFER_SELECTOR}${words.join("")}${padded}` as Hex;
}

/** `approve(address,uint256)`. */
export const ERC20_APPROVE_SELECTOR = "0x095ea7b3";

/**
 * The standing permission, or its revocation: `approve(PERMIT2, max)` or
 * `approve(PERMIT2, 0)` on the tip token. Nothing else ever asks Permit2 to be
 * approved, and the spender is fixed here rather than passed, so no caller can
 * aim it anywhere else.
 */
export type Permit2PermissionKind = "grant" | "revoke";

export function permit2PermissionAmount(kind: Permit2PermissionKind): bigint {
  return kind === "grant" ? MAX_UINT256 : 0n;
}

export function encodePermit2Approval(kind: Permit2PermissionKind): Hex {
  return `${ERC20_APPROVE_SELECTOR}${abiWord(PERMIT2_ADDRESS)}${abiWord(permit2PermissionAmount(kind))}` as Hex;
}

/**
 * The standing permission as a plan of its own, so it reaches the signer
 * through the Guard like everything else that touches the user's money.
 */
export interface TipPermissionPlan {
  version: 1;
  kind: Permit2PermissionKind;
  chainId: number;
  account: Address;
  token: Address;
  /**
   * The tip a grant is for; required for a grant, absent for a revoke. The
   * grant must be on the token that tip sends, from the account that sends it,
   * so a permission can only ever be asked for in the course of a tip.
   */
  tip?: TipIntent;
  call: { to: Address; data: Hex; value: bigint };
}

/**
 * A request to sign a batch of tips, checked before the wallet sees it.
 *
 * A signature request is a request to move money, so it goes through the
 * Guard like a transaction: `typedData` is exactly the string that will be
 * handed to `eth_signTypedData_v4`, and it must equal what
 * `permit2BatchTypedDataJson` builds from the intent.
 */
export interface TipSignatureRequest {
  version: 1;
  intent: TipIntent;
  /** The address asked to sign. Must be the intent's account. */
  signer: Address;
  typedData: string;
}

/** A tip-list entry's stable id: lowercase letters, digits and dashes, 1–40, starting with a letter or digit. */
export const TipEntryIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

/** True for a string `new URL` reads as an https link. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * What a tip registry module returns.
 *
 * A wire type, like everything else crossing the module boundary: JSON-safe,
 * no bigint, so the native runtime and the sandbox marshal identically.
 */
export const WireTipCandidateSchema = z.object({
  /** The only thing money follows. EIP-55 checksummed in a shipped list (its tests check). */
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** The display name. */
  label: z.string().min(1).max(64),
  /** A public handle, e.g. "@example_artist". Display only. */
  handle: z.string().max(64).optional(),
  /** One line on who this is and why listed. Display only, and untrusted like the rest. */
  note: z.string().max(160).optional(),

  // Everything below was added later, and is optional: a v1 module that sends
  // none of it still loads, and an older host strips it (zod drops unknown
  // keys), so the change is additive both ways.

  /** A stable key, unique across the whole list, retired entries included. */
  id: TipEntryIdSchema.optional(),
  /** An ENS name the person uses, shown only: spDEX never resolves a listed entry's name. */
  ens: z.string().max(64).optional(),
  /** Where the person publicly posted this address. A link, never fetched by spDEX. */
  proof: z
    .string()
    .max(200)
    .refine(isHttpsUrl, { message: "a proof link must be https" })
    .optional(),
  /**
   * The person's own signature over `tipClaimMessage(address, handle, month)`
   * (EIP-191). The host checks it offline and shows SIGNED only when it
   * recovers this entry's address.
   */
  claim: z
    .object({
      message: z.string().max(200),
      signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    })
    .optional(),
  /** What kind of listing this is. */
  kind: z.enum(["creator", "cause", "builder", "other"]).optional(),
  /** The month it was listed, "yyyy-mm". */
  listed: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  /**
   * Why it is no longer offered. A retired entry is never offered, and a
   * recipient chosen from it is skipped until the person confirms it again.
   */
  retired: z.string().min(1).max(120).optional(),
  /** On a retired entry: the id of the entry that replaces it. Never followed on its own. */
  replacedBy: TipEntryIdSchema.optional(),
  /** A display hint that this is a test entry. Nothing may depend on it. */
  test: z.boolean().optional(),
});
export type WireTipCandidate = z.infer<typeof WireTipCandidateSchema>;

/**
 * spDEX's own donation address (the "spDEX donation vault"), EIP-55.
 *
 * It is listed in the shipped tip list like anyone else, and like anyone else
 * it is never chosen for a person: tips stay off until they pick a share and
 * who gets it. It is the one entry whose evidence is spDEX's own source
 * rather than an outside post, so the host names it from this constant, never
 * from anything a list says about itself: a list can't make another address
 * look like spDEX's own (`isSpdexOwnTipAddress`, the list rules'
 * `own`).
 */
export const SPDEX_DONATION_ADDRESS = "0x201A4f5c79f5796dF045e82b1057d074E8b85EC1";

/** Whether `address` is spDEX's own donation address, in any case. */
export function isSpdexOwnTipAddress(address: string): boolean {
  return address.toLowerCase() === SPDEX_DONATION_ADDRESS.toLowerCase();
}

/**
 * What a listed person signs to claim an entry, EIP-191 (`personal_sign`):
 * "spDEX tip list: <checksummed address> is <handle>, <yyyy-mm>".
 */
export function tipClaimMessage(checksummedAddress: string, handle: string, month: string): string {
  return `spDEX tip list: ${checksummedAddress} is ${handle}, ${month}`;
}

/**
 * A module that answers "who can I tip?".
 *
 * Deliberately the smallest interface in the repo, and it asks for no
 * capabilities at all — a registry is data, so it has no reason to read the
 * chain, and one that requested `chain:read` would be worth a second look.
 *
 * This is the shape a real registry backed by verified X accounts will take;
 * what changes then is where the list comes from, not what the host does with
 * it. The host already treats the answer as untrusted.
 */
export interface RegistryModule {
  readonly apiVersion: string;
  listRecipients(ctx: unknown): Promise<WireTipCandidate[]>;
}

// ── Names on a tip list: hygiene and lookalikes ───────────────────────────

/*
 * A name is display only, but it is what a person reads when they decide who
 * gets their money, so it is cleaned on the way in and on the way out. Every
 * name, note, label and handle, from a shipped list, "My tip list", an
 * imported file or a settings link alike.
 */

/**
 * Characters that draw nothing or reorder what is drawn: every control (Cc)
 * and format character (Cf) — the zero-width space and joiners, the byte
 * order mark, soft hyphen, and the bidirectional controls that make
 * "moc.elpmaxe" read as "example.com" — plus the letters that render blank
 * (Hangul fillers, the braille blank, the Khmer inherent vowels) and the
 * marks that draw nothing on their own: variation selectors (VS1–VS256) and
 * Mongolian free variation selectors. An emoji's presentation selector goes
 * too, so "❤️" is kept as "❤".
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\u115F\u1160\u3164\uFFA0\u2800\u034F\u180E\u17B4\u17B5\u180B-\u180F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

/** `text` with every invisible or reordering character removed, spaces collapsed, NFC. */
export function cleanTipText(text: string): string {
  // Line breaks and tabs become spaces first: they are controls, but they
  // separate words, and "Maria\tLopez" is two words, not one.
  return text
    .normalize("NFC")
    .replace(/[\t\n\r\f\v\u2028\u2029]/g, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `text` holds something `cleanTipText` would remove. */
export function hasHiddenCharacters(text: string): boolean {
  INVISIBLE.lastIndex = 0;
  const found = INVISIBLE.test(text);
  INVISIBLE.lastIndex = 0;
  return found;
}

/**
 * Letters that pass for the characters of an address ("0x" and hex digits),
 * mapped to what they imitate. Full-width and styled forms need no entry:
 * NFKC folds them to plain ones first.
 */
const ADDRESS_LOOKALIKES: Record<string, string> = {
  х: "x", χ: "x", "×": "x", ⅹ: "x",
  а: "a", α: "a", в: "b", β: "b", с: "c", ϲ: "c", ԁ: "d", е: "e", ε: "e",
};

/**
 * True when `text` reads like the start of an address: "0x" and four hex
 * digits, after folding full-width and styled forms (NFKC), mapping the
 * Cyrillic, Greek and symbol lookalikes of those characters, reading an "o"
 * that starts a word before an "x" as the zero it imitates ("Ox1234"), and
 * dropping spaces ("0x 1234 5678").
 */
export function looksLikeAddress(text: string): boolean {
  const folded = cleanTipText(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(^|[^\p{L}\p{N}])[oоο](?=\s*[xх×χⅹ])/gu, (_, before: string) => `${before}0`)
    .replace(/\s+/gu, "");
  let mapped = "";
  for (const char of folded) mapped += ADDRESS_LOOKALIKES[char] ?? char;
  return /0x[0-9a-f]{4}/.test(mapped);
}

/**
 * Why a name can't be a tip name, or null. A name that reads like an address
 * ("0x1234…", in any of its disguises: `looksLikeAddress`) is refused: next
 * to the real address it would be a second, unchecked one, and address
 * poisoning relies on exactly that.
 */
export function tipNameProblem(name: string): string | null {
  const clean = cleanTipText(name);
  if (clean.length === 0) return "Give it a name.";
  if (clean.length > 64) return "Keep the name to 64 characters.";
  if (looksLikeAddress(clean)) return "A name can't look like an address.";
  return null;
}

/**
 * Letters from other alphabets that look like Latin ones, mapped to the
 * Latin letter they imitate. Not the whole Unicode confusables table: the
 * Cyrillic and Greek letters that pass for Latin in most fonts, which is what
 * a name imitating another name uses.
 */
const CONFUSABLES: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x",
  і: "i", ї: "i", ј: "j", ѕ: "s", һ: "h", ԁ: "d", ԛ: "q", ԝ: "w", ӏ: "l", ɡ: "g",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w",
  "0": "o", "1": "l", "|": "l",
};

/**
 * What a name looks like, for comparing two names: NFKC (so full-width and
 * styled letters fold to plain ones), lowercase, lookalike letters mapped to
 * Latin, and nothing but letters and digits. Two names with the same
 * skeleton read the same to a person.
 */
export function tipNameSkeleton(name: string): string {
  const folded = cleanTipText(name).normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFKC").toLowerCase();
  let out = "";
  for (const char of folded) out += CONFUSABLES[char] ?? char;
  return out.replace(/[^\p{L}\p{N}]/gu, "");
}

/** True when a name mixes Latin letters with Cyrillic or Greek ones, which is how one imitates another. */
export function mixesAlphabets(name: string): boolean {
  const clean = cleanTipText(name);
  const latin = /\p{Script=Latin}/u.test(clean);
  return latin && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(clean);
}
