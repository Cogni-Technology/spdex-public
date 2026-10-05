/**
 * Community keeping: the closed fold at the foot of Help run the network
 * that says whether the connected wallet may be paid for buys inside their
 * community window, and sends the one transaction that makes an address so,
 * a proof that it held 690 SPX at the end of a recent block.
 *
 * ## What a fork can prove
 *
 * anvil can't prove a block it mined: its state root is zero. Its `finalized`
 * is its head less 64, one of those blocks once 64 have been mined. Blocks up
 * to the pinned one, though, are mainnet's, and the fork answers
 * `eth_getProof` for them from the archive it forked. So each spec here pins
 * the page's `finalized` to such a block with `page.route` on the network
 * service (AGENTS.md, "Eligibility on the fork"), and proves real mainnet
 * holders at it. Nothing else of the service is touched.
 *
 * **Prove my SPX** is pressed here only by a wallet that can't be proven (a
 * fresh key whose SPX was bought on the fork), and stops before anything is
 * signed. A wallet that is itself a real mainnet holder can't be connected:
 * the suite holds no such key, and impersonated senders proved erratic on
 * this fork (e2e/vaults.ts). After the proof is built, Prove my SPX and
 * Prove another address, which is sent here, are one path (CommunityKeeping's
 * `start`, `build`, `checkAndSend`) that differs only in whose address the
 * proof is of, and in a proof of the wallet itself reading its standing again
 * after; `network.test.ts` and `keeping.test.ts` pin that wiring, and e2e-mainnet's `3-prove` sends a wallet's proof of
 * itself on the first v2 mainnet run (docs/MAINNET-SMOKE.md).
 *
 * ## A newer block each run
 *
 * A proof is not idempotent: once an address is proven, the same block or
 * an older one reverts `NotNewer`, and no test may write a real holder's
 * record back. So the two specs that send a proof each prove a real holder
 * — two ordinary accounts that held over 690 SPX through the blocks before
 * the pinned one, and that nothing else on the fork proves or pays — at the
 * first block after the one it was last proven at (the registry's own
 * `Proven` logs say which), from `LADDER_START` on. That leaves about a
 * thousand runs per fork, far more than the 8,191 blocks the registry looks
 * back allow: past those, the spec says to restart the fork, as the rest of
 * the suite does. The two holders the rest of the suite relies on are left
 * alone: `0xb007…bb8e` (the eligible `rewardTo`) and `0xd751…5b7e`, which the
 * Guard's fork tests keep unproven.
 *
 * ## Paste a proof
 *
 * When the person's service refuses `eth_getProof` (here: routed to refuse
 * it), the panel shows the two requests to run against another service, by
 * hand. The spec runs exactly the requests the page shows against the fork
 * itself, which answers them as an archive would, pastes the answers, and
 * checks that the page checked the pasted block against its own service
 * before anything was signed, and sent nothing anywhere else (rule 4).
 *
 * The lapse banner needs a proof within five days of lapsing, and no proof
 * of a real block lapses that soon on a fork pinned at it: that one wallet is
 * a fresh key written eligible in the registry, the one write a test may make
 * there (packages/testing/src/vaultFork.ts).
 */

import type { Page, Route } from "@playwright/test";
import { blockHeaderRlp, type RpcBlockHeader } from "../packages/chain/src/index.js";
import {
  MIN_SPX,
  PROOF_TTL,
  checksumAddress,
  decodeRegistryEvent,
  encodeProve,
  proofRequests,
  provenBy,
  spxBalanceSlot,
  type RawLog,
} from "../packages/vault/src/index.js";
import { buySpxOnFork, validUntilOnFork, writeEligibleOnFork } from "../packages/testing/src/vaultFork.js";
import { FORK_CHAIN_ID, FORK_URL, expect, forkRpc, headBlock, openTile, seedConfig, test, tokenBalance, watchRpc, SPX } from "./fixtures.js";
import { ETHER, REGISTRY, chainNow, ensureContracts, freshAccount, keyWallet, receiptOf, type KeyWallet } from "./vaults.js";

