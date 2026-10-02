/**
 * The Collective DCA panel and Trust and exits, rendered as the page first
 * draws them: which states show what, and that nothing reads the chain or
 * prints a domain on the way. Reads are replaced at `@spdex/vault`, and a
 * cached read is how a state with figures is drawn without a browser.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JsonRpc } from "@spdex/chain";
import { recommendedConfig } from "@spdex/config";
import type { Address } from "@spdex/core";
import type { PlatformRead, PlatformVault, VaultTerms } from "@spdex/vault";

const readPlatform = vi.hoisted(() => vi.fn());
vi.mock("@spdex/vault", async (importOriginal) => ({ ...(await importOriginal<typeof import("@spdex/vault")>()), readPlatform }));

const { MAINNET_FACTORY, checksumAddress } = await import("@spdex/vault");
const { planFromVault } = await import("../../lib/dca/vault.js");
const { loadPlatform } = await import("../../lib/network/platform.js");
const { CollectiveDca } = await import("./CollectiveDca.js");
const { WalkawayPanel } = await import("./WalkawayPanel.js");
const { VerifyBuild } = await import("./VerifyBuild.js");

const FORK = 690069;
const ETHER = 10n ** 18n;
const address = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const VAULT = "0x5b38da6a701c568545dcfcb03fcb875f56beddc4" as Address;

const terms: VaultTerms = {
  tokenOut: "0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c",
  pair: address(1),
  oraclePool: address(2),
  amountPerBuy: ETHER / 100n,
  interval: 86_400n,
  maxBuys: 10n,
  startAt: 0n,
  keeperReward: ETHER / 10_000n,
  maxSlippageBps: 200n,
};

function vault(n: number, overrides: Partial<PlatformVault> = {}): PlatformVault {
  return { vault: address(0x1000 + n), owner: address(0xa0), terms, closed: false, buysDone: 2n, totalOut: 5_000n * 10n ** 8n, wethBalance: ETHER / 10n, ...overrides };
}

function read(vaults: PlatformVault[], unreadable: Address[] = []): PlatformRead {
  const count = BigInt(vaults.length + unreadable.length);
  return {
    block: 26_001_248n,
    requests: 13,
    deployments: [{ id: "v1", factory: MAINNET_FACTORY, state: "read", count, listed: Number(count), unreadable, vaults }],
  };
}

const endpoint = (): JsonRpc => async () => {
  throw new Error("rendering must not read the chain");
};

function collective(rpc: JsonRpc | null, chainId = FORK): string {
  return renderToStaticMarkup(
    createElement(CollectiveDca, { rpc, chainId }),
  );
}

/** The visible text of some markup, tags dropped and entities decoded, as a reader would see it. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}

describe("CollectiveDca", () => {
  beforeEach(() => readPlatform.mockReset());

  it("says vaults aren't offered on a network they aren't, with nothing to read", () => {
    const html = collective(endpoint(), 11155111);
    expect(text(html)).toContain("Vaults aren't offered on Sepolia test network.");
    expect(html).not.toContain("collective-caveat");
    expect(readPlatform).not.toHaveBeenCalled();
  });

  it("starts folded to its title, with nothing read, and the caveat in place for when it opens", () => {
    const html = collective(endpoint());
    expect(html).toMatch(/<details class="spdex-fold" data-testid="collective-open">/);
    expect(html).toMatch(/data-testid="collective-open-summary"><h2 class="spdex-panel__title">Collective DCA: auto-buy vaults<\/h2>/);
    expect(html).not.toContain("data-block");
    expect(html).not.toContain("collective-buys");
    // What's counted, folded: in the page for when it opens, one tap further.
    expect(html).toContain('data-testid="collective-counted"');
    expect(text(html)).toContain(
      "Only vaults from spDEX's factory. Swaps and confirm-each-buy plans carry no spDEX marker — one would label every user. Addresses aren't people.",
    );
    expect(text(html)).toContain("Every spDEX vault, read from chain.");
    expect(readPlatform).not.toHaveBeenCalled();
  });

  it("in a tile, drops its fold and title, keeps its test id, and reads nothing while closed", () => {
    const html = renderToStaticMarkup(createElement(CollectiveDca, { rpc: endpoint(), chainId: FORK, open: false }));
    expect(html).toContain('data-testid="collective-panel"');
    expect(html).not.toContain("collective-open");
    expect(html).not.toContain("Collective DCA: auto-buy vaults");
    expect(readPlatform).not.toHaveBeenCalled();
  });

  it("shows the six figures, the made count, the block and the caveat once read, and no money", async () => {
    const rpc = endpoint();
    readPlatform.mockResolvedValue(read([vault(0), vault(1, { closed: true }), vault(2, { buysDone: 10n })]));
    await loadPlatform(rpc, FORK);
    const html = collective(rpc);
    expect(html).toContain('data-block="26001248"');
    for (const id of ["buys", "spx", "open", "owners", "eth", "fees", "committed", "held", "footer", "caveat"]) {
      expect(html).toContain(`data-testid="collective-${id}"`);
    }
    expect(html).toMatch(/data-testid="collective-made" data-value="3"/);
    expect(text(html)).toContain("3 made · 1 finished · 1 closed");
    expect(text(html)).toContain("Read at block 26,001,248 through your network service (13 reads). These reads don't name your address.");
    expect(text(html)).not.toMatch(/[$€£¥]/);
    expect(html).not.toContain("collective-partial");
    expect(html).not.toContain("collective-read-more");
  });

  it("puts at least on every figure and says how many vaults couldn't be read", async () => {
    const rpc = endpoint();
    readPlatform.mockResolvedValue(read([vault(0)], [address(0x99)]));
    await loadPlatform(rpc, FORK);
    const html = collective(rpc);
    expect(text(html)).toMatch(/Buys made at least 2/);
    expect(text(html)).toContain("1 of 2 vaults couldn't be read just now; these totals leave them out.");
  });

  it("shows a sentence, not a grid of zeros, where the factory isn't deployed", async () => {
    const rpc = endpoint();
    readPlatform.mockResolvedValue({ block: 5n, requests: 2, deployments: [{ id: "v1", factory: MAINNET_FACTORY, state: "not-deployed" }] });
    await loadPlatform(rpc, 1);
    const html = collective(rpc, 1);
    expect(text(html)).toContain("The vault factory isn't deployed on Ethereum, so there's no vault activity to read here.");
    expect(html).not.toContain("collective-buys");
    expect(html).toContain('data-block="5"');
  });
});

describe("WalkawayPanel", () => {
  const config = {
    ...recommendedConfig(),
    chainId: FORK,
    dca: { ...recommendedConfig().dca, plans: [planFromVault({ vault: VAULT, terms, chainId: FORK })] },
  };
  const panel = (chainId: number, account: Address | null = null, rpc: JsonRpc | null = endpoint()) =>
    renderToStaticMarkup(createElement(WalkawayPanel, { config, rpc, chainId, account }));

  it("opens with one line, and folds its two parts, one open at a time", () => {
    const html = panel(FORK);
    expect(text(html)).toContain("Check this build, or leave with your vaults.");
    expect(html).toMatch(/<details class="spdex-disclosure" name="trust" data-testid="walkaway-verify">/);
    expect(html).toMatch(/<details class="spdex-disclosure" name="trust" data-testid="walkaway-exits">/);
    expect(html).toContain('data-testid="walkaway-verify"');
    expect(html).toContain('data-testid="walkaway-exits"');
    expect(html).toContain('data-testid="verify-build"');
    expect(html).toContain('data-testid="walkaway-list"');
  });

  it("prints the factory and this browser's vaults in full and checksummed, and close()'s calldata", () => {
    const html = text(panel(FORK));
    expect(html).toContain("Without spDEX: this factory lists every vault (vaultsPage); each vault's owner() says whose it is.");
    expect(html).toContain(`${checksumAddress(MAINNET_FACTORY)} Copy`);
    expect(html).toContain(checksumAddress(VAULT));
    expect(html).toContain("send 0 ETH to the vault with data 0x43d726d6 (that is close())");
    expect(html).toContain("spDEX never asks you to do this. Do it only for a vault whose owner() is your address.");
    // No explorer spDEX can vouch for on a fork.
    expect(html).not.toContain("Explorer ↗");
  });

  it("links vaults to an explorer on Ethereum only", () => {
    const html = renderToStaticMarkup(
      createElement(WalkawayPanel, { config: { ...config, dca: { ...config.dca, plans: [planFromVault({ vault: VAULT, terms, chainId: 1 })] } }, rpc: endpoint(), chainId: 1, account: null }),
    );
    expect(html).toContain(`href="https://etherscan.io/address/${VAULT}"`);
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("names no domain it wasn't given", () => {
    expect(panel(FORK)).not.toMatch(/spdex\.io/);
    expect(panel(1)).not.toMatch(/spdex\.io/);
  });

  it("offers the factory-list search only with a wallet and a network service, and says why not", () => {
    expect(text(panel(FORK))).toContain("Connect a wallet to look for its vaults.");
    expect(panel(FORK)).toMatch(/<button[^>]*disabled=""[^>]*data-testid="vault-search-list-run"/);
    expect(text(panel(FORK, address(0xab), null))).toContain("Choose a network service first.");
    const ready = text(panel(FORK, address(0xab)));
    expect(ready).toContain("For services that limit log searches: reads every vault's owner instead");
  });

  it("ends each line that names a place with the button that goes there", () => {
    const html = panel(FORK);
    expect(html).toContain('data-testid="goto-networkService"');
    expect(html).toContain('data-testid="goto-sending"');
    expect(html).toContain('data-testid="goto-settingsFile"');
    expect(html).toContain('data-testid="goto-activityCsv"');
    expect(text(html)).not.toMatch(/Expert →|\bin Expert\b/);
  });

  it("in the Settings tile, drops its fold and title and keeps its test id", () => {
    const html = renderToStaticMarkup(createElement(WalkawayPanel, { config, rpc: endpoint(), chainId: FORK, account: null, open: true }));
    expect(html).toContain('data-testid="walkaway-panel"');
    expect(html).not.toContain("walkaway-open");
    expect(text(html)).not.toContain("Trust and exits");
  });

  it("leaves the vault lines out where vaults aren't offered", () => {
    const html = panel(11155111);
    expect(text(html)).toContain("Vaults aren't offered on Sepolia test network, so there are none to close or find here.");
    expect(html).not.toContain("walkaway-factory");
    expect(html).not.toContain("0x43d726d6");
  });
});

describe("VerifyBuild", () => {
  const verify = (where: { origin: string; host: string; pathname: string } | null, source: string | null) =>
    renderToStaticMarkup(createElement(VerifyBuild, { where, source }));

  it("says where a web copy came from, and gives the commands when the build names its source", () => {
    const html = verify({ origin: "http://localhost:5199", host: "localhost:5199", pathname: "/" }, "https://example.org/spdex.git");
    expect(text(html)).toContain("This copy came from http://localhost:5199. A web server can change what it sends at any time");
    expect(text(html)).toContain("git clone https://example.org/spdex.git spdex && cd spdex");
    expect(text(html)).toContain("pnpm ipfs:cid");
    expect(html).not.toContain("verify-build-no-source");
  });

  it("says the build names no source instead of showing a stand-in", () => {
    const html = verify({ origin: "http://localhost:5199", host: "localhost:5199", pathname: "/" }, null);
    expect(text(html)).toContain("This build doesn't say where its source is published.");
    expect(html).not.toContain("git clone");
  });

  it("warns about shared storage on a gateway path", () => {
    const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    const html = verify({ origin: "https://ipfs.io", host: "ipfs.io", pathname: `/ipfs/${cid}/` }, null);
    expect(text(html)).toContain(`This page was loaded from the address /ipfs/${cid}.`);
    expect(html).toContain('data-testid="verify-build-shared-gateway"');
  });
});
