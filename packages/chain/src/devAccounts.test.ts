/**
 * `PUBLIC_DEV_ACCOUNTS` (in `@spdex/core`, as plain data) against a fresh
 * derivation: the first twenty accounts of the published test mnemonic.
 * Here rather than in core because this is where viem is.
 */

import { describe, expect, it } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
import { PUBLIC_DEV_ACCOUNTS } from "@spdex/core";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";

describe("PUBLIC_DEV_ACCOUNTS", () => {
  it("is exactly the first twenty accounts of the test mnemonic, in order", () => {
    const derived = Array.from({ length: 20 }, (_, index) =>
      mnemonicToAccount(TEST_MNEMONIC, { addressIndex: index }).address.toLowerCase(),
    );
    expect([...PUBLIC_DEV_ACCOUNTS]).toEqual(derived);
  });
});