type Hex = `0x${string}`;

/** The block the fork was pinned at, the newest it can prove. */
const FORK_BLOCK = BigInt(process.env["SPDEX_FORK_BLOCK"] ?? "26000000");
/** Where the holders' proofs start: a thousand blocks before the pinned one. */
const LADDER_START = FORK_BLOCK - 1_000n;
/** How many blocks back the registry can check a proven block's hash (EIP-2935). */
const HISTORY_BLOCKS = 8_191n;
/** Room for the blocks the fork mines between choosing a block and the proof landing. */
const REACH_MARGIN = 64n;

/**
 * Real mainnet holders, ordinary accounts, each holding over 690 SPX at
 * blocks 25,999,000 and 26,000,000 alike (1,093 and 2,120 SPX): one proven
 * from pasted answers, the other from a proof the page builds itself.
 */
const PASTED_HOLDER: Hex = "0x30742f39cce598f721c048930bae0ec2543d2d6c";
const BUILT_HOLDER: Hex = "0xa56ddea65f0dfb50bdcf34fbf9e9850de21e1572";
/** Uniswap v2's SPX/WETH pair: a contract, which a proof can never make a community keeper. */
const PAIR: Hex = "0x52c77b0cb827afbad022e6d6caf2c44452edbc39";
/** A holder of about 598 SPX: short of the bar. */
const SHORT_HOLDER: Hex = "0xcc01ef33f793ff0a8da26d19b2c4428f62753f85";

const PROVING_PUBLISHES =
  "Proving records on chain, for good, that this address held at least 690 SPX. Buys paid to it then link it in public to the wallet that sends them, so keep the SPX in a wallet kept for it, not your main one.";

const hex = (value: bigint): Hex => `0x${value.toString(16)}`;

/**
 * `shown` ("Oct 5, 14:32") is this device's date and time at some second
 * from `from` to `to` (unix seconds), written as the panel writes a proof's
 * dates (`whenText`): the day in English, the time 24-hour, in this device's
 * time zone, which the browser shares with the test.
 */
function expectWhenWithin(shown: string, from: number, to: number): void {
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const minutes = new Set<string>();
  for (let t = from - (from % 60); t <= to; t += 60) minutes.add(`${day.format(new Date(t * 1000))}, ${clock.format(new Date(t * 1000))}`);
  expect([...minutes], `"${shown}" as a time from ${new Date(from * 1000).toISOString()} to ${new Date(to * 1000).toISOString()}`).toContain(shown);
}

test.beforeAll(async () => {
  await ensureContracts();
});

/** A single JSON-RPC request's body, or null for anything else. */
function rpcBody(route: Route): { id?: unknown; method?: string; params?: unknown[] } | null {
  try {
    const body = JSON.parse(route.request().postData() ?? "null") as unknown;
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as ReturnType<typeof rpcBody>) : null;
  } catch {
    return null;
  }
}

/**
 * The person's own service with its `finalized` block pinned to `block`, a
 * block of mainnet's the fork can prove; and, with `refuseProofs`, one that
 * won't answer `eth_getProof`, as many hosted services won't. Everything else
 * goes to the fork as it was asked (and on to the context's key wallet).
 */
async function pinService(page: Page, block: bigint, options: { refuseProofs?: boolean } = {}): Promise<void> {
  const pinned = (await forkRpc("eth_getBlockByNumber", [hex(block), false])) as RpcBlockHeader;
  await page.route(
    (url) => url.href.startsWith(FORK_URL),
    async (route) => {
      const body = rpcBody(route);
      const reply = (payload: object) =>
        route.fulfill({
          status: 200,
          headers: { "access-control-allow-origin": "*" },
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: body?.id, ...payload }),
        });
      if (body?.method === "eth_getBlockByNumber" && body.params?.[0] === "finalized") return reply({ result: pinned });
      if (body?.method === "eth_getProof" && options.refuseProofs) {
        return reply({ error: { code: -32601, message: "the method eth_getProof does not exist/is not available" } });
      }
      return route.fallback();
    },
  );
}

