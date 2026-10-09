/*
 * Test tip entries, for a local fork only.
 *
 * These are anvil's published development accounts (#1, #2, #3), whose
 * private keys are public. They are not people. They exist so the tip flow can
 * be exercised end to end on a fork, where a tip can be watched arriving.
 *
 * On any real network a tip to one of these is money anyone can take, so the
 * host keeps them out three times over:
 *
 *   1. `apps/web/src/lib/engine.ts` loads this module only when the network is
 *      one of `PLACEHOLDER_CHAINS` (`@spdex/core`, devAccounts.ts).
 *   2. It is in `PLACEHOLDER_REGISTRIES` (`apps/web/src/lib/tipRow.ts`), so a
 *      picker withholds its entries anywhere else even if it were loaded.
 *   3. The addresses are in `PUBLIC_DEV_ACCOUNTS`, which "My tip list"
 *      refuses, `tippableRecipients` skips and TipGuard refuses outside those
 *      networks, whatever any list says.
 *
 * The real list is `modules/tiplist-spx-community`, and holds real entries
 * only. Nothing here moves there.
 *
 * Like every registry: no capabilities, no reads, no clock, no randomness.
 */

const spdexModule = {
  apiVersion: "1.0.0",

  async listRecipients() {
    return [
      {
        id: "dev-fund",
        address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        label: "Placeholder: dev fund",
        handle: "@spx_placeholder_1",
        note: "anvil account #1 — a development address, not a real recipient",
        kind: "other",
        test: true,
      },
      {
        id: "dev-memes",
        address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
        label: "Placeholder: meme fund",
        handle: "@spx_placeholder_2",
        note: "anvil account #2 — a development address, not a real recipient",
        kind: "other",
        test: true,
      },
      {
        id: "dev-translations",
        address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
        label: "Placeholder: translations",
        handle: "@spx_placeholder_3",
        note: "anvil account #3 — a development address, not a real recipient",
        kind: "other",
        test: true,
      },
    ];
  },
};

globalThis.spdexModule = spdexModule;
