/**
 * Community keeping's words and checks: when the lapse banner shows, what the
 * panel says of a wallet's standing, when it offers a proof, the links it may
 * print, how a typed address is read, how a failed or refused proof is said,
 * and what is read back from a proof's receipt. The proof itself is
 * `@spdex/vault`'s (registry.test.ts); the panel's states are drawn in
 * components/network/network.test.ts, and the fork run is
 * test/integration/keeping.test.ts.
 */

import { describe, expect, it } from "vitest";
import { HeaderHashMismatchError, transactionHash, type JsonRpc } from "@spdex/chain";
import type { Address, Hex } from "@spdex/core";
import {
  BlockOutOfReachError,
  HoldingBelowMinimumError,
  MIN_SPX,
  PROOF_LAPSE_WARNING_SECONDS,
  PastedProofError,
  ProofUnavailableError,
  proofRequests,
  type HolderProof,
  type HolderStatus,
} from "@spdex/vault";
import { guardSentence } from "../errors.js";
import {
  KEEPING_INTRO,
  PASTE_INTRO_TEXT,
  PROOF_COST_TEXT,
  PROOF_NOT_PUBLIC_TEXT,
  PROOF_ONE_SERVICE_TEXT,
  PROOF_REFUSED_TEXT,
  PROOF_UNSEEN_TEXT,
  PROVE_OTHER_TEXT,
  PROVING_PUBLISHES_TEXT,
  keeperDocsUrl,
  lapseBannerShown,
  mayBeFirstProof,
  mayProve,
  offersProof,
  onThisDevice,
  otherAddressText,
  parseTypedAddress,
  pasteCommands,
  pasteRefusalText,
  proofDocsUrl,
  proofErrorText,
  proofPublicText,
  proofRefusalText,
  proofResultOf,
  proofResultText,
  proveIntent,
  sourceDocUrl,
  standingLines,
  waitForProof,
  whenText,
} from "./keeping.js";

const ME = "0x00000000000000000000000000000000000000aa" as Address;
const REGISTRY = "0x2c7f732a453fe0a4a65f36ac564ff16007b5610d" as Address;
const SPX = 10n ** 8n;
const NOW = 1_790_000_000n;
const DAY = 86_400n;

function standing(overrides: Partial<Extract<HolderStatus, { state: "read" }>> = {}): Extract<HolderStatus, { state: "read" }> {
  return {
    state: "read",
    registry: REGISTRY,
    holder: ME,
    block: 26_000_000n,
    chainTime: NOW,
    eligible: true,
    validUntil: NOW + 20n * DAY,
    proofValid: true,
    lapsesSoon: false,
    isAccount: true,
    balance: 1_210n * SPX,
    shortfall: 0n,
    reason: null,
    ...overrides,
  };
}

describe("the lapse banner", () => {
  it("shows from five days before the proof lapses to its last valid second, in chain time", () => {
    expect(lapseBannerShown(NOW + PROOF_LAPSE_WARNING_SECONDS + 1n, NOW)).toBe(false);
    expect(lapseBannerShown(NOW + PROOF_LAPSE_WARNING_SECONDS, NOW)).toBe(true);
    expect(lapseBannerShown(NOW, NOW)).toBe(true);
    // Lapsed: the standing says so instead.
    expect(lapseBannerShown(NOW - 1n, NOW)).toBe(false);
    // Never proven, or unknown: no banner on a guess.
    expect(lapseBannerShown(0n, NOW)).toBe(false);
    expect(lapseBannerShown(null, NOW)).toBe(false);
    expect(lapseBannerShown(NOW, null)).toBe(false);
  });
});