/** SPX held by `holder` at the end of `block`, from the fork (which asks its archive for a block before its own). */
async function spxAt(holder: Hex, block: bigint): Promise<bigint> {
  const raw = (await forkRpc("eth_call", [{ to: SPX, data: `0x70a08231${holder.slice(2).padStart(64, "0")}` }, hex(block)])) as string;
  return BigInt(raw);
}

/**
 * The block to prove `holder` at this run: after the last block it was
 * proven at on this fork (the registry's own `Proven` logs), from
 * `LADDER_START` on, one the registry can still check when the proof lands,
 * and one at whose end it held 690 SPX.
 */
async function nextProvableBlock(holder: Hex): Promise<bigint> {
  const logs = (await forkRpc("eth_getLogs", [
    { address: REGISTRY, topics: [null, `0x${holder.slice(2).padStart(64, "0")}`], fromBlock: hex(FORK_BLOCK + 1n), toBlock: "latest" },
  ])) as RawLog[];
  const proven = logs.map(decodeRegistryEvent).reduce((last, event) => (event !== null && event.blockNumber > last ? event.blockNumber : last), 0n);
  const reach = (await headBlock()) + 1n + REACH_MARGIN - HISTORY_BLOCKS;
  for (let block = [LADDER_START, reach, proven + 1n].reduce((a, b) => (a > b ? a : b)); block <= FORK_BLOCK; block++) {
    if ((await spxAt(holder, block)) >= MIN_SPX) return block;
  }
  throw new Error(
    `${holder} has no block left to prove on this fork (last proven at ${proven}, the registry reaches back to ${reach}): ` +
      "restart `pnpm anvil:fork`; never move the pinned block.",
  );
}

/** Connect, open Help run the network, and see Community keeping, folded, at its foot. */
async function openKeeping(page: Page): Promise<void> {
  await page.goto("/");
  await openTile(page, "trade");
  await page.getByTestId("connect-button").click();
  await openTile(page, "community");
  await expect(page.getByTestId("help-run")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("keeper-panel")).toBeVisible({ timeout: 60_000 });
}

/** Open Community keeping and wait for the wallet's standing. */
async function openPanel(page: Page): Promise<void> {
  await page.getByTestId("keeper-panel-summary").click();
  await expect(page.getByTestId("keeper-panel")).toHaveAttribute("open", "");
  await expect(page.getByTestId("keeper-standing")).toBeVisible({ timeout: 60_000 });
}

/**
 * Type `address` into Prove another address and press it. Before an
 * address's first proof the panel says what proving publishes and waits for
 * Continue; whether this address has proven before is the chain's to say,
 * and this run may be its first on the fork or not.
 */
async function proveOther(page: Page, address: Hex): Promise<void> {
  const other = page.getByTestId("keeper-other");
  if ((await other.getAttribute("open")) === null) await page.getByTestId("keeper-other-summary").click();
  await page.getByTestId("keeper-other-address").fill(checksumAddress(address));
  const first = (await validUntilOnFork(forkRpc, address)) === 0n;
  await page.getByTestId("keeper-prove-other").click();
  if (first) {
    await expect(page.getByTestId("keeper-publish")).toHaveText(new RegExp(`^${asPattern(PROVING_PUBLISHES)}`), { timeout: 60_000 });
    await page.getByTestId("keeper-prove-continue").click();
  }
  await expect(page.getByTestId("keeper-publish")).toHaveCount(0);
}

/** `text` as a pattern that matches it exactly. */
const asPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The proof the page sent, checked on the chain: one transaction, signed for
 * private sending and never broadcast by the wallet, to the registry, carrying
 * no ether, whose calldata is exactly the proof of `holder` at `block` built
 * from the service's own answers; and the registry's own `Proven`, with the
 * holding at that block and its validity counted from that block's time.
 */
