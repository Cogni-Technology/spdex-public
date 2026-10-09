/**
 * Community keeping: the words and the checks behind the fold of that name at
 * the foot of Help run the network.
 *
 * Community keepers make other people's v2 buys and are paid for each one;
 * holding 690 SPX is the entry bar. Inside a buy's community window the vault
 * pays only an address the SPX holder registry finds eligible (or its own
 * owner): one that proved, from Ethereum's own state, that it held 690 SPX at
 * the end of a recent block, still holds that much, and is an ordinary
 * account. A proof lasts 30 days from its block's time.
 *
 * The panel (components/network/CommunityKeeping.tsx) reads nothing until it
 * is opened, and then only through the person's own network service:
 * `readHolderStatus` at one block, and to prove, `buildHolderProof` against
 * the `finalized` block, whose header is rebuilt and refused unless it hashes
 * to the block's hash (@spdex/vault, registry.ts). A service that refuses
 * `eth_getProof` is said so, and the paste path shows the exact requests to
 * run elsewhere, by hand: this page never fetches from anywhere else (AGENTS.md
 * rule 4). Whatever is built or pasted goes to the Engine's vault Guard as a
 * `prove` (`Engine.checkVaultProof`), which reads the block's hash itself,
 * and only then to the wallet. A proof moves no money: it may be signed on
 * one service's test-run, and a wrong one only reverts. It goes out the way
 * the person chose to send: publicly only when they say so, if private
 * sending is on and their wallet can't sign for it.
 *
 * Never a yield: keeping is paid work, said as such, with no rate of return,
 * no projection, and past fees only after the fact (decision 23).
 */

import type { Address, GuardViolation, Hex } from "@spdex/core";
import { HeaderHashMismatchError, type JsonRpc } from "@spdex/chain";
import type { VaultProveIntent } from "@spdex/guard";
import {
  BlockOutOfReachError,
  HoldingBelowMinimumError,
  MIN_SPX,
  PROOF_LAPSE_WARNING_SECONDS,
  PastedProofError,
  ProofUnavailableError,
  checksumAddress,
  proofRequests,
  provenBy,
  type HolderProof,
  type HolderStatus,
} from "@spdex/vault";
import { deviceTimeOf } from "../dca/vault.js";
import { guardSentence } from "../errors.js";
import { sourceUrl } from "../links.js";
import { clockText, dayText, formatCount } from "../money/format.js";
import { readReceipt, type ChainReceipt } from "../receipts.js";
import { COMMUNITY_KEEPING_TEXT, CONTRACT_KEEPER_TEXT, spxText } from "./batch.js";

const lower = (value: string): Address => value.toLowerCase() as Address;

// ── Links ─────────────────────────────────────────────────────────────────────

/**
 * A page of the docs in the release's published source, for a link the
 * person clicks: the source's address (`VITE_SPDEX_SOURCE_URL`, lib/links.ts)
 * without its `.git`, then the browse path GitHub uses (and GitLab follows)
 * at the default branch. Null when the build names no source: the link is
 * left out, never guessed. A link, never a request (AGENTS.md rule 4).
 */
export function sourceDocUrl(path: string, anchor: string, source: string | null = sourceUrl()): string | null {
  if (source === null) return null;
  const repository = source.replace(/\/+$/, "").replace(/\.git$/, "");
  return `${repository}/blob/HEAD/${path}#${anchor}`;
}

/** docs/KEEPER.md, "Becoming a community keeper". */
export const keeperDocsUrl = (source: string | null = sourceUrl()) => sourceDocUrl("docs/KEEPER.md", "becoming-a-community-keeper", source);

/** docs/RPC-RUNBOOK.md, "Proving SPX held: `eth_getProof`": which services answer it. */
export const proofDocsUrl = (source: string | null = sourceUrl()) =>
  sourceDocUrl("docs/RPC-RUNBOOK.md", "proving-spx-held-eth_getproof", source);

