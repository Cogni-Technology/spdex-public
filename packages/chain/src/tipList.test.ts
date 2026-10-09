/**
 * The rules a shipped tip list is held to, and a listed person's signed claim.
 *
 * Every address here is made up (runs of hex with distinct ends), and the key
 * that signs is a test key: no real person's address is in this file.
 */

import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tipClaimMessage } from "@spdex/core";
import {
  addressEnds,
  addressInputProblem,
  hasDuplicateIds,
  isChecksummed,
  shippedIdProblems,
  tipClaimSigned,
  tipListProblems,
} from "./tipList.js";

/** A made-up address with these first and last four hex digits, checksummed. */
const fake = (first: string, last: string) => getAddress(`0x${first}${"abcdef".repeat(5)}ab${last}`);

const artist = {
  id: "example-artist",
  address: fake("a1b2", "c3d4"),
  label: "Example Artist",
  handle: "@example_artist",
  note: "Draws a weekly comic",
  kind: "creator",
  listed: "2026-09",
  proof: "https://example.com/example_artist/status/1",
};
const cause = {
  id: "example-cause",
  address: fake("b1b2", "d3d4"),
  label: "Example Cause",
  kind: "cause",
  proof: "https://example.org/post",
};

describe("addresses", () => {
  it("accepts all-lowercase, all-uppercase and correct EIP-55, and refuses a wrong checksum", () => {
    const good = fake("a1b2", "c3d4");
    expect(addressInputProblem(good)).toBeNull();
    expect(addressInputProblem(good.toLowerCase())).toBeNull();
    expect(addressInputProblem(`0x${good.slice(2).toUpperCase()}`)).toBeNull();
    // One letter's case flipped: exactly what a checksum is for.
    const flipped = good.replace(/[a-f]/, (c) => c.toUpperCase()).replace(/[A-F](?=[^A-F]*$)/, (c) => c.toLowerCase());
    expect(flipped).not.toBe(good);
    expect(addressInputProblem(flipped)).toBe("checksum");
    expect(addressInputProblem("0x1234")).toBe("not-an-address");
    expect(addressInputProblem("example.eth")).toBe("not-an-address");
  });

  it("tells a checksummed address, and reads its ends", () => {
    expect(isChecksummed(fake("a1b2", "c3d4"))).toBe(true);
    expect(isChecksummed(fake("a1b2", "c3d4").toLowerCase())).toBe(false);
    expect(addressEnds(fake("A1B2", "C3D4"))).toEqual({ first: "a1b2", last: "c3d4" });
  });
});