async function expectProven(wallet: KeyWallet, holder: Hex, block: bigint): Promise<void> {
  expect(wallet.signed).toHaveLength(1);
  expect(wallet.hashes).toHaveLength(0);
  const hash = wallet.signed[0]!.hash;
  const tx = (await forkRpc("eth_getTransactionByHash", [hash])) as { to: string; value: string; input: string };
  const header = (await forkRpc("eth_getBlockByNumber", [hex(block), false])) as RpcBlockHeader & { timestamp: string };
  const proof = (await forkRpc("eth_getProof", [SPX, [spxBalanceSlot(holder)], hex(block)])) as { accountProof: Hex[]; storageProof: { proof: Hex[] }[] };
  expect(tx.to.toLowerCase()).toBe(REGISTRY);
  expect(BigInt(tx.value)).toBe(0n);
  expect(tx.input.toLowerCase()).toBe(
    encodeProve({ holder, header: blockHeaderRlp(header), accountProof: proof.accountProof, storageProof: proof.storageProof[0]!.proof }),
  );
  const receipt = await receiptOf(hash);
  const validUntil = BigInt(header.timestamp) + PROOF_TTL;
  expect(provenBy(REGISTRY, receipt.logs)).toEqual([expect.objectContaining({ holder, blockNumber: block, balance: await spxAt(holder, block), validUntil })]);
  expect(await validUntilOnFork(forkRpc, holder)).toBe(validUntil);
}