export const KEEPER_DOCS_LINK_TEXT = "Becoming a community keeper ↗";

// ── The standing of an address ────────────────────────────────────────────────

/**
 * Whether the lapse banner shows: from five days before the proof lapses
 * (`PROOF_LAPSE_WARNING_SECONDS`) to its last valid second, in chain time.
 * Not before, not once it has lapsed (the status says that), and not when
 * either figure is unknown.
 */
export function lapseBannerShown(validUntil: bigint | null, chainTime: bigint | null): boolean {
  if (validUntil === null || chainTime === null || validUntil === 0n) return false;
  return chainTime <= validUntil && validUntil - chainTime <= PROOF_LAPSE_WARNING_SECONDS;
}

/** "Oct 26, 14:32": a time in unix seconds, in this device's time zone. */
export function whenText(seconds: bigint): string {
  return `${dayText(Number(seconds))}, ${clockText(Number(seconds) * 1000)}`;
}

/**
 * A chain time as this device's clock reads it, by a standing read: its
 * block's time was `chainTime` when this device's clock read `readAtMs`
 * (`deviceTimeOf`, as the vault card and Help run's first-claim line do).
 * The chain's own when either is unknown; on mainnet the two agree within a
 * block, and a fork's runs behind.
 */
export function onThisDevice(seconds: bigint, clock: { chainTime: bigint | null; readAtMs: number } | null): bigint {
  if (clock === null || clock.chainTime === null) return seconds;
  return BigInt(deviceTimeOf(Number(seconds), Number(clock.chainTime), clock.readAtMs));
}

/** The connected wallet's standing, line by line, from one read. Unknown says so; it is never a no. */
export interface StandingLines {
  /** Eligible or not, in one line. */
  headline: string;
  eligible: boolean | null;
  /** Its proof: valid until when (inclusive), lapsed, never made, or unknown. */
  proof: string;
  /** Its SPX against the 690, or why it can't be a keeper at all. */
  holding: string;
}

/** `readAtMs`, when given, is when this device read `status`: its dates are then this device's (`onThisDevice`). */
export function standingLines(status: Extract<HolderStatus, { state: "read" }>, readAtMs?: number): StandingLines {
  const clock = readAtMs === undefined ? null : { chainTime: status.chainTime, readAtMs };
  const headline =
    status.eligible === true
      ? "Your wallet is a community keeper: buys inside their community window can pay it."
      : status.eligible === false
        ? "Your wallet isn't a community keeper right now."
        : "Whether your wallet is a community keeper couldn't be read just now.";
  const proof =
    status.validUntil === null || status.proofValid === null
      ? "Its proof couldn't be read."
      : status.validUntil === 0n
        ? "It has never proven its SPX."
        : status.proofValid
          ? `Its proof is valid until ${whenText(onThisDevice(status.validUntil, clock))}.`
          : `Its proof lapsed on ${dayText(Number(onThisDevice(status.validUntil, clock)))}.`;
  const holding =
    status.isAccount === false
      ? CONTRACT_KEEPER_TEXT
      : status.balance === null
        ? "Its SPX couldn't be read."
        : status.balance < MIN_SPX
          ? `You hold ${spxText(status.balance)} of the ${spxText(MIN_SPX)} SPX.`
          : `You hold ${spxText(status.balance)} SPX; ${spxText(MIN_SPX)} is the bar.`;
  return { headline, eligible: status.eligible, proof, holding };
}

/**
 * Whether a proof of this address is worth building: an ordinary account
 * (known, not guessed), holding at least 690 SPX now. A contract can never be
 * eligible whatever it proves, and a proof of less than 690 only reverts.
 */
export function mayProve(status: HolderStatus): boolean {
  return status.state === "read" && status.isAccount === true && status.balance !== null && status.balance >= MIN_SPX;
}