describe("tipListProblems", () => {
  it("passes a well-formed list, and an empty one", () => {
    expect(tipListProblems([])).toEqual([]);
    expect(tipListProblems([artist, cause])).toEqual([]);
  });

  it("refuses an address that isn't checksummed", () => {
    expect(tipListProblems([{ ...artist, address: artist.address.toLowerCase() }]).join()).toMatch(/not EIP-55/);
  });

  it("refuses two entries that start or end alike, or share an address", () => {
    expect(tipListProblems([artist, { ...cause, address: fake("a1b2", "eeee") }]).join()).toMatch(/starts like example-artist/);
    expect(tipListProblems([artist, { ...cause, address: fake("eeee", "c3d4") }]).join()).toMatch(/ends like example-artist/);
    expect(tipListProblems([artist, { ...cause, address: artist.address }]).join()).toMatch(/same address/);
  });

  it("refuses a public development account unless the list is the dev fixtures", () => {
    const dev = { ...cause, address: getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8") };
    expect(tipListProblems([dev]).join()).toMatch(/public development account/);
    expect(tipListProblems([dev], { allowDevAccounts: true })).toEqual([]);
  });

  it("wants a unique id on every entry, and a replacedBy that names one", () => {
    expect(tipListProblems([{ ...artist, id: undefined }]).join()).toMatch(/no id/);
    expect(tipListProblems([artist, { ...cause, id: "example-artist" }]).join()).toMatch(/used 2 times/);
    const retired = { ...cause, retired: "Moved to a new address", replacedBy: "example-artist" };
    expect(tipListProblems([artist, retired])).toEqual([]);
    expect(tipListProblems([artist, { ...retired, replacedBy: "nobody" }]).join()).toMatch(/names no entry/);
    expect(tipListProblems([artist, { ...cause, replacedBy: "example-artist" }]).join()).toMatch(/not retired/);
  });

  it("refuses a proof that isn't https, a name like an address, and hidden characters", () => {
    expect(tipListProblems([{ ...artist, proof: "http://example.com/x" }]).join()).toMatch(/https/);
    expect(tipListProblems([{ ...artist, label: "Pay 0xa1b2 here" }]).join()).toMatch(/look like an address/);
    expect(tipListProblems([{ ...artist, label: "Example​Artist" }]).join()).toMatch(/hidden characters/);
    expect(tipListProblems([{ ...artist, note: "evil‮gnp.exe" }]).join()).toMatch(/note has hidden/);
  });

  it("holds the real list to a note and a proof link on every entry, and no test entries", () => {
    expect(tipListProblems([artist, { ...cause, note: "A fund for SPX translations" }], { real: true })).toEqual([]);
    const problems = tipListProblems([{ ...artist, note: undefined, proof: undefined, test: true }], { real: true }).join();
    expect(problems).toMatch(/no note/);
    expect(problems).toMatch(/no proof/);
    expect(problems).toMatch(/test entry/);
  });

  it("lets only spDEX's own address, named by the caller, go without a proof, and only as a builder", () => {
    const own = { id: "spdex-own", address: fake("c1c2", "e3e4"), label: "spDEX donations", note: "spDEX's own", kind: "builder" };
    // Without the caller naming it, it is held to the proof rule like anyone.
    expect(tipListProblems([own], { real: true }).join()).toMatch(/no proof/);
    expect(tipListProblems([own], { real: true, own: own.address.toLowerCase() })).toEqual([]);
    // Anyone else still needs one, own named or not.
    expect(tipListProblems([{ ...artist, proof: undefined }], { real: true, own: own.address }).join()).toMatch(/no proof/);
    expect(tipListProblems([{ ...own, kind: "creator" }], { real: true, own: own.address }).join()).toMatch(/must be kind "builder"/);
  });

  it("refuses an entry a tip would be lost at: zero, burn, Permit2, a token or a known contract", () => {
    for (const [address, words] of [
      ["0x0000000000000000000000000000000000000000", /zero address/],
      ["0x000000000000000000000000000000000000dEaD", /burn address/],
      ["0x000000000022D473030F116dDEE9F6B43aC78BA3", /Permit2/],
      ["0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C", /SPX token contract/],
      ["0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", /uniV3SwapRouter02/],
    ] as const) {
      expect(tipListProblems([{ ...artist, address: getAddress(address) }]).join(), address).toMatch(words);
    }
    // And whatever the caller adds (the web app's vault factory, say).
    const factory = fake("f1f2", "f3f4");
    expect(tipListProblems([{ ...artist, address: factory }], { refuse: new Map([[factory.toLowerCase(), "the vault factory"]]) }).join()).toMatch(
      /the vault factory, where a tip would be lost/,
    );
  });

  it("refuses two current entries whose names read the same, and allows a retired one its replacement's name", () => {
    const imitation = { ...cause, label: "Exаmple  ARTIST" }; // a Cyrillic "а", other case and spacing
    expect(tipListProblems([artist, imitation]).join()).toMatch(/example-cause: the name reads like example-artist's/);
    const moved = { ...cause, label: "Example Artist", retired: "Moved to a new address", replacedBy: "example-artist" };
    expect(tipListProblems([artist, moved])).toEqual([]);
  });

  it("holds each id to the address it first shipped with", () => {
    const shipped = { "example-artist": artist.address, "example-cause": cause.address };
    expect(shippedIdProblems([artist, cause], shipped)).toEqual([]);
    // Deleting an entry after its release as retired is allowed.
    expect(shippedIdProblems([artist], shipped)).toEqual([]);
    expect(shippedIdProblems([{ ...artist, address: fake("eeee", "ffff") }], shipped).join()).toMatch(/a new address needs a new id/);
    expect(shippedIdProblems([{ ...artist, id: "example-new" }], shipped).join()).toMatch(/not recorded in shipped-ids.json/);
  });

  it("tells a list with a repeated id apart for the host", () => {
    expect(hasDuplicateIds([{ id: "a" }, { id: "b" }, {}])).toBe(false);
    expect(hasDuplicateIds([{ id: "a" }, { id: "a" }])).toBe(true);
  });
});

describe("a signed claim", () => {
  // A test key, not anyone's: the address it controls is made up by it.
  const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const entry = (message: string, signature: string) => ({
    ...artist,
    address: signer.address,
    claim: { message, signature },
  });

  it("is SIGNED only when it recovers the entry's own address, over this entry's message", async () => {
    const message = tipClaimMessage(signer.address, "@example_artist", "2026-09");
    const signature = await signer.signMessage({ message });
    const good = entry(message, signature);
    expect(tipListProblems([good])).toEqual([]);
    expect(await tipClaimSigned(good as never)).toBe(true);

    // Signed by someone else for this address: recovers the wrong signer.
    const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
    expect(await tipClaimSigned(entry(message, await other.signMessage({ message })) as never)).toBe(false);

    // The right key, over another handle's message.
    const elsewhere = tipClaimMessage(signer.address, "@someone_else", "2026-09");
    const moved = entry(elsewhere, await signer.signMessage({ message: elsewhere }));
    expect(await tipClaimSigned(moved as never)).toBe(false);
    expect(tipListProblems([moved]).join()).toMatch(/not the one for this entry/);

    // A signature that doesn't parse.
    expect(await tipClaimSigned(entry(message, `0x${"00".repeat(65)}`) as never)).toBe(false);
  });
});