describe("a wallet's standing", () => {
  it("says eligible or not, until when, and its SPX against the 690", () => {
    const eligible = standingLines(standing());
    // "Window" alone is the buy slot (DESIGN §6); the new thing is always the community window.
    expect(eligible.headline).toBe("Your wallet is a community keeper: buys inside their community window can pay it.");
    expect(eligible.proof).toMatch(/^Its proof is valid until [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}\.$/);
    expect(eligible.holding).toBe("You hold 1,210 SPX; 690 is the bar.");
    const short = standingLines(standing({ eligible: false, balance: 120n * SPX, shortfall: 570n * SPX, reason: "below-minimum" }));
    expect(short.headline).toBe("Your wallet isn't a community keeper right now.");
    expect(short.holding).toBe("You hold 120 of the 690 SPX.");
    expect(standingLines(standing({ validUntil: 0n, proofValid: false, eligible: false })).proof).toBe("It has never proven its SPX.");
    expect(standingLines(standing({ validUntil: NOW - DAY, proofValid: false, eligible: false })).proof).toMatch(/^Its proof lapsed on [A-Z][a-z]{2} \d{1,2}\.$/);
    expect(standingLines(standing({ isAccount: false, eligible: false, reason: "contract" })).holding).toBe(
      "Only an ordinary account can be paid as a community keeper; this address is a contract.",
    );
  });

  it("says what it couldn't read, never no or zero", () => {
    const unknown = standingLines(standing({ eligible: null, validUntil: null, proofValid: null, balance: null, shortfall: null }));
    expect(unknown).toEqual({
      headline: "Whether your wallet is a community keeper couldn't be read just now.",
      eligible: null,
      proof: "Its proof couldn't be read.",
      holding: "Its SPX couldn't be read.",
    });
  });

  it("offers a proof only to an account known to hold enough, with no proof valid beyond the next five days", () => {
    expect(mayProve(standing())).toBe(true);
    expect(mayProve(standing({ isAccount: false }))).toBe(false);
    expect(mayProve(standing({ isAccount: null }))).toBe(false);
    expect(mayProve(standing({ balance: MIN_SPX - 1n }))).toBe(false);
    expect(mayProve(standing({ balance: MIN_SPX }))).toBe(true);
    expect(mayProve(standing({ balance: null }))).toBe(false);
    expect(mayProve({ state: "not-deployed", registry: REGISTRY, holder: ME, block: null, chainTime: null })).toBe(false);
    // Valid for 20 days: nothing to do yet.
    expect(offersProof(standing())).toBe(false);
    expect(offersProof(standing({ validUntil: NOW + PROOF_LAPSE_WARNING_SECONDS }))).toBe(true);
    expect(offersProof(standing({ validUntil: 0n, proofValid: false }))).toBe(true);
    expect(offersProof(standing({ validUntil: NOW - 1n, proofValid: false }))).toBe(true);
    expect(offersProof(standing({ proofValid: null }))).toBe(true);
    expect(offersProof(standing({ validUntil: 0n, proofValid: false, isAccount: false }))).toBe(false);
  });

  it("says why an address typed in gets no proof", () => {
    expect(otherAddressText(standing({ isAccount: false }))).toBe("Only an ordinary account can be paid as a community keeper; this address is a contract.");
    // Now: a proof of a past block may be recorded, but can't make it eligible while it holds less.
    expect(otherAddressText(standing({ balance: 598n * SPX }))).toBe("It holds 598 of the 690 SPX now, so a proof of it can't make it a community keeper.");
    expect(otherAddressText(standing({ balance: null }))).toBe("That address's standing couldn't be read, so no proof was built.");
    expect(otherAddressText({ state: "not-deployed", registry: REGISTRY, holder: ME, block: null, chainTime: null })).toMatch(/registry isn't on this network/);
  });

  /**
   * Paste a proof was drawn whatever the standing, and sent whatever it said:
   * a smart-contract wallet could pay about 680,000 gas for a proof the
   * registry records and `isEligible` never honours (the Guard leaves that to
   * the panel). It now sends only what Prove my SPX would.
   */
  it("sends a pasted proof only for an ordinary account holding 690 SPX now, as Prove my SPX would", () => {
    expect(pasteRefusalText(standing())).toBeNull();
    expect(pasteRefusalText(standing({ isAccount: false, eligible: false, reason: "contract" }))).toBe(
      "Only an ordinary account can be paid as a community keeper; this address is a contract.",
    );
    expect(pasteRefusalText(standing({ isAccount: null }))).toBe("That address's standing couldn't be read, so no proof was built.");
    expect(pasteRefusalText(standing({ balance: 598n * SPX }))).toMatch(/^It holds 598 of the 690 SPX now/);
    expect(pasteRefusalText(null)).toBe("That address's standing couldn't be read, so nothing was sent.");
    expect(pasteRefusalText({ state: "not-deployed", registry: REGISTRY, holder: ME, block: null, chainTime: null })).toMatch(/registry isn't on this network/);
  });

  it("says what proving publishes unless a proof is known to exist: one that couldn't be read may be the first", () => {
    expect(mayBeFirstProof(0n)).toBe(true);
    expect(mayBeFirstProof(null)).toBe(true);
    expect(mayBeFirstProof(undefined)).toBe(true);
    expect(mayBeFirstProof(NOW - DAY)).toBe(false);
    expect(mayBeFirstProof(NOW + 20n * DAY)).toBe(false);
  });

  it("dates a standing by this device's clock when told when it was read, and by the chain's otherwise", () => {
    const skew = 3n * DAY + 3_600n;
    const readAtMs = Number(NOW + skew) * 1000 + 999;
    expect(onThisDevice(NOW + DAY, { chainTime: NOW, readAtMs })).toBe(NOW + DAY + skew);
    expect(onThisDevice(NOW + DAY, { chainTime: null, readAtMs })).toBe(NOW + DAY);
    expect(onThisDevice(NOW + DAY, null)).toBe(NOW + DAY);
    expect(standingLines(standing(), readAtMs).proof).toBe(`Its proof is valid until ${whenText(NOW + 20n * DAY + skew)}.`);
    expect(standingLines(standing()).proof).toBe(`Its proof is valid until ${whenText(NOW + 20n * DAY)}.`);
    const result = { status: "success" as const, validUntil: NOW + 30n * DAY, fee: 1n };
    expect(proofResultText(result, { chainTime: NOW, readAtMs })).toBe(`Proven: valid until ${whenText(NOW + 30n * DAY + skew)}.`);
  });
});

describe("sending a proof", () => {
  it("asks before going out publicly, and says plainly when it didn't go out or wasn't seen", () => {
    expect(proofPublicText("the wallet can't sign transactions.")).toBe(
      "Your wallet can't send this privately (the wallet can't sign transactions). Send it publicly? It moves no money, but it's seen before it's included.",
    );
    expect(PROOF_NOT_PUBLIC_TEXT).toBe("Not sent: your wallet can't send it privately, and it wasn't sent publicly.");
    expect(PROOF_UNSEEN_TEXT).toMatch(/^Sent, but not seen included yet\. .*check your wallet before proving again\.$/);
    for (const words of [proofPublicText("x"), PROOF_NOT_PUBLIC_TEXT, PROOF_UNSEEN_TEXT]) {
      expect(words).not.toMatch(/\bAPR\b|\bAPY\b|yield|reward/i);
    }
  });
});

describe("links", () => {
  it("build a docs page from the release's source, and none without one", () => {
    expect(sourceDocUrl("docs/KEEPER.md", "becoming-a-community-keeper", "https://github.com/someone/spdex.git")).toBe(
      "https://github.com/someone/spdex/blob/HEAD/docs/KEEPER.md#becoming-a-community-keeper",
    );
    expect(keeperDocsUrl("https://github.com/someone/spdex/")).toBe("https://github.com/someone/spdex/blob/HEAD/docs/KEEPER.md#becoming-a-community-keeper");
    expect(proofDocsUrl("https://github.com/someone/spdex")).toBe("https://github.com/someone/spdex/blob/HEAD/docs/RPC-RUNBOOK.md#proving-spx-held-eth_getproof");
    expect(keeperDocsUrl(null)).toBeNull();
    expect(proofDocsUrl(null)).toBeNull();
  });
});

describe("an address typed in", () => {
  it("is 0x and 40 hex digits, and a mixed-case one must match its checksum", () => {
    expect(parseTypedAddress(" 0xb0072e684e532bd1dcc442b5ed22097db205bb8e ")).toEqual({ address: "0xb0072e684e532bd1dcc442b5ed22097db205bb8e" });
    expect(parseTypedAddress("0xB0072E684E532BD1DCC442B5ED22097DB205BB8E")).toEqual({ address: "0xb0072e684e532bd1dcc442b5ed22097db205bb8e" });
    expect(parseTypedAddress("0xb0072E684e532bd1dcc442b5ed22097db205bb8e")).toEqual({
      error: "That address's capital letters don't match its checksum: check it was copied whole.",
    });
    expect(parseTypedAddress("0xb0072e")).toEqual({ error: "That isn't an address: 0x and 40 hex digits." });
    expect(parseTypedAddress("vitalik.eth")).toEqual({ error: "That isn't an address: 0x and 40 hex digits." });
  });
});

describe("a proof that couldn't be built", () => {
  it("is said in words, and a refusal of eth_getProof is left to its own path", () => {
    expect(proofErrorText(new ProofUnavailableError(26_000_000n, new Error("method not found")))).toBeNull();
    expect(proofErrorText(new HoldingBelowMinimumError(ME, 26_000_000n, 120n * SPX))).toBe("At block 26,000,000 it held 120 SPX; proving takes 690.");
    expect(proofErrorText(new HeaderHashMismatchError(26_000_000n, `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`))).toBe(
      "Your network service's block 26,000,000 doesn't hash to its own hash, so no proof was built from it. Either the service answered wrongly, or Ethereum's blocks have changed in a way this copy of spDEX doesn't know: try another service, or a newer spDEX.",
    );
    expect(proofErrorText(new PastedProofError("the pasted text has no proof in it"))).toBe("The pasted text has no proof in it.");
    expect(proofErrorText(new BlockOutOfReachError(1n, 10_000n))).toMatch(/^Block 1 is too old to prove/);
    expect(proofErrorText(new Error("rate limited."))).toBe("Couldn't build the proof (rate limited).");
  });

  it("when refused by the safety check, carries the check's own words for a proof's own refusals", () => {
    expect(proofRefusalText({ code: "SIMULATION_REVERTED", message: "the proof would revert: the proof does not match the block's state", detail: { reason: "ProofMismatch" } })).toBe(
      "The proof would revert: the proof does not match the block's state.",
    );
    expect(
      proofRefusalText({
        code: "VAULT_MALFORMED",
        message: "your network service says block 5 is 0x01, not 0x02: the proof is built against another block",
        detail: { blockNumber: "5", expected: "0x01", actual: "0x02" },
      }),
    ).toBe("Your network service says block 5 is 0x01, not 0x02: the proof is built against another block.");
    // The vault codes' other refusals of a proof: a proof's words, never a vault's or its money's.
    expect(proofRefusalText({ code: "VAULT_MALFORMED", message: "the proof is sent to 0x…" })).toBe(
      "This didn't match the proof that was built: its block, the address it proves, or where it goes.",
    );
    expect(proofRefusalText({ code: "VAULT_NOT_DELIVERED", message: "the registry records no proof", detail: { registry: REGISTRY } })).toBe(
      "The test-run shows the SPX holder registry recording no proof from this.",
    );
    for (const code of ["VAULT_MALFORMED", "VAULT_NOT_DELIVERED"] as const) {
      expect(proofRefusalText({ code, message: "x" })).not.toMatch(/vault|money/i);
    }
    // Anything else reads as it does everywhere.
    expect(proofRefusalText({ code: "UNEXPECTED_APPROVAL", message: "the proof has 0x… grant an allowance" })).toBe(
      guardSentence("UNEXPECTED_APPROVAL"),
    );
  });
});

describe("the paste path", () => {
  it("shows the two requests, as curl commands for another service the person picks, at the block their own service named", () => {
    const commands = pasteCommands(ME, 26_000_000n);
    const requests = proofRequests(ME, 26_000_000n);
    expect(commands).toEqual(requests.map((r) => `curl -sS -X POST <another service> -H 'content-type: application/json' --data '${r.body}'`));
    expect(commands[0]).toContain('"method":"eth_getBlockByNumber","params":["0x18cba80",false]');
    expect(commands[1]).toContain('"method":"eth_getProof"');
    // No service named: the page never fetches from one.
    for (const command of commands) expect(command).not.toMatch(/https?:\/\//);
  });
});

describe("the transaction", () => {
  const proof: HolderProof = {
    holder: "0xB0072E684E532BD1DCC442B5ED22097DB205BB8E" as Address,
    blockNumber: 26_000_000n,
    blockHash: `0x${"ab".repeat(32)}`,
    timestamp: NOW,
    balance: 1_210n * SPX,
    header: "0xf90200",
    accountProof: ["0x01", "0x02"],
    storageProof: ["0x03"],
    validUntil: NOW + 30n * DAY,
  };

  it("is the proof as the Guard's prove intent, sent and paid for by the connected wallet", () => {
    expect(proveIntent(proof, "0x00000000000000000000000000000000000000AA" as Address, 690069)).toEqual({
      version: 1,
      action: "prove",
      chainId: 690069,
      account: ME,
      holder: "0xb0072e684e532bd1dcc442b5ed22097db205bb8e",
      blockNumber: 26_000_000n,
      blockHash: `0x${"ab".repeat(32)}`,
      header: "0xf90200",
      accountProof: ["0x01", "0x02"],
      storageProof: ["0x03"],
    });
  });

  // `Proven(address indexed holder, uint256 indexed blockNumber, uint256 balance, uint64 validUntil)`, encoded by hand.
  const hexOf = (text: string) => `0x${[...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const PROVEN = transactionHash(hexOf("Proven(address,uint256,uint256,uint64)"));
  const word = (v: bigint) => v.toString(16).padStart(64, "0");
  const provenLog = (from: Address, holder: Address, validUntil: bigint) => ({
    address: from,
    topics: [PROVEN, `0x${holder.slice(2).padStart(64, "0")}`, `0x${word(26_000_000n)}`],
    data: `0x${word(1_210n * SPX)}${word(validUntil)}`,
  });
  const receipt = (logs: ReturnType<typeof provenLog>[], status = "0x1") => ({
    from: ME,
    status,
    blockNumber: "0x18cba81",
    blockHash: `0x${"cd".repeat(32)}`,
    gasUsed: "0xa0000",
    effectiveGasPrice: "0x3b9aca00",
    logs: logs.map((log, i) => ({ ...log, logIndex: `0x${i.toString(16)}` })),
  });
  const holder = proof.holder.toLowerCase() as Address;

  it("is read back from the registry's own Proven, never a look-alike, once its receipt arrives", async () => {
    let asked = 0;
    let time = 0;
    const clock = { sleep: async (ms: number) => void (time += ms), now: () => time };
    const until = NOW + 30n * DAY;
    const rpc: JsonRpc = async () => (++asked < 2 ? null : receipt([provenLog(ME, holder, 1n), provenLog(REGISTRY, holder, until)]));
    const result = await waitForProof(rpc, { hash: `0x${"ef".repeat(32)}` as Hex, registry: REGISTRY, holder }, { timeoutMs: 10_000, ...clock });
    expect(asked).toBe(2);
    expect(result).toEqual({ status: "success", validUntil: until, fee: 655_360n * 10n ** 9n });
    expect(proofResultText(result!)).toMatch(/^Proven: valid until [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}\.$/);
    // Gives up at the deadline: not failed, since it may still land.
    expect(await waitForProof(async () => null, { hash: `0x${"ef".repeat(32)}` as Hex, registry: REGISTRY, holder }, { timeoutMs: 5_000, ...clock })).toBeNull();
  });

  it("says when it reverted, or when the registry recorded nothing for this address", () => {
    const parse = (raw: ReturnType<typeof receipt>) => ({
      hash: `0x${"ef".repeat(32)}` as Hex,
      from: ME,
      status: raw.status === "0x1" ? ("success" as const) : ("reverted" as const),
      blockNumber: 1n,
      blockHash: raw.blockHash as Hex,
      fee: 1n,
      logs: raw.logs,
    });
    expect(proofResultOf(parse(receipt([], "0x0")), { registry: REGISTRY, holder })).toEqual({ status: "reverted", validUntil: null, fee: 1n });
    expect(proofResultText({ status: "reverted", validUntil: null, fee: 1n })).toBe(
      "The proof reverted on chain: nothing was recorded, and its network fee was spent.",
    );
    const other = proofResultOf(parse(receipt([provenLog(REGISTRY, ME, NOW)])), { registry: REGISTRY, holder });
    expect(other.validUntil).toBeNull();
    expect(proofResultText(other)).toBe("Sent and included, but the registry recorded no proof for this address.");
  });
});

describe("words", () => {
  it("say what proving costs and makes public, and call keeping paid work, never a return", () => {
    expect(KEEPING_INTRO).toBe("Community keepers make other people's buys and are paid for each one; holding 690 SPX is the entry bar.");
    expect(PROOF_COST_TEXT).toBe("One transaction of about 680,000 gas, once every 30 days. It moves no money.");
    expect(PROVING_PUBLISHES_TEXT).toContain("for good, that this address held at least 690 SPX");
    for (const text of [KEEPING_INTRO, PROOF_COST_TEXT, PROVING_PUBLISHES_TEXT, PROVE_OTHER_TEXT, PROOF_REFUSED_TEXT, PASTE_INTRO_TEXT, PROOF_ONE_SERVICE_TEXT]) {
      expect(text).not.toMatch(/\bAPR\b|\bAPY\b|yield|projected|reward|https?:\/\//i);
    }
  });
});