/**
 * Whether the panel offers Prove my SPX: an address that may prove (`mayProve`)
 * and has no valid proof, or one within five days of lapsing. A proof valid
 * for longer needs nothing yet; a newer one would only move its date.
 */
export function offersProof(status: HolderStatus): boolean {
  if (status.state !== "read" || !mayProve(status)) return false;
  return status.proofValid !== true || lapseBannerShown(status.validUntil, status.chainTime);
}

/**
 * Why Prove another address offers nothing for the connected wallet's own
 * address when it needs no proof yet (`offersProof` said no), as Prove my SPX
 * offers nothing:
 * its proof is valid for more than five more days, and a new one would only
 * move its date, for about 650,000 gas.
 */
export function alreadyProvenText(status: HolderStatus, readAtMs: number): string {
  const clock = { chainTime: status.state === "read" ? status.chainTime : null, readAtMs };
  const until = status.state === "read" && status.validUntil !== null ? whenText(onThisDevice(status.validUntil, clock)) : null;
  return `${until === null ? "That address is proven already" : `That address is proven until ${until}`}: a new proof would only move its date. One is offered from five days before it lapses.`;
}

/**
 * Why no proof is built or sent for an address (`mayProve` said no): typed
 * into Prove another address, or a pasted proof's. In one line: it can never
 * be eligible, it holds too little now for a proof to make it a keeper, or
 * its standing couldn't be read.
 */
export function otherAddressText(status: HolderStatus): string {
  if (status.state === "not-deployed") return "The SPX holder registry isn't on this network, so there's nothing to prove here.";
  if (status.isAccount === false) return CONTRACT_KEEPER_TEXT;
  if (status.isAccount === null || status.balance === null) return "That address's standing couldn't be read, so no proof was built.";
  return `It holds ${spxText(status.balance)} of the ${spxText(MIN_SPX)} SPX now, so a proof of it can't make it a community keeper.`;
}

/**
 * Whether to say what proving makes public (decision 24) before proving an
 * address: unless it is known to have proven before. A proof that couldn't be
 * read may be its first, and unknown is never taken as a known value.
 */
export function mayBeFirstProof(validUntil: bigint | null | undefined): boolean {
  return validUntil === null || validUntil === undefined || validUntil === 0n;
}

/**
 * Why a pasted proof isn't sent, or null when it may be: only for an address
 * Prove my SPX and Prove another address would prove (`mayProve`), an
 * ordinary account holding 690 SPX now. The Guard doesn't refuse a proof of a
 * contract, which the registry would record and never find eligible: the
 * panel does.
 */
export function pasteRefusalText(status: HolderStatus | null): string | null {
  if (status === null) return "That address's standing couldn't be read, so nothing was sent.";
  return mayProve(status) ? null : otherAddressText(status);
}

export function lapseBannerText(validUntil: bigint): string {
  return `Your proof lapses on ${whenText(validUntil)}. Prove again to stay a community keeper.`;
}

// ── Words ─────────────────────────────────────────────────────────────────────

export const KEEPING_TITLE = "Community keeping";

/** What community keeping is, as paid work: Help run's own sentence. */
export const KEEPING_INTRO = COMMUNITY_KEEPING_TEXT;

/** What proving costs, before it is pressed. */
export const PROOF_COST_TEXT = "One transaction of about 680,000 gas, once every 30 days. It moves no money.";

/** What proving makes public (decision 24): said before a wallet's first proof, and asked to continue. */
export const PROVING_PUBLISHES_TEXT =
  "Proving records on chain, for good, that this address held at least 690 SPX. Buys paid to it then link it in public to the wallet that sends them, so keep the SPX in a wallet kept for it, not your main one.";

export const PROVE_OTHER_TEXT =
  "Pay the network fee from this wallet to prove another address, such as a keeper's cold wallet, which never touches a browser.";