test.describe("community keeping", () => {
  test("closed until opened and reading nothing till then; a wallet that isn't a keeper says why; a proof pasted from another service is checked against the person's own and sent", async ({
    page,
    context,
    baseURL,
  }) => {
    const helper = await freshAccount(ETHER / 20n);
    const wallet = await keyWallet(context, helper);
    await seedConfig(page, { preset: "custom", submitter: { mode: "private", url: FORK_URL } });
    const block = await nextProvableBlock(PASTED_HOLDER);
    await pinService(page, block, { refuseProofs: true });
    // Everything the page asks for, and of whom.
    const requests: { url: string; body: string }[] = [];
    page.on("request", (request) => requests.push({ url: request.url(), body: request.postData() ?? "" }));
    const traffic = watchRpc(page);
    await openKeeping(page);

    // ── Closed, it reads nothing ──
    await traffic.quiet();
    await expect(page.getByTestId("keeper-panel")).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("keeper")).toHaveCount(0);
    const askedRegistry = () => requests.some((r) => r.body.toLowerCase().includes(REGISTRY.slice(2)));
    expect(askedRegistry()).toBe(false);

    // ── Opened: this wallet's standing, from the registry, in words ──
    await openPanel(page);
    expect(askedRegistry()).toBe(true);
    await expect(page.getByTestId("keeper")).toContainText(
      "Community keepers make other people's buys and are paid for each one; holding 690 SPX is the entry bar.",
    );
    await expect(page.getByTestId("keeper-standing")).toHaveAttribute("data-eligible", "false");
    await expect(page.getByTestId("keeper-eligible")).toHaveText("Your wallet isn't a community keeper right now.");
    await expect(page.getByTestId("keeper-proof")).toHaveText("It has never proven its SPX.");
    await expect(page.getByTestId("keeper-holding")).toHaveText("You hold 0 of the 690 SPX.");
    // Nothing to prove for a wallet without the SPX, and nothing about to lapse.
    await expect(page.getByTestId("keeper-prove")).toHaveCount(0);
    await expect(page.getByTestId("keeper-lapse")).toHaveCount(0);

    // ── Prove another address: a contract, and a holder short of the bar, are refused in words ──
    await page.getByTestId("keeper-other-summary").click();
    await page.getByTestId("keeper-other-address").fill(checksumAddress(PAIR));
    await page.getByTestId("keeper-prove-other").click();
    await expect(page.getByTestId("keeper-note")).toHaveText(
      "Only an ordinary account can be paid as a community keeper; this address is a contract.",
      { timeout: 60_000 },
    );
    const short = (await tokenBalance(SPX, SHORT_HOLDER)) / 10n ** 8n;
    expect(short).toBeLessThan(690n);
    await page.getByTestId("keeper-other-address").fill(SHORT_HOLDER);
    await page.getByTestId("keeper-prove-other").click();
    await expect(page.getByTestId("keeper-note")).toHaveText(
      `It holds ${short} of the 690 SPX now, so a proof of it can't make it a community keeper.`,
      { timeout: 60_000 },
    );

    // ── A holder, with a service that won't give the proof: the requests to run elsewhere ──
    await proveOther(page, PASTED_HOLDER);
    await expect(page.getByTestId("keeper-unavailable")).toHaveText(
      "Your network service won't give the proof (it doesn't answer eth_getProof for that block). Another service can: paste its answers below.",
      { timeout: 60_000 },
    );
    const paste = page.getByTestId("keeper-paste");
    await expect(paste).toHaveAttribute("open", "");
    await expect(paste.getByTestId("keeper-paste-holder")).toHaveText(`For ${checksumAddress(PASTED_HOLDER)}, at block ${block}:`);
    // Exactly these two, for the block the person's own service calls finalized; the other service is theirs to fill in.
    const shown = (await paste.getByTestId("keeper-paste-commands").textContent()) ?? "";
    expect(shown).toBe(
      proofRequests(PASTED_HOLDER, block)
        .map((request) => `curl -sS -X POST <another service> -H 'content-type: application/json' --data '${request.body}'`)
        .join("\n\n"),
    );

    // Run as shown, against a service that answers them (the fork, asking
    // its archive), and paste the answers whole.
    const answers: string[] = [];
    for (const [, body] of shown.matchAll(/--data '([^']+)'/g)) {
      const response = await fetch(FORK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: body! });
      answers.push(await response.text());
    }
    expect(answers).toHaveLength(2);
    await paste.getByTestId("keeper-paste-text").fill(answers.join("\n"));
    // Another address's proof always says what proving publishes, beside the button that sends it.
    await expect(paste.getByTestId("keeper-paste-body")).toContainText(PROVING_PUBLISHES);
    const checkedBlock = page.waitForRequest((request) => request.url().startsWith(FORK_URL) && (request.postData() ?? "").includes(`"eth_getBlockByNumber","params":["${hex(block)}"`));
    await paste.getByTestId("keeper-paste-send").click();
    // The pasted block's hash, asked of the person's own service by number.
    await checkedBlock;
    await expect(page.getByTestId("keeper-result-text")).toHaveText(/^Proven: valid until [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}\.$/, { timeout: 120_000 });
    await expectProven(wallet, PASTED_HOLDER, block);

    // Every request went to the person's own service or to the server this
    // page came from: the paste path fetches from nowhere else.
    const host = new URL(baseURL!).host;
    const elsewhere = requests.filter((r) => !r.url.startsWith(FORK_URL) && !/^(data|blob):/.test(r.url) && new URL(r.url).host !== host);
    expect(elsewhere.map((r) => r.url)).toEqual([]);
  });

  test("Prove another address builds the proof in the browser from the person's own service, and sends it", async ({ page, context }) => {
    const helper = await freshAccount(ETHER / 20n);
    const wallet = await keyWallet(context, helper);
    await seedConfig(page, { preset: "custom", submitter: { mode: "private", url: FORK_URL } });
    const block = await nextProvableBlock(BUILT_HOLDER);
    await pinService(page, block);
    await openKeeping(page);
    await openPanel(page);

    const asked = page.waitForRequest((request) => (request.postData() ?? "").includes(`"eth_getProof","params":["${SPX}"`));
    await proveOther(page, BUILT_HOLDER);
    // SPX's proof of the holder's balance, at the finalized block, from the person's own service.
    expect((await asked).postData()).toContain(`"${hex(block)}"]`);
    await expect(page.getByTestId("keeper-result-text")).toHaveText(/^Proven: valid until [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}\.$/, { timeout: 120_000 });
    await expectProven(wallet, BUILT_HOLDER, block);
  });

  test("a wallet holding SPX it never proved is told what proving publishes first, and a block before it held them is refused in words; written eligible, the banner says when its proof lapses", async ({
    page,
    context,
  }) => {
    // A fresh key with SPX bought on the fork: no block before the fork's
    // own shows it, so no proof of it can be built. Nothing is sent here.
    const helper = await freshAccount(ETHER / 4n);
    const spx = await buySpxOnFork(forkRpc, FORK_CHAIN_ID, helper);
    const wallet = await keyWallet(context, helper);
    await seedConfig(page, { preset: "custom", submitter: { mode: "private", url: FORK_URL } });
    await pinService(page, FORK_BLOCK);
    await openKeeping(page);
    await openPanel(page);

    await expect(page.getByTestId("keeper-standing")).toHaveAttribute("data-eligible", "false");
    await expect(page.getByTestId("keeper-proof")).toHaveText("It has never proven its SPX.");
    await expect(page.getByTestId("keeper-holding")).toHaveText(`You hold ${(spx / 10n ** 8n).toLocaleString("en-US")} SPX; 690 is the bar.`);
    await expect(page.getByTestId("keeper-standing")).toBeVisible();

    // ── Before its first proof: what proving publishes, and nothing until Continue ──
    const prove = page.getByTestId("keeper-prove");
    await expect(prove).toHaveText("Prove my SPX");
    await prove.click();
    await expect(page.getByTestId("keeper-publish")).toHaveText(new RegExp(`^${asPattern(PROVING_PUBLISHES)}`));
    await page.getByTestId("keeper-prove-cancel").click();
    await expect(page.getByTestId("keeper-publish")).toHaveCount(0);
    await prove.click();
    await page.getByTestId("keeper-prove-continue").click();
    // At the finalized block it held none of them: refused before anything is signed.
    await expect(page.getByTestId("keeper-note")).toHaveText(`At block ${FORK_BLOCK.toLocaleString("en-US")} it held 0 SPX; proving takes 690.`, {
      timeout: 60_000,
    });
    expect(wallet.signed).toHaveLength(0);
    expect(wallet.hashes).toHaveLength(0);

    // ── Proven, its proof lapsing in two days: the banner, and Prove my SPX again ──
    const validUntil = (await chainNow()) + 2n * 86_400n;
    expect(await writeEligibleOnFork(forkRpc, helper, validUntil)).toEqual({ validUntil, eligible: true });
    await page.reload();
    await openKeeping(page);
    await openPanel(page);
    await expect(page.getByTestId("keeper-standing")).toHaveAttribute("data-eligible", "true");
    await expect(page.getByTestId("keeper-eligible")).toHaveText("Your wallet is a community keeper: buys inside their community window can pay it.");
    await expect(page.getByTestId("keeper-proof")).toHaveText(/^Its proof is valid until [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}\.$/);
    await expect(page.getByTestId("keeper-lapse")).toHaveText(/^Your proof lapses on [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}\. Prove again to stay a community keeper\.$/);
    // Both name the record's time on this device's clock, two days from now
    // (the fork's own clock runs days behind); the panel's read can lag the
    // chain by the seconds since its last block, never lead it.
    const lapsesOnDevice = Math.floor(Date.now() / 1000) + Number(validUntil - (await chainNow()));
    const proofLine = (await page.getByTestId("keeper-proof").textContent()) ?? "";
    expectWhenWithin(proofLine.slice("Its proof is valid until ".length, -1), lapsesOnDevice - 120, lapsesOnDevice + 300);
    const banner = (await page.getByTestId("keeper-lapse").textContent()) ?? "";
    expectWhenWithin(/^Your proof lapses on (.+)\. Prove again/.exec(banner)![1]!, lapsesOnDevice - 120, lapsesOnDevice + 300);
    await expect(prove).toBeVisible();
  });
});
