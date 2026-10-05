/**
 * The Collective DCA panel, Trust and exits, and Help run's Community keeping,
 * rendered as the page first draws them: which states show what, and that
 * nothing reads the chain or prints a domain on the way. Reads are replaced at
 * `@spdex/vault`, and a cached read is how a state with figures is drawn
 * without a browser; Community keeping's states are drawn from props
 * (`KeepingView`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JsonRpc } from "@spdex/chain";
import { recommendedConfig } from "@spdex/config";
import { rejected, type Address, type GuardVerdict, type Hex } from "@spdex/core";
import type { HolderStatus, PlatformRead, PlatformVault, VaultTerms } from "@spdex/vault";

const readPlatform = vi.hoisted(() => vi.fn());
vi.mock("@spdex/vault", async (importOriginal) => ({ ...(await importOriginal<typeof import("@spdex/vault")>()), readPlatform }));

const { DEPLOYMENTS, MAINNET_FACTORY, MIN_SPX, PROOF_LAPSE_WARNING_SECONDS, V1_MAINNET_FACTORY, checksumAddress, proofRequests } = await import("@spdex/vault");
const { planFromVault } = await import("../../lib/dca/vault.js");
const { loadPlatform } = await import("../../lib/network/platform.js");
const { clockText } = await import("../../lib/money/format.js");
const { PROVING_PUBLISHES_TEXT, PROOF_REFUSED_TEXT, PROOF_UNSEEN_TEXT, whenText } = await import("../../lib/network/keeping.js");
const { CollectiveDca } = await import("./CollectiveDca.js");
const { WalkawayPanel } = await import("./WalkawayPanel.js");
const { VerifyBuild } = await import("./VerifyBuild.js");
const { CommunityKeeping, KeepingView } = await import("./CommunityKeeping.js");
const { HelpRunNetwork, HoldersFirst } = await import("./HelpRunNetwork.js");
const { REGISTRY_ADVISORY, REGISTRY_ADVISORY_TITLE } = await import("../../lib/dca/advisory.js");
const { default: helpRunSource } = await import("./HelpRunNetwork.tsx?raw");

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
  communityWindow: 1_800n,
  turnBuckets: 0n,
};

function vault(n: number, overrides: Partial<PlatformVault> = {}): PlatformVault {
  return {
    vault: address(0x1000 + n),
    release: "v2",
    owner: address(0xa0),
    terms,
    closed: false,
    buysDone: 2n,
    totalOut: 5_000n * 10n ** 8n,
    wethBalance: ETHER / 10n,
    windowBuys: 1n,
    ...overrides,
  };
}

/** v1's factory with nothing on it, and v2's with `vaults`: both read, as `readPlatform` reads them. */
function read(vaults: PlatformVault[], unreadable: Address[] = []): PlatformRead {
  const count = BigInt(vaults.length + unreadable.length);
  return {
    block: 26_001_248n,
    requests: 13,
    deployments: [
      { id: "v1", release: "v1", factory: V1_MAINNET_FACTORY, state: "read", count: 0n, listed: 0, unreadable: [], vaults: [] },
      { id: "v2", release: "v2", factory: MAINNET_FACTORY, state: "read", count, listed: Number(count), unreadable, vaults },
    ],
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
      "Only vaults from spDEX's factories. Swaps and confirm-each-buy plans carry no spDEX marker — one would label every user. Addresses aren't people.",
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
    for (const id of ["buys", "spx", "open", "owners", "eth", "fees", "committed", "held", "window", "footer", "caveat"]) {
      expect(html).toContain(`data-testid="collective-${id}"`);
    }
    // SPX holders' share of v2 buys inside their window: 3 of 14, rounded down.
    // One name for the figure, as the vault counts it: by whom it paid.
    expect(text(html)).toContain("v2 buys paid to community keepers 21% inside each buy's community window");
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
    // A share of a partial read is no figure at all: the row is left out, never shown as 0%.
    expect(html).not.toContain('data-testid="collective-window"');
  });

  it("shows a sentence, not a grid of zeros, where the factory isn't deployed", async () => {
    const rpc = endpoint();
    readPlatform.mockResolvedValue({
      block: 5n,
      requests: 2,
      deployments: [
        { id: "v1", release: "v1", factory: V1_MAINNET_FACTORY, state: "not-deployed" },
        { id: "v2", release: "v2", factory: MAINNET_FACTORY, state: "not-deployed" },
      ],
    });
    await loadPlatform(rpc, 1);
    const html = collective(rpc, 1);
    expect(text(html)).toContain("spDEX's vault factories aren't deployed on Ethereum, so there's no vault activity to read here.");
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

  it("prints both factories and this browser's vaults in full and checksummed, and close()'s calldata", () => {
    const html = text(panel(FORK));
    expect(html).toContain("Without spDEX: these factories list every vault (vaultsPage); each vault's owner() says whose it is.");
    expect(DEPLOYMENTS.map((d) => d.id)).toEqual(["v1", "v2"]);
    expect(html).toContain(`${checksumAddress(V1_MAINNET_FACTORY)} Copy`);
    expect(html).toContain(`${checksumAddress(MAINNET_FACTORY)} Copy`);
    expect(html).toContain("Anyone can make a due vault buy; on a v2 vault, SPX holders have first claim for a while.");
    // A vault buys without its owner either way: how to make one by hand,
    // execute(owner), is docs/WALKAWAY.md's, not a new line here.
    expect(panel(FORK)).not.toContain("walkaway-execute");
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

describe("Community keeping", () => {
  const ME = "0x00000000000000000000000000000000000000aa" as Address;
  const REGISTRY = "0x2c7f732a453fe0a4a65f36ac564ff16007b5610d" as Address;
  const SPX = 10n ** 8n;
  const NOW = 1_790_000_000n;
  const DAY = 86_400n;
  const SOURCE = { keeper: "https://example.org/spdex/blob/HEAD/docs/KEEPER.md#becoming-a-community-keeper", proofs: null };
  const noop = () => undefined;

  function standing(overrides: Partial<Extract<HolderStatus, { state: "read" }>> = {}): HolderStatus {
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

  const view = (props: Partial<Parameters<typeof KeepingView>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(KeepingView, {
        chainId: FORK,
        account: ME,
        standing: { kind: "read", status: standing() },
        prove: { kind: "idle" },
        other: { text: "", error: null },
        paste: { open: false, holder: ME, block: { kind: "unread" }, text: "", error: null },
        docs: SOURCE,
        onProveMine: noop,
        onContinue: noop,
        onCancel: noop,
        onPublic: noop,
        onOtherText: noop,
        onProveOther: noop,
        onPasteOpen: noop,
        onPasteText: noop,
        onPasteSend: noop,
        onReadAgain: noop,
        ...props,
      }),
    );

  /** An Engine whose every read fails the test: drawing the panel must ask nothing. */
  const engine = {
    rpc: endpoint(),
    vaultRegistry: REGISTRY,
    vaultFactory: MAINNET_FACTORY,
    vaultBatcher: DEPLOYMENTS[1]!.batcher,
    checkVaultProof: () => Promise.reject(new Error("rendering must not check a proof")),
    checkVaultBatch: () => Promise.reject(new Error("rendering must not check a batch")),
  };

  it("is one closed fold that reads nothing until opened, with or without private sending", () => {
    const fold = renderToStaticMarkup(
      createElement(CommunityKeeping, { engine, chainId: FORK, account: ME, submitter: { mode: "wallet", url: null } }),
    );
    expect(fold).toMatch(/<details class="spdex-disclosure" data-testid="keeper-panel">/);
    expect(text(fold)).toContain("Community keeping");
    // Nothing inside yet: it mounts, and reads, when opened.
    expect(fold).not.toContain('data-testid="keeper"');
    for (const mode of ["wallet", "private"] as const) {
      const html = renderToStaticMarkup(
        createElement(HelpRunNetwork, {
          engine,
          chainId: FORK,
          account: ME,
          walletChainOk: true,
          submitter: { mode, url: mode === "private" ? "https://rpc.flashbots.net/fast" : null },
          pricing: null,
        }),
      );
      expect(html).toContain('data-testid="keeper-panel"');
      expect(html).not.toMatch(/<details[^>]*open=""[^>]*data-testid="keeper-panel"/);
    }
  });

  it("shows an eligible wallet: until when, inclusive, and its SPX against the 690, with nothing to do yet", () => {
    const html = view();
    expect(html).toContain('data-eligible="true"');
    expect(text(html)).toContain("Your wallet is a community keeper: buys inside their community window can pay it.");
    expect(text(html)).toMatch(/Its proof is valid until [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}\./);
    expect(text(html)).toContain("You hold 1,210 SPX; 690 is the bar.");
    expect(html).not.toContain('data-testid="keeper-prove"');
    expect(html).not.toContain('data-testid="keeper-lapse"');
    // A link the person clicks, built from the release's source; left out when the build names none.
    expect(html).toContain(`href="${SOURCE.keeper}"`);
    expect(view({ docs: { keeper: null, proofs: null } })).not.toContain("keeper-docs");
  });

  it("shows an ineligible wallet's shortfall, and offers no proof that could only revert", () => {
    const html = view({ standing: { kind: "read", status: standing({ eligible: false, validUntil: 0n, proofValid: false, balance: 120n * SPX, shortfall: 570n * SPX, reason: "not-proven" }) } });
    expect(html).toContain('data-eligible="false"');
    expect(text(html)).toContain("Your wallet isn't a community keeper right now.");
    expect(text(html)).toContain("It has never proven its SPX.");
    expect(text(html)).toContain("You hold 120 of the 690 SPX.");
    expect(html).not.toContain('data-testid="keeper-prove"');
  });

  it("tells a contract it can never be paid, and offers it no proof", () => {
    const html = view({ standing: { kind: "read", status: standing({ eligible: false, isAccount: false, reason: "contract" }) } });
    expect(text(html)).toContain("Only an ordinary account can be paid as a community keeper; this address is a contract.");
    expect(html).not.toContain('data-testid="keeper-prove"');
  });

  it("says what it couldn't read, never a no or a zero, and offers no proof on a guess", () => {
    const unknown = view({ standing: { kind: "read", status: standing({ eligible: null, isAccount: null, balance: null, shortfall: null, validUntil: null, proofValid: null, reason: null }) } });
    expect(unknown).toContain('data-eligible="null"');
    expect(text(unknown)).toContain("Whether your wallet is a community keeper couldn't be read just now.");
    expect(text(unknown)).toContain("Its proof couldn't be read.");
    expect(text(unknown)).toContain("Its SPX couldn't be read.");
    expect(unknown).not.toContain('data-testid="keeper-prove"');
    const failed = view({ standing: { kind: "failed", text: "Couldn't read your wallet's standing (rate limited)." } });
    expect(text(failed)).toContain("Couldn't read your wallet's standing (rate limited). Nothing is shown rather than a guess.");
    const missing = view({ standing: { kind: "read", status: { state: "not-deployed", registry: REGISTRY, holder: ME, block: null, chainTime: null } } });
    expect(text(missing)).toMatch(/The SPX holder registry isn't on .+, so there's nothing to prove here\./);
    expect(missing).not.toContain("keeper-other");
  });

  it("offers Prove my SPX to a holder with no valid proof, saying what it costs, as a control focus never lands on", () => {
    const html = view({ standing: { kind: "read", status: standing({ eligible: false, validUntil: 0n, proofValid: false, reason: "not-proven" }) } });
    expect(html).toMatch(/<button[^>]*data-testid="keeper-prove"[^>]*data-money-control=""/);
    expect(text(html)).toContain("One transaction of about 680,000 gas, once every 30 days. It moves no money.");
  });

  it("before a wallet's first proof, says what proving makes public and asks to continue", () => {
    const html = view({
      standing: { kind: "read", status: standing({ eligible: false, validUntil: 0n, proofValid: false, reason: "not-proven" }) },
      prove: { kind: "publish", holder: ME },
    });
    expect(text(html)).toContain(PROVING_PUBLISHES_TEXT);
    expect(PROVING_PUBLISHES_TEXT).toMatch(/for good/);
    expect(html).toMatch(/<button[^>]*data-testid="keeper-prove-continue"[^>]*data-money-control=""/);
    expect(html).toContain('data-testid="keeper-prove-cancel"');
    // The button that started it steps aside while the question is asked.
    expect(html).not.toContain('data-testid="keeper-prove"');
  });

  it("shows the lapse banner from five days before the proof lapses, in chain time, and not before or after", () => {
    const at = (left: bigint) =>
      view({ standing: { kind: "read", status: standing({ chainTime: NOW, validUntil: NOW + left, proofValid: left >= 0n }) } });
    expect(at(PROOF_LAPSE_WARNING_SECONDS + 1n)).not.toContain("keeper-lapse");
    const shown = at(PROOF_LAPSE_WARNING_SECONDS);
    expect(shown).toContain('data-testid="keeper-lapse"');
    expect(text(shown)).toMatch(/Your proof lapses on [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}\. Prove again to stay a community keeper\./);
    // Proving again is offered alongside it.
    expect(shown).toContain('data-testid="keeper-prove"');
    expect(at(0n)).toContain("keeper-lapse");
    expect(at(-1n)).not.toContain("keeper-lapse");
  });

  it("when the service refuses eth_getProof, says so and opens the paste path with the exact requests for the block it named", () => {
    const html = view({
      standing: { kind: "read", status: standing({ eligible: false, validUntil: 0n, proofValid: false, reason: "not-proven" }) },
      prove: { kind: "unavailable", holder: ME },
      paste: { open: true, holder: ME, block: { kind: "read", number: 26_000_000n }, text: "", error: null },
      docs: { keeper: null, proofs: null },
    });
    expect(text(html)).toContain(PROOF_REFUSED_TEXT);
    expect(html).toMatch(/<details class="spdex-disclosure" open="" data-testid="keeper-paste">/);
    for (const request of proofRequests(ME, 26_000_000n)) {
      expect(text(html)).toContain(`curl -sS -X POST <another service> -H 'content-type: application/json' --data '${request.body}'`);
    }
    // Where the docs say which services answer it, as words when the build names no source.
    expect(text(html)).toContain("docs/RPC-RUNBOOK.md in spDEX's source lists services that answer it.");
    expect(html).toMatch(/<button[^>]*data-testid="keeper-paste-send"[^>]*data-money-control=""/);
    // A first proof's warning stands above the button that sends it.
    expect(text(html)).toContain(PROVING_PUBLISHES_TEXT);
    // Nothing anywhere names a service spDEX wasn't given.
    expect(html).not.toMatch(/https?:\/\/(?!example\.org)/);
  });

  /**
   * Decision 24: the warning before a wallet's first proof. A proof that
   * couldn't be read may be the first, so only a proof known to exist skips
   * it: unknown is never taken as "proven before".
   */
  it("says what proving publishes above a pasted proof unless the wallet is known to have proven before", () => {
    const pasted = (overrides: Partial<Parameters<typeof KeepingView>[0]>) =>
      text(
        view({
          paste: { open: true, holder: ME, block: { kind: "read", number: 26_000_000n }, text: "", error: null },
          ...overrides,
        }),
      );
    const unproven = standing({ eligible: false, validUntil: 0n, proofValid: false, reason: "not-proven" });
    expect(pasted({ standing: { kind: "read", status: unproven } })).toContain(PROVING_PUBLISHES_TEXT);
    // Its proof unread, or its standing: maybe its first.
    expect(pasted({ standing: { kind: "read", status: standing({ eligible: null, validUntil: null, proofValid: null }) } })).toContain(PROVING_PUBLISHES_TEXT);
    expect(pasted({ standing: { kind: "failed", text: "Couldn't read your wallet's standing (rate limited)." } })).toContain(PROVING_PUBLISHES_TEXT);
    // Another address's proof, whose standing this view doesn't have.
    const OTHER = "0x00000000000000000000000000000000000000cc" as Address;
    expect(
      pasted({ paste: { open: true, holder: OTHER, block: { kind: "read", number: 26_000_000n }, text: "", error: null } }),
    ).toContain(PROVING_PUBLISHES_TEXT);
    // Known to have proven before: nothing new is published.
    expect(pasted({})).not.toContain(PROVING_PUBLISHES_TEXT);
  });

  /**
   * The person chose private sending. A wallet that can't sign for it is
   * asked about, as the swap's fallback asks, never broadcast publicly
   * unasked (submit()'s "never silently downgrade"); and nothing else in the
   * panel can be pressed while the question stands.
   */
  it("asks before a proof goes out publicly, and holds every other control while it asks", () => {
    const unproven = { kind: "read" as const, status: standing({ eligible: false, validUntil: 0n, proofValid: false, reason: "not-proven" }) };
    const html = view({
      standing: unproven,
      prove: { kind: "public", holder: ME, reason: "the wallet doesn't support eth_signTransaction", oneService: false },
      other: { text: "0x00000000000000000000000000000000000000cc", error: null },
    });
    expect(text(html)).toContain(
      "Your wallet can't send this privately (the wallet doesn't support eth_signTransaction). Send it publicly? It moves no money, but it's seen before it's included.",
    );
    expect(html).toMatch(/<button[^>]*data-testid="keeper-public-send"[^>]*data-money-control=""/);
    expect(html).toContain('data-testid="keeper-public-cancel"');
    expect(html).toMatch(/<button[^>]*data-testid="keeper-prove"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*data-testid="keeper-prove-other"[^>]*disabled=""/);
  });

  /**
   * A relay may drop a proof (one that would revert `NotNewer`, say), and its
   * receipt then never comes. The wait ending used to leave "Waiting for it
   * to be included…" up and every button off until the page was reloaded.
   */
  it("says so when a proof's receipt didn't come in the wait, and frees the panel", () => {
    const unproven = { kind: "read" as const, status: standing({ eligible: false, validUntil: 0n, proofValid: false, reason: "not-proven" }) };
    const hash = `0x${"ab".repeat(32)}` as Hex;
    const waiting = view({ standing: unproven, prove: { kind: "sent", holder: ME, hash, result: null } });
    expect(text(waiting)).toContain("Sent. Waiting for it to be included…");
    expect(waiting).toMatch(/<button[^>]*data-testid="keeper-prove"[^>]*disabled=""/);
    const unseen = view({ standing: unproven, prove: { kind: "unseen", holder: ME, hash } });
    expect(text(unseen)).toContain(PROOF_UNSEEN_TEXT);
    expect(text(unseen)).not.toContain("Waiting for it to be included");
    expect(unseen).toContain('data-testid="keeper-tx"');
    expect(unseen).toMatch(/<button[^>]*data-testid="keeper-prove"/);
    expect(unseen).not.toMatch(/<button[^>]*data-testid="keeper-prove"[^>]*disabled=""/);
  });

  it("dates a proof by this device's clock, as the vault card does, when the read says when it was made", () => {
    // Read three days and an hour ahead of the chain's clock, as on a local fork.
    const skew = 3n * DAY + 3_600n;
    const readAtMs = Number(NOW + skew) * 1000;
    const html = text(view({ standing: { kind: "read", status: standing(), readAtMs } }));
    expect(html).toContain(`Its proof is valid until ${whenText(NOW + 20n * DAY + skew)}.`);
    expect(text(view())).toContain(`Its proof is valid until ${whenText(NOW + 20n * DAY)}.`);
    const lapsing = standing({ validUntil: NOW + DAY });
    expect(text(view({ standing: { kind: "read", status: lapsing, readAtMs } }))).toContain(`Your proof lapses on ${whenText(NOW + DAY + skew)}.`);
  });

  it("keeps Prove another address and Paste a proof folded until asked for", () => {
    const html = view();
    expect(html).toMatch(/<details class="spdex-disclosure" data-testid="keeper-other">/);
    expect(html).toMatch(/<details class="spdex-disclosure" data-testid="keeper-paste">/);
    expect(html).toMatch(/<button[^>]*data-testid="keeper-prove-other"[^>]*data-money-control=""/);
  });

  it("shows the safety check's own words for a proof it refuses, and the one-service note for one it allows", () => {
    const verdict: GuardVerdict = rejected([
      {
        code: "SIMULATION_REVERTED",
        message: "the proof would revert: this address is already proven until 2026-10-26, by a proof as new or newer",
        detail: { reason: "NotNewer" },
      },
    ]);
    const refused = text(view({ prove: { kind: "refused", holder: ME, verdict } }));
    expect(refused).toContain("The safety check won't let this proof be sent:");
    expect(refused).toContain("The proof would revert: this address is already proven until 2026-10-26, by a proof as new or newer.");
    const sending = text(view({ prove: { kind: "sending", holder: ME, text: "Confirm in your wallet…", oneService: true } }));
    expect(sending).toContain("Test-run on your main service only. A proof moves no money");
    const sent = view({ prove: { kind: "sent", holder: ME, hash: `0x${"ab".repeat(32)}` as Hex, result: { status: "success", validUntil: NOW + 30n * DAY, fee: 1n } } });
    expect(text(sent)).toMatch(/Proven: valid until [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}\./);
  });

  it("offers the reminder's tick only to a wallet with a proof to lapse", () => {
    const reminder = { supported: true, enabled: false, blocked: false, setEnabled: async () => undefined };
    expect(view({ reminder })).toContain('data-testid="keeper-notify"');
    expect(text(view({ reminder }))).toContain("Remind me 5 days before my proof lapses (while spDEX is open in a tab)");
    expect(view({ reminder, standing: { kind: "read", status: standing({ validUntil: 0n, eligible: false, proofValid: false, reason: "not-proven" }) } })).not.toContain(
      "keeper-notify",
    );
  });

  it("shows decision 31's notice under its intro only when a build sets one, and none in this build", () => {
    const NOTICE = "A bug in the SPX holder registry lets some addresses that never held SPX be paid inside community windows. No vault's money is at risk.";
    const shown = view({ advisory: NOTICE });
    expect(shown).toMatch(/data-testid="keeper-advisory"/);
    expect(text(shown)).toMatch(new RegExp(`${REGISTRY_ADVISORY_TITLE}\\s+A bug in the SPX holder registry`));
    expect(text(shown)).toContain(NOTICE);
    expect(view({ advisory: null })).not.toContain("keeper-advisory");
    // This build's: none.
    expect(REGISTRY_ADVISORY).toBeNull();
    expect(view()).not.toContain("keeper-advisory");
  });

  it("calls keeping paid work, and nothing in it a return", () => {
    const html = text(view()) + text(view({ prove: { kind: "publish", holder: ME } }));
    expect(html).toContain("Community keepers make other people's buys and are paid for each one; holding 690 SPX is the entry bar.");
    expect(html).not.toMatch(/\bAPR\b|\bAPY\b|yield|projected|reward/i);
    expect(MIN_SPX).toBe(69_000_000_000n);
  });
});

describe("Help run's held-back buys", () => {
  /**
   * The held-back block (first claim, the wallet's standing, keeping) sat
   * between the offer's tick list and the lines that describe and send it.
   * The planned states are drawn from component state, so the order is
   * pinned in the source.
   */
  it("come after an offer's list, terms and button, which read as one unit", () => {
    const offer = helpRunSource.slice(helpRunSource.indexOf('case "offer": {'));
    const at = (needle: string) => offer.indexOf(needle);
    expect(at("{list}")).toBeGreaterThan(0);
    expect(at("{list}")).toBeLessThan(at('data-testid="help-run-wallet-fee"'));
    expect(at('data-testid="help-run-terms"')).toBeLessThan(at('testId="help-run-send"'));
    expect(at("{held}")).toBeGreaterThan(at('testId="help-run-send"'));
  });

  const ME = "0x00000000000000000000000000000000000000aa" as Address;
  const UNTIL = 1_790_001_800n;

  it("say when SPX holders' first claim ends, why this wallet isn't one, and link keeping, with no buy button", () => {
    const holder: HolderStatus = {
      state: "read",
      registry: "0x2c7f732a453fe0a4a65f36ac564ff16007b5610d",
      holder: ME,
      block: 1n,
      chainTime: UNTIL - 60n,
      eligible: false,
      validUntil: 0n,
      proofValid: false,
      lapsesSoon: false,
      isAccount: true,
      balance: 120n * 10n ** 8n,
      shortfall: 570n * 10n ** 8n,
      reason: "not-proven",
    };
    const html = renderToStaticMarkup(createElement(HoldersFirst, { until: UNTIL, alongside: null, holder }));
    expect(text(html)).toContain(`SPX holders have first claim until ${clockText(Number(UNTIL) * 1000)}.`);
    expect(text(html)).toContain("You hold 120 of the 690 SPX.");
    expect(text(html)).toContain("Community keepers make other people's buys and are paid for each one; holding 690 SPX is the entry bar.");
    expect(html).not.toContain("help-run-send");
    expect(html).not.toContain("<button");
    const contract = renderToStaticMarkup(createElement(HoldersFirst, { until: UNTIL, alongside: 2, holder: { ...holder, isAccount: false, reason: "contract" } }));
    expect(text(contract)).toMatch(/^ ?2 more buys are due; SPX holders have first claim until \d{2}:\d{2}\./);
    expect(text(contract)).toContain("Only an ordinary account can be paid as a community keeper");

    // On this device's clock, as the vault card shows a window's end: the
    // window ends 60 s after the standing's block, read two days and 3 h 17
    // min ahead of the chain's clock (a local fork's), so 60 s after the read.
    const readAtMs = Number(UNTIL - 60n + 2n * 86_400n + 3n * 3_600n + 17n * 60n) * 1000 + 400;
    const moved = renderToStaticMarkup(createElement(HoldersFirst, { until: UNTIL, alongside: null, holder, readAtMs }));
    expect(text(moved)).toContain(`SPX holders have first claim until ${clockText((Math.floor(readAtMs / 1000) + 60) * 1000)}.`);
    expect(text(moved)).not.toContain(clockText(Number(UNTIL) * 1000));
    const unread = renderToStaticMarkup(createElement(HoldersFirst, { until: UNTIL, alongside: null, holder: null, readAtMs }));
    expect(text(unread)).toContain(`SPX holders have first claim until ${clockText(Number(UNTIL) * 1000)}.`);
  });

  /** Turns, dormant: said only for buys held back because the turn is another group's, never otherwise. */
  it("says which held-back buys are another group's turn, and nothing of turns when none are", () => {
    const holder = null;
    expect(renderToStaticMarkup(createElement(HoldersFirst, { until: UNTIL, alongside: null, holder }))).not.toContain("help-run-turns");
    const html = renderToStaticMarkup(createElement(HoldersFirst, { until: UNTIL, alongside: 3, byTurn: 2, holder }));
    expect(html).toContain("help-run-turns");
    expect(text(html)).toContain("2 of them are another group's turn");
  });
});