/** The service refused `eth_getProof`: said, with where to look, and the paste path opened. */
export const PROOF_REFUSED_TEXT =
  "Your network service won't give the proof (it doesn't answer eth_getProof for that block). Another service can: paste its answers below.";

/** Where the docs say which services answer `eth_getProof`, when the build names no source to link. */
export const PROOF_DOCS_TEXT = "docs/RPC-RUNBOOK.md in spDEX's source lists services that answer it.";

export const PASTE_INTRO_TEXT =
  "Run these two requests against a service that answers eth_getProof, then paste both answers here. They're checked against your own service before anything is sent.";

/**
 * The two requests to run by hand, as `curl` commands for the block named by
 * the person's own service: the block, and SPX's proof of the holder's
 * balance at it (`proofRequests`). The other service's address is left for
 * the person to fill in: spDEX names none.
 */
export function pasteCommands(holder: Address, blockNumber: bigint): string[] {
  return proofRequests(holder, blockNumber).map(
    (request) => `curl -sS -X POST <another service> -H 'content-type: application/json' --data '${request.body}'`,
  );
}

/** The most text the paste box takes: two answers are about 10 KB; anything far past that is not them. */
export const MAX_PASTE_CHARS = 200_000;

/**
 * An address typed in: `0x` and 40 hex digits, lowercase; a mixed-case one
 * must match its checksum, which catches a mistyped character. Null with a
 * reason otherwise.
 */
export function parseTypedAddress(text: string): { address: Address } | { error: string } {
  const typed = text.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(typed)) return { error: "That isn't an address: 0x and 40 hex digits." };
  const mixed = typed.slice(2) !== typed.slice(2).toLowerCase() && typed.slice(2) !== typed.slice(2).toUpperCase();
  if (mixed && checksumAddress(typed) !== typed) return { error: "That address's capital letters don't match its checksum: check it was copied whole." };
  return { address: lower(typed) };
}

/** A proof that couldn't be built or pasted, in words; null for a refusal of `eth_getProof`, which has a path of its own. */
export function proofErrorText(error: unknown): string | null {
  if (error instanceof ProofUnavailableError) return null;
  if (error instanceof HoldingBelowMinimumError) {
    return `At block ${formatCount(error.blockNumber)} it held ${spxText(error.balance)} SPX; proving takes ${spxText(MIN_SPX)}.`;
  }
  if (error instanceof HeaderHashMismatchError) {
    return `Your network service's block ${formatCount(error.number)} doesn't hash to its own hash, so no proof was built from it. Either the service answered wrongly, or Ethereum's blocks have changed in a way this copy of spDEX doesn't know: try another service, or a newer spDEX.`;
  }
  if (error instanceof PastedProofError || error instanceof BlockOutOfReachError) return `${capitalise(error.message)}.`;
  const said = error instanceof Error ? error.message : String(error);
  return `Couldn't build the proof (${said.replace(/\.$/, "")}).`;
}

/**
 * One line of the safety check's refusal of a proof. A proof's own refusals
 * (a revert the registry names, a block that isn't the chain's) carry the
 * Guard's words, which say more than the code's general sentence. The two
 * vault codes' general sentences speak of a vault and its money, which a
 * proof has neither of, so a proof says its own; the rest read as everywhere
 * else.
 */
export function proofRefusalText(violation: Pick<GuardViolation, "code" | "message" | "detail">): string {
  const ownWords =
    (violation.code === "SIMULATION_REVERTED" && violation.detail?.["reason"] !== undefined) ||
    (violation.code === "VAULT_MALFORMED" && violation.detail?.["blockNumber"] !== undefined);
  if (ownWords) return `${capitalise(violation.message)}.`;
  if (violation.code === "VAULT_MALFORMED") return PROOF_MALFORMED_TEXT;
  if (violation.code === "VAULT_NOT_DELIVERED") return PROOF_NOT_RECORDED_TEXT;
  return guardSentence(violation.code, violation.detail);
}

const PROOF_MALFORMED_TEXT = "This didn't match the proof that was built: its block, the address it proves, or where it goes.";
const PROOF_NOT_RECORDED_TEXT = "The test-run shows the SPX holder registry recording no proof from this.";

/**
 * Private sending is on and the wallet can't sign for it: asked, as a swap's
 * fallback is, before the proof goes out publicly.
 */
export function proofPublicText(reason: string): string {
  return `Your wallet can't send this privately (${reason.replace(/\.$/, "")}). Send it publicly? It moves no money, but it's seen before it's included.`;
}

/** The person said no to sending publicly: nothing went out. */
export const PROOF_NOT_PUBLIC_TEXT = "Not sent: your wallet can't send it privately, and it wasn't sent publicly.";

/** A proof sent, whose receipt didn't come in the wait: it may still land, or a relay may have dropped it. */
export const PROOF_UNSEEN_TEXT =
  "Sent, but not seen included yet. It may still land, or the relay may have dropped it: check your wallet before proving again.";

/** "Checked on one service" for a proof: allowed, since a proof moves no money and a wrong one only reverts. */
export const PROOF_ONE_SERVICE_TEXT =
  "Test-run on your main service only. A proof moves no money: if it's wrong it only reverts, costing its network fee.";

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).replace(/\.$/, "");

// ── The transaction ───────────────────────────────────────────────────────────

/** The intent the Guard checks and the wallet signs: this proof, sent by `account`, who pays its network fee. */
export function proveIntent(proof: HolderProof, account: Address, chainId: number): VaultProveIntent {
  return {
    version: 1,
    action: "prove",
    chainId,
    account: lower(account),
    holder: lower(proof.holder),
    blockNumber: proof.blockNumber,
    blockHash: proof.blockHash,
    header: proof.header,
    accountProof: proof.accountProof,
    storageProof: proof.storageProof,
  };
}

/** A settled proof, from its receipt: never from the test-run. */
export interface ProofResult {
  status: "success" | "reverted";
  /** From the registry's own `Proven` for this holder; null when there is none. */
  validUntil: bigint | null;
  /** Gas used × the price paid; null when the receipt doesn't say. */
  fee: bigint | null;
}

/** What a settled proof did. Only the registry's own `Proven` counts: anyone can emit a log shaped like it. */
export function proofResultOf(receipt: ChainReceipt, input: { registry: Address; holder: Address }): ProofResult {
  if (receipt.status === "reverted") return { status: "reverted", validUntil: null, fee: receipt.fee };
  const proven = provenBy(input.registry, receipt.logs).find((event) => event.holder === lower(input.holder)) ?? null;
  return { status: "success", validUntil: proven?.validUntil ?? null, fee: receipt.fee };
}

/**
 * Wait for a sent proof to settle and read what it did, asking for the
 * receipt every `everyMs` until `timeoutMs` passes (then null: it may still
 * land).
 */
export async function waitForProof(
  rpc: JsonRpc,
  input: { hash: Hex; registry: Address; holder: Address },
  options: { timeoutMs: number; everyMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<ProofResult | null> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const receipt = await readReceipt(rpc, input.hash).catch(() => null);
    if (receipt !== null) return proofResultOf(receipt, input);
    if (now() >= deadline) return null;
    await sleep(options.everyMs ?? 1_000);
  }
}

/**
 * "Proven: valid until Nov 2, 09:15." or why not, from a settled proof; the
 * date by this device's clock when a standing read gives it (`onThisDevice`).
 */
export function proofResultText(result: ProofResult, clock: { chainTime: bigint | null; readAtMs: number } | null = null): string {
  if (result.status === "reverted") return "The proof reverted on chain: nothing was recorded, and its network fee was spent.";
  return result.validUntil === null
    ? "Sent and included, but the registry recorded no proof for this address."
    : `Proven: valid until ${whenText(onThisDevice(result.validUntil, clock))}.`;
}
