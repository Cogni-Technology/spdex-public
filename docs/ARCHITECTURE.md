# Architecture

spDEX is a **host** plus **modules**. The host owns the four things that must
not be delegated — the signer, the network, storage and the screen — and
treats everything else as a module the user chooses. What each part defends
against is `docs/THREAT-MODEL.md`; this page is where things live and how they
fit.

## The shape

```
                    apps/web  (Vite SPA, no backend)
                        │
              ┌─────────┴─────────┐
              │                   │
        packages/router     packages/config
        split routing       SpdexConfig + migrations
              │                   │
              └─────────┬─────────┘
                        │
                  packages/host
        capability broker · kind table · runtimes
                        │
        ┌───────────────┼───────────────┐
        │               │               │
  runtimes/native  runtimes/quickjs   modules/
   (fast path)      (sandbox)        Uniswap v2 and v3
                                     venues, tip list,
                                     tracker, scheduler
        │               │               │
        └───────────────┴───────────────┘
                        │
                  packages/guard          ← every plan passes here
              static → simulate → oracle
                        │
                  packages/chain
             viem · Multicall3 · eth_simulateV1
                        │
                   the user's RPC  (+ a second opinion, when one is set:
                                    every test-run on both, compared)
```

`packages/core` sits under all of it: types and zod schemas, including the
`TxPlan` and `SwapIntent` everything else is phrased in.

`packages/vault` sits beside `chain`, outside the module path: the contracts
spDEX ships (the auto-buy vault, its factory, the batcher and the SPX holder
registry), the TypeScript generated from them, the buy fee (`fee.ts`),
building and checking a holder's proof (`registry.ts`), and the keeper and its
report, which the app never imports. It is host code, not a module, for the
reason routing is: it decides where money goes. `docker/keeper` packages the
keeper for operators.

## The five rules the shape enforces

**1. Modules propose; the host performs.** A module returns approvals, calls
and what it claims the user will receive, and never touches a signer, a
socket, storage or the DOM. In the QuickJS sandbox they are unreachable.
Natively they are reachable, so there the rule holds because the same source
must also run in the sandbox, where reaching for them fails. If widening
`VenueContext` seems necessary to let a module do something directly, that is
the bug.

**2. Modules do not author intent.** The host builds the `SwapIntent` from
what the user was shown and attaches it to the plan, so a module can't propose
a plan whose promise differs from the one on screen: closed by construction,
not by a check.

**3. Every plan reaches the signer through the Guard**, native runtime
included. A first-party module runs faster and is trusted exactly as much as a
stranger's.

**4. Routing is host-side.** It decides where the user's money goes, so it is
audited once in the trusted core rather than left for each venue to influence.

**5. The capability broker is additive-only.** Add capabilities; never change
an existing signature. A module written for an earlier host API must still
load on a later one.

## Why two runtimes

`native` runs a first-party module as ordinary JavaScript; `quickjs` runs the
*same source text* in a WASM sandbox. Both marshal through the same JSON wire
types, so a module that keeps the rules in `docs/WRITING-MODULES.md` behaves
the same in either. One that reads the clock, randomness or the page's
globals works natively and fails in the sandbox.

The `parity` gate runs fixture modules covering every kind, honest and
hostile, both ways, and requires byte-identical output and identical
refusals. It doesn't run the shipped modules: each compares itself across the
runtimes in its own tests (whole outputs for the tip list, tracker and
scheduler in `unit`; pool discovery and quotes for the venues in
`integration`), never `buildCalls`, whose output is what gets signed. A drift
there fails no test; what stands there is the Guard, which judges the built
plan the same way whichever runtime made it. `strictSandbox` in the config
routes everything through QuickJS, so a user can check the claim on their own
machine.

## Native ether

Uniswap v2 and v3 pools are always ERC-20 pairs, so every "ETH" pool is WETH.
Ether needs no pools of its own, only another router entry point, so the wrap
happens inside the swap:

| Direction | Uniswap v2 | Uniswap v3 |
|---|---|---|
| ETH in | `swapExactETHForTokens`, value attached | `exactInputSingle` unchanged, value attached — SwapRouter02 wraps its own balance |
| ETH out | `swapExactTokensForETH` | `multicall([exactInputSingle → router, unwrapWETH9 → user])` |

`WireBuildParams` carries optional `nativeIn`/`nativeOut` flags. A module that
ignores them builds the wrapped path and *fails the Guard*, because the intent
says ether and the simulation shows WETH: loudly wrong, never silently.

The Guard has no native special case: `eth_simulateV1` with `traceTransfers`
reports ether as a Transfer log from `0xeeee…eeee`, the pseudo-address the
intent uses, and traces internal transfers, which makes the v3
unwrap-and-forward path verifiable. The oracle prices ether as WETH (no pool
is keyed on `0xeeee…eeee`, so asking for one would silently skip the
cross-check on every ether swap). That is exact: WETH redeems 1:1 at 18
decimals, and ether against WETH is one token against itself, with no market
and so no opinion.

The intent names what the *user* chose, while discovery, quoting and routing
run on `tradedAs(token)`, the ERC-20 the pools hold. **Max** holds back a
hundredth of an ether, so there is something left to sign with.

## Second opinion

A test-run is one network service's answer. A **second opinion**
(`guard.secondOpinion.url`, Settings → Safety) is a second service that
test-runs every transaction too, so faking a test-run takes both. What it
stops and what it doesn't: `docs/THREAT-MODEL.md`, "A second opinion".

**Where it sits.** `packages/guard/src/second-opinion.ts`:
`SecondOpinionPair` holds the two services and the header they last agreed
on; `pair.provider(primary)` wraps any `SimulationProvider` as an
`AgreeingSimulationProvider`; `applySecondOpinion` is the last step of every
check that simulates. The Engine (`apps/web/src/lib/engine.ts`) wraps every
Guard it builds that simulates (`Guard`, `TipGuard`, the `Guard` inside
`ScheduledBuyGuard`, the lazily built `VaultGuard`, `prove` included); only
the preview Guard, which simulates nothing, has none. A structural red-team
test reads `engine.ts` and fails on a Guard class it doesn't know. The same
address twice, after normalising, is ignored, and the strip says it doesn't
count.

**A check** agrees on a block, then test-runs on it; the steps, what is
compared and why each outcome is what it is: `docs/THREAT-MODEL.md`, "A second
opinion". In code: heads still more than `MAX_HEAD_GAP` (1) apart after the
retries are `heads`; an agreed header serves one quote's legs for 4 s; the
request names the block by hash (EIP-1898) and pins the next (number + 1,
time + 12 s, the agreed gas limit, zero fee recipient, randomness and base
fee), with an explicit gas limit per call (a vault batch's own, otherwise at
most 16,777,216); ether changes come from `traceTransfers`. The result is
`agrees`; a *reverted* outcome (`second opinion disagrees: …`, refused on
every path before `applySecondOpinion` names it `SECOND_OPINION_DISAGREES`);
`unavailable`, the second service failing (`SECOND_OPINION_BUDGET_MS`, 12 s a
check, included), which turns `verified` into `unverified` with
`SECOND_OPINION_UNAVAILABLE`; or `uncompared`, the main service failing first,
which passes only as `SIMULATION_UNAVAILABLE` with `detail.failure`. Reasons
are fixed phrases, never a service's error text, which could carry its key.

**In the app.** The setting is saved only after `testSecondOpinion` passes
(the configured chain, then a 1-wei ether transfer from a state-overridden
account, test-run on both, which must match). The status panel's SAFETY row
says whether checks run on 2 services. A scheduled buy left unverified is
skipped; a vault or Permit2 refusal it causes says the transaction waits until
both agree. Typed money is sized from rates both services agree on to within
1%, or from the main service alone when the second doesn't answer
(`lib/money/rates.ts`, the Engine's `secondOpinionRates`).

## Features, and what they map to

`packages/config/src/features.ts` holds the only mapping from a named
capability to the config changes it implies. A feature is a module plus
settings; the Features dialog edits features, the Expert view edits the config
directly, and both write the same object. No feature exists that config can't
express, since it would be a second source of truth. The catalogue shows which
features are modules (the module id) and which are host settings.

Amounts in money, Your activity, the finality badge, Welcome, Your stack, the
card, Collective DCA and Trust and exits are not features: no toggle, no
config. Each reads only when on screen or opened, or is a preference this
browser keeps (currency, number style, a hidden Welcome, a stack goal,
notifications), which in the config would mark it customised and add noise to
every shared link.

## Tip splits

- **`modules/tiplist-spx-community`**, a `tiplist` module answering "who can I
  tip?", with *no capabilities and no contracts*. It holds real entries only.
  Today that is one, spDEX's own donation vault (`kind: "builder"`), never
  pre-selected like every entry, which the host names from
  `SPDEX_DONATION_ADDRESS` (`@spdex/core`), so the picker calls it "spDEX's
  own" whatever a list says.
- **`apps/web/src/lib/tips.ts`**: each share comes from the balance the swap
  *actually delivered*, never the quote, so a tip never comes out of the
  user's slippage.
- **`packages/guard/src/tips.ts`**: a Guard path of its own, because a tip is
  a different action from a swap and needs its own proof, not an exemption.

Tips go out after the swap settles. One recipient is one ERC-20 transfer. Two
or more are one transaction through Uniswap's Permit2, in the order
`apps/web/src/lib/tipFlow.ts` follows:

1. **Permit2 is checked.** Its code must hash to `PERMIT2_CODE_HASH`
   (`packages/core/src/tips.ts`), Ethereum's (Permit2 bakes in its chain id);
   anywhere else, or unreadable, tips go as separate transfers.
2. **The standing permission, if short.** Permit2's allowance on the token is
   read (unreadable counts as short). The permission is built as its own plan
   (`TipPermissionPlan`, `approve(PERMIT2, max)`) and checked by the Guard now,
   test-run, before any signature; a refusal means separate transfers, with
   nothing asked of the wallet.
3. **The signature.** A random unused nonce (a random word and bit of the
   nonce bitmap, read first) and a deadline twenty minutes out. Before
   `eth_signTypedData_v4`, the Guard compares the exact string the wallet will
   get with `permit2BatchTypedDataJson` of the intent, byte for byte. The
   permit names the user as spender. A wallet that can't sign typed data gets
   separate transfers; a person who declines gets no tips.
4. **The permission is asked for**, when step 2 found it short, saying it is
   unlimited and standing until revoked. Declined, the tips go as separate
   transfers, and the result says the signature moves nothing by itself.
5. **The transaction.** `permitTransferFrom` to every recipient, encoded by
   the core function the Guard re-encodes with, checked byte for byte,
   simulated, and sent through the ordinary submitter, private sending
   included. One whose simulation only reverts (an account whose own code
   answers for its signatures, such as an EIP-7702 delegation), or whose
   signature expired meanwhile, falls back to separate transfers; any other
   refusal stands.

The signature comes first because it costs nothing and shows whether the
wallet can sign typed data before any standing permission is asked for. A
wallet that can't sign, or an account the batch reverts for, gets transfers
for the rest of the session, and the Tip row says so. Every prompt, tips
included, is numbered in one count ("step 3 of 5"). What the signature and
the permission expose, and what Revoke does: `docs/THREAT-MODEL.md`.

No contract of spDEX's is involved: Permit2 is deployed and has no owner. Its
standing permission is listed with **Revoke** in Settings → Tips, and it is
why the swap Guard refuses any plan that calls or approves Permit2
(`PERMIT2_TARGET`) and reads Permit2's own `Approval` and `Permit` events as
approvals in every simulation. Batching saves prompts, not gas: on the fork a
batch for two measured about 159,000 gas against 150,000 for two transfers,
and for five about 275,000 against 375,000. A random nonce word costs about
20,000 gas more than a sequential one, and needs no record of past nonces in
the browser.

### The tip registry: who can be picked, and who is paid

Three sources name an address; none is trusted for more than naming it. The
attacks each check answers (address poisoning, ENS, a bad default in an
update) are in `docs/THREAT-MODEL.md`.

- **The shipped list** (`modules/tiplist-spx-community/module.js`): `id`,
  `label`, `handle`, `address` (EIP-55), `ens` (shown, never resolved), `note`,
  `proof` (an https link to the person's own post; never fetched), `kind`,
  `listed`, and an optional `claim`, an EIP-191 signature over `"spDEX tip
  list: <address> is <handle>, <yyyy-mm>"`, shown as SIGNED only when it
  recovers the address. The module's header has the listing checklist; its
  tests hold every entry to `tipListProblems` (`packages/chain/src/tipList.ts`;
  the donation vault is `rules.own`) and every id to its first address in the
  append-only `shipped-ids.json`. An entry is retired (`retired: "why"`,
  `replacedBy`), never edited, and a recipient from a retired entry is skipped
  until the person keeps it (`keptRetired`) or switches. The page refuses a
  list only for a repeated id, and reads the shipped lists once there is a
  network service, tips on or off. The fields are optional on the wire
  (`WireTipCandidateSchema`), so an older module still loads.
- **The test entries** (`modules/tiplist-dev-fixtures`): anvil's accounts #1
  to #3, offered only on `PLACEHOLDER_CHAINS` (the fork, 690069, 31337). Off
  those, the public test mnemonic's twenty accounts (`PUBLIC_DEV_ACCOUNTS`,
  `packages/core/src/devAccounts.ts`) are skipped by the host and refused by
  the Guard.
- **"My tip list"** (`apps/web/src/lib/tiplist/store.ts`): localStorage
  `spdex.tiplist.v1`, not the config; up to 50 addresses with a private name,
  added by address or by ENS name, resolved through the person's own service
  only (`packages/chain/src/ens.ts`: no CCIP-Read, no wildcard parents) and
  saved as the address. Checks before saving are in `tiplist/contracts.ts`,
  `tiplist/checks.ts` and, with a second opinion, `tiplist/lookup.ts`. It
  exports and imports as `spdex-tip-list.json`; a chosen saved address goes
  into the config as "My tip list", never with its private name.

**Who is paid** is one function, `tippableRecipients`
(`apps/web/src/lib/tiplist/checks.ts`); the transfers (`tipTransfersFor`), the
counts, the summary card and the Tip row all take its answer, never
`config.tips`. It skips a recipient neither listed nor `confirmed`, a retired
entry not kept since, a public test account off a test network, a known
contract, and the connected account; a skipped share is not sent and not
spread over the others. Tags (LISTED, MINE, UNLISTED, RETIRED) come from
matching the address against the lists, never from what a config says about
itself. The first tip to an address the list doesn't vouch for waits on the
Tip row for **Tip this address**. When storage holds no list yet,
`migrateTipList` stamps the recipients already in the config confirmed, once;
a list storage can't read, or one saved by a newer build, is never written
over.

The Guard relies on none of it. `tipIntentViolations` refuses, as
`TIP_MALFORMED` with a `detail.reason`, a transfer to the tipped token
(`token-contract`), Permit2 (`permit2`), `0x…dEaD` (`burn`), a public
development account off a test network (`public-dev-account`), and any
contract the host passes in `refuseRecipients` (`known-contract`: the listed
tokens, every listed release's vault factory, batcher and implementation, the
SPX holder registry, the venues' contracts). Refusal only, so it narrows what
passes and never widens it (`packages/guard/test/redteam/tips.test.ts`,
`tips-permit2.test.ts`).

## Pool statistics

A module may only call contracts its manifest declares, and a pool's address
isn't known until a factory returns it. The way through: **the broker checks
a call's target, not its arguments**. `balanceOf(pool)` is a call to the
*token*, whose address is fixed, with the pool as a parameter. So
`modules/tracker-pool-stats` reads the true balance any pool holds while
declaring three token contracts and nothing else, and the broker needed no
change. A pool holding a token the tracker didn't declare comes back
`supported: false`, never a fabricated zero, which would look like an empty
pool.

Three sources meet in `apps/web/src/lib/stats.ts`, kept apart: the
**tracker** reports balances, sandboxed and untrusted; the **host** reads
volume from Swap logs, because `eth_getLogs` is a far larger surface than a
batched `eth_call` and no module capability; the **oracle** prices it, with
the same time-weighted feed the Guard cross-checks swaps against. None of it
is in the path of a signature, so every figure degrades to *unknown*, never
zero, including when an endpoint caps log queries: the reader steps the
window down until one is accepted, and the column says which period it
covers.

## Money

Money is how an amount is typed and how a figure is shown, nothing more. What
is quoted, saved, checked and signed is always a token amount: the Guard never
sees a currency, a plan's config keeps `amountPerBuy` in base units, and no
rate ever refuses or changes a plan. What a wrong rate can and can't do:
`docs/THREAT-MODEL.md`.

**Two rates, both read through the person's network service.**

- **Dollars**: spDEX's 10-minute average in USDC (`Engine.usdRates`), the same
  oracle instance the Guard uses. Ether is priced as WETH, and USDC counts as
  exactly one dollar; a note says when Chainlink's USDC/USD is more than 1%
  away.
- **The other 16 currencies**: Chainlink's dollar price of each
  (`packages/chain/src/fx.ts`; proxies in `CHAINLINK_FEEDS`, `constants.ts`,
  whose `description()` and `decimals()` the fork integration test re-reads).
  All 16 and USDC/USD come back from one Multicall3 `aggregate3` call, the
  same whatever currency the person chose, so the request says nothing about
  where they are and switching currency reads nothing. Currencies with no feed
  on Ethereum (INR, HKD, SEK, NOK, PLN, ZAR) aren't offered.
- **An answer is unknown** when its call failed, it is zero or less, it was
  never updated, its decimals differ from the table (read in the same call, so
  a repointed proxy can't scale amounts by 10¹⁰), it is older than
  `FX_MAX_AGE_SECONDS` (432,000 seconds, five days: a weekend's 49-hour
  market close, a 24-hour heartbeat and a holiday) by chain time, or it is
  outside 0.2× to 5× of its answer at `FX_REFERENCE_BLOCK`, refreshed at each
  release.

**When they are read** (`apps/web/src/lib/money/rates.ts`): only when
something on screen needs them, then dollars every 5 minutes and currencies
every 15 while the tab is visible and something still needs them. A failed
refresh keeps the last answer for display for up to 30 minutes and retries
after a minute. Rates belong to the service that answered them; a new service
drops them.

**Sizing, the part that moves money** (`lib/money/resolve.ts`,
`lib/money/convert.ts`). Integer arithmetic with one division, rounded down,
then cut to six significant digits (`floorSignificant`), so the amount signed
is one a person can read back: $20 at 2,451.31 USDC per ETH is 0.0081589 ETH,
a vector the unit tests pin.

- **Frozen.** A money amount is sized against one set of rates and kept with
  them. No re-render or background refresh sizes it again; a newer price is
  offered ("Newer price from 14:07 · Use it"), never applied.
- **Fresh, or no button.** Get price and Start are enabled only while the
  dollar price it was sized with is at most 5 minutes old by the tab's own
  `performance.now()`, and the tab hasn't been hidden since. Otherwise the
  field offers "Use the price now" and shows the new token amount first.
- **Bound to its currency.** An amount in euros needs a valid euro answer from
  the same read, or it is refused; it is never sized as dollars. A "≈" figure
  may fall back to dollars, with a note; sizing never does.
- **Token first.** Confirm lines lead with the token amount and name the money
  typed and when its price was read ("You pay 0.0081589 ETH ($20.00 at
  14:02)"), never echoing it back through the same rate. A change to the
  resolved amount clears a quote on screen.
- **Kept current, within a budget** (`lib/quoteRefresh.ts`). A One-time price
  on screen is asked again every 30 seconds while the tab is visible, at most
  ten times after someone asked, and not after a refresh that brought no
  price (each price is about eight requests, perhaps on the built-in key every
  visitor shares); once they stop, or while a banner asks, Refresh price
  appears. The old price and its Swap stay until the new one lands. A refresh
  never runs during a swap, over its result or an error, and never sizes a
  money amount again.
- **No repricing.** A plan typed as $20 saves the token amount and spends
  exactly that at every buy; the form says so before Start, and that paying
  with USDC is how to spend the same dollars each time.

**Parsing** (`lib/money/parse.ts`, `parseDecimal`). No amount is read as a
different one than the person meant: `0,5` from a comma-decimal keypad is
never 5 ETH. The marks come from `Intl` for the person's number style, plus
what keyboards actually type (a plain space for a narrow one, `'` for `’`).

- Grouping is accepted only where it can't be misread (`10,000.5` pasted from
  a balance). `1,500` or `1.500` alone is refused with a choice of its two
  readings; a mark that doesn't fit the style is refused with a one-tap fix;
  another currency's symbol is refused rather than guessed (`$` is also the
  peso's).
- A whole-number field (yen, won, rupiah, a plan's count) reads the format's
  own group mark as grouping and offers any other mark only its whole-number
  reading.
- Arabic, Persian and Indic digits, and the Arabic decimal and group marks,
  are read as typed; "Automatic" shows Latin digits.
- Fields are written back with `formatAmountForField` (the locale's mark, no
  grouping); `formatAmountExact` stays machine format for code.

**Preferences** (`lib/money/prefs.ts`, `spdex.money.v1`). The currency, the
number style and each field's unit belong to the browser, like the theme, and
never enter the config, an export or a share link. A fresh browser starts in
the currency of the first language tag that names a region (`es-AR` → pesos;
a bare `es` means dollars), in that currency's unit rather than ETH. The token
amount is always shown under it.

No price chart, price history, value of anyone's holdings or average cost. The
ticker's "% to flip" stays in dollars, the meme's own unit.

## Records

Your activity, the finality badge, Your stack and the "I bought" card are what
this browser records and what it can show from the chain. Unknown is never
zero in any of them.

**What is recorded** (`apps/web/src/lib/records/store.ts`,
`spdex.receipts.v1`): a swap once it settles, a partial one too
(`ExecutionError` with legs done), with its tips; plan buys from the auto-buy
ledger; vault buys from the chain. At most 1,000 swaps and tips, oldest
dropped first with a note, written under one Web Lock (`spdex.receipts`),
never over a record it can't read, and never in the config, an export or a
share link.

**Rows are the chain's account** (`lib/records/build.ts`, `attribution.ts`).
A row's account is its first transaction's receipt `from`, read once and kept
with the fee and the block; a row whose receipt can't be read has its wallet
unknown and is left out of totals. Sold is the transaction's value for ether
and `Transfer` logs from the account for tokens; bought is `Transfer` logs to
it. Nothing comes from the quote.

**Value at the time** (`lib/records/values.ts`): `twap-seen`, the rates this
browser held when it saw the trade settle, if read at most 10 minutes
earlier; else `chainlink-at-block`, only when the person presses "Fill in
values from the chain" (Chainlink's answers at the trade's block, one
Multicall3 `eth_call` per block, at most 200 per press, from a service that
keeps old state). A trade that sold SPX stays blank (nothing on chain prices
SPX at a past block), and a row of buy fees has empty sold and value cells,
never 0. Each source keeps every currency's answer, so changing currency
blanks nothing known.

**Vault buys.** A buy whose fee went back to the owner (their **Trigger
now**, or any call that named them, their own Help run batch included) has no
buy fee. Only a buy the owner sent has a network fee, unknown until its
receipt is read; one their own batch made is carried by that batch's row of
buy fees received, which counts only other people's vaults
(`feesEarnedFromOthers`). Each buy says who made it (`buyMaker`): the owner;
someone else, with the fee back to the owner; a community keeper; or anyone,
after the community window. An earlier test deployment buy (no window) gets
no maker line rather than a guess.

**Reads.** None until Your activity is opened, Your stack comes on screen, or
Welcome waits for a first buy; then one receipt per transaction not yet cached
and each vault plan's history, best effort.

**The file and the statement.** The CSV (`lib/records/csv.ts`,
`spdex-activity-v1`) is machine format, quoted per RFC 4180, with a leading
`'` on any cell a spreadsheet would run as a formula. Its last four columns,
after the first twenty, are `made_by` (`you`, `fee-returned-to-you`,
`community-keeper`, `anyone-after-window`, or `keeper` for an earlier test
deployment buy someone else made), `caller`, `fee_paid_to` and
`due_since_utc`, blank when unknown or not a vault buy. What the file leaves
out is said on screen and on the statement, never as a trailing row. The
statement is a print-only container and `window.print()`: per-token totals,
no averages, "Not tax advice".

**Reminders** (`lib/reminders/`). A confirmed plan can go into a calendar as
an `.ics` file (RFC 5545; no address, key or hash): one repeating event for a
whole number of days, the next 48 buy times for an hourly plan, none under an
hour and none for a vault. An open tab can notify when a buy falls due while
it is hidden and, with its own box in Community keeping, when the connected
wallet's proof has five days or less left (`lapse.ts`, from the panel's last
read). Permission is asked only when a box is checked, and a notification has
no icon, image or badge, any of which would be a fetch (`no-requests.test.ts`
fails on one). No push service: Web Push needs an application server
(rule 5).

**Included → Final** (`lib/finality.ts`, `components/trust/FinalityBadge.tsx`).
"Final" is the service's `eth_getBlockByNumber("finalized")`; a service that
reports none leaves finality unknown. The receipt is polled every 12 seconds,
one finalized-block read every 30 seconds serves the whole page, the block is
read again at the end to notice a replacement, and after 45 minutes the badge
stops and points to an explorer. On the local fork `finalized` is 64 blocks
behind the head.

**Your stack** (`lib/culture/stack.ts`). Holding is one `balanceOf`. Stacked
is this browser's measured buys plus each vault's own `totalOut`, never vault
logs, which a service may serve only in part. Put in is what was sold for SPX,
valued where known ("for 20 of 23 buys"). The goal counts Holding. No value
now, no gain or loss, no projection.

**The card, and checking it** (`lib/culture/card.ts`, `receipt.ts`). The
preview is JSX; the PNG is that mounted SVG drawn from a `data:` URL onto a
1,200 × 675 canvas and saved through `lib/download.ts`. It shows the amount,
the date, the network and the hash, never a price, and nothing its
`#receipt=` view doesn't check, so not who made a vault's buy
(`card.test.ts`).

- A `#receipt=<chain>:<hash>` view trusts the card for nothing: it reads the
  transaction through the viewer's own service and counts only SPX `Transfer`
  logs, naming a vault only when a listed factory vouches for it (`isVault`).
  What it counts as bought or tipped, and how that defeats a made-up card:
  `docs/THREAT-MODEL.md`, "Sharing what you did: the CSV, the statement and
  the card".
- Tips: each tip record names its swap (`forSwap`) and counts the addresses
  its receipt shows it paid (`recipients`). The card prints the count
  ("Tipped 3 people") only when the tips went in one transaction, with that
  hash beside the buy's, and the link carries both,
  `#receipt=<chain>:<buy>+<tips>`; a failed tip transaction tipped nobody.
- With no service chosen, the view says why it waits and reads nothing.

**Addresses a file carries** (`lib/links.ts`). A card or calendar file
outlives the tab, so its link is a build setting, `VITE_SPDEX_APP_URL`, never
the address bar (a dev server, a shared gateway, a stranger's copy); unset,
the file has no link and says so. Verify this build's `git clone` line and the
two doc links Help run and Community keeping show come from
`VITE_SPDEX_SOURCE_URL`, with `/blob/HEAD/<path>#<anchor>` appended, and are
left out when it is unset.

## Recurring buys

A plan runs one of two ways. **Confirm each buy myself**, this section: the
owner's wallet approves each buy, run by a tab. **Set and forget**: a vault on
chain with no tab ("No contract anyone controls", below), sharing only the
form and the list of plans. Each defence below, as an attack it stops, is in
`docs/THREAT-MODEL.md`.

A plan is set up in the Recurring tab of the **Buy SPX** tile and runs from
its card in the **Auto-buys** tile (`apps/web/src/components/dca/`). Those
screens display and ask, and never sign, send or check anything.
`apps/web/src/lib/dca/useAutoBuy.ts`, the one React hook under `lib/`, wires
the rest to the page: one `DcaRunner` per tab, built while auto-buy is on and
rebuilt when the engine or the config changes, and each click turned into the
one call it means.

**The config holds the plan.** A plan in `dca.plans` says what to sell and
buy, how much, how often, how many times, from when, and which way it runs.
There is no "forever": the most it can spend, `amountPerBuy × maxBuys`, is
known before it starts. Its only addresses are the two tokens and a vault
plan's vault, a public fact; no account, key or history, which a shared link
would leak. Every plan arriving from outside this browser arrives paused:
`arrivePaused` runs inside `importConfig`, the one funnel a link and a pasted
file share.

**This browser holds the record** (`apps/web/src/lib/dca/ledger.ts`,
localStorage): which wallet a plan buys for, which address signs, buys
settled, budget committed, the last buy window used. An unreadable record is
`"unavailable"`, never empty, and nothing buys until it reads. A missing one
means the plan shows as not started here and doesn't buy (the Guard counts a
missing record as a spent budget); starting the plan writes a fresh record,
which only the owner can do.

**The scheduler module proposes.** `modules/scheduler-dca`, with no
capabilities and no contracts, gets the plans, what each has bought and the
host's time, and answers which buys are due now, how large, and when each
plan's next could be. Time is divided into windows of the interval ("buy
times" on screen); only the one open now is ever due, and one missed while no
tab was open is recorded and skipped, never made up.

**The host and the Guard hold the envelope.** `vetScheduleDecision` refuses,
before any quote, a buy for an unknown plan, a second one for a plan, a window
other than the open one or one already used, an amount empty or larger than
the plan's, or a plan with no buys left. What survives is quoted fresh by
`Engine.quoteScheduled` (the plan's recorded signer as account, its owner as
recipient) and judged by `ScheduledBuyGuard`: pair, chain, signer, delivery to
the owner only, a price floor on every leg, one buy's worth across legs, the
budget against what is committed, the window, an interval of at least
`MIN_DCA_INTERVAL_SECONDS`, and then every leg through the unchanged swap
Guard, which must say `verified`. It wraps the Guard rather than adding an
option to it, so it can only add refusals.

**Claim before signing.** After a signable verdict and before the first
signature, the buy's window and full `maxAmountIn` are written to the record,
and given back only when spDEX can tell nothing was bought: a crash costs a
skipped buy, never a second one. When spDEX posts the signed bytes itself
(a private send), it records the hash first. A wallet that broadcasts reports
the hash only after sending, so a wallet-mode claim also records the owner's
next nonce: once that nonce is used, the buy counts as made, whatever went out
in its place, and it is given back only if the nonce is still unused after the
buy's deadline has passed on chain.

**One tab acts.** A Web Lock, `spdex.dca.leader`, held for the tab's life,
picks the tab that runs auto-buys; the others take over when it closes.
Without Web Locks nothing runs, and the runner says why.

**A wallet-mode buy never opens the wallet on a timer.** A due buy waits for
`confirmDue`, the card's **Confirm buy**, which re-quotes, re-checks and
claims, and only then opens the wallet. A buy time that ends unconfirmed is
recorded as not confirmed.

**No spending wallets.** spDEX holds no key for a plan. Config version 8
removed the signer that did (`autopilot`, a key the browser generated per
plan; `DCA_SIGNERS`, `packages/core/src/dca.ts`); a vault sets and forgets
without one. The app neither reads nor withdraws spending wallets.

**What it deliberately does not do.** Scheduled buys never tip. Each uses one
market (`maxSplits = 1`), so a buy is one transaction, two for a token sale.
An oracle warning asks before the wallet opens (the verdict stays signable:
the oracle never refuses), and "Buy anyway" re-quotes and goes ahead only if
the divergence is no larger than the one the owner saw. Three buy times in a
row with a refused or failed buy halt the plan until the owner resumes it,
counted at the first failure in each.

Manual swaps and scheduled buys reach the chain through one function,
`executeQuote` (`apps/web/src/lib/execute.ts`), sending every call of every
leg, in order, from the account the verdict was checked for.

## No contract anyone controls

A tab-run plan stops when the tab does, and a server that ran plans would be a
backend (rule 5 in `AGENTS.md`) holding people's keys or money. So a vault
plan is a contract that holds the plan's budget and enforces the plan itself,
and it doesn't matter who sends each buy. The caller chooses *when*, inside a
due slot, and who receives the caller's own fee; never how much, what, to
whom, or at what price. A fixed buy fee from the vault pays for each buy, to
an SPX holder or the owner for the first minutes after it falls due and to
anyone after that.

The contracts are in `packages/vault/contracts`: `SpdexDcaVault`,
`SpdexVaultFactory`, `SpdexVaultBatcher` and `SpxHolderRegistry`. They are on
mainnet since block 26,134,915 (addresses below), unchanged for good.
`docs/DESIGN.md` is their design; its numbered decisions are cited here by
number. The earlier test deployment (release id `v1`) stays on mainnet too:
the app, the keeper and the report serve every factory in `DEPLOYMENTS`, and
its source is frozen in `packages/vault/releases/v1`.

**Nobody controls them.** No owner, admin, fee, upgrade path or pause switch
anyone else holds. Any keeper, one spDEX's developers may run included,
collects each vault's buy fee on the buys it makes. A vault's terms are part
of its code and its implementation part of its proxy, so there is nothing for
us, or anyone who takes this repository over, to switch. They are
**unaudited**: whoever chooses a vault trusts their code with what they put
in, which is why every vault's budget is capped at 0.5 ETH (`MAX_FUNDING`) and
the app marks the choice **Unaudited** wherever it offers it.

### What a vault can and cannot do

A vault is one plan: buy SPX with WETH, `amountPerBuy` at a time, one buy per
slot of `interval` seconds from `startAt`, at most `maxBuys` times. Every
refusal it makes, by error name: `docs/THREAT-MODEL.md`, "An auto-buy vault".

It can:

- make at most one buy per slot, and none sooner than half an interval after
  the last, so one push of the price can't cover two slots' edges. A slot
  nobody triggers is skipped, never made up later;
- swap on its market's Uniswap v2 pair, paying the output straight to its
  owner, and refuse (`DeliveredShort`) if the owner received less than the
  pair sent;
- refuse a buy priced more than `maxSlippageBps` below its price reference;
- pay the buy fee (`keeperReward`) in WETH, never as raw ether, to the
  `rewardTo` its caller names in `execute(rewardTo)`, which may not be zero or
  the vault (`BadRewardTo`);
- take more budget (`fund`, sending back what the remaining buys and fees
  don't need), return everything (`close`, as ether, or as WETH to an owner
  that refuses ether or when unwrapping fails; callable again to sweep what
  arrives later), and hand the owner any token sent by mistake (`rescue`;
  WETH only once closed).

It cannot:

- change a term, pause, or be upgraded: `close` is the only way to stop it;
- send its money anywhere but into a buy delivered to its owner, the fee to
  the named `rewardTo`, or back to its owner;
- buy a token, or use a pair or pool, its factory did not list;
- take more than 0.5 ETH from its owner: creation refuses a budget (every buy
  plus its fee) above `MAX_FUNDING`, and `fund` stops at what the remaining
  buys need. Anyone can still send it WETH, even before it exists, and
  `close` returns that too. The cap is per vault;
- wake itself up. A plan runs only while somebody triggers it.

**The price floor.** Each buy must deliver at least `amountPerBuy` worth of
SPX at a Uniswap v3 pool's price, less `maxSlippageBps` (up to 5%; the app
offers 1%, 2% or 3%). The price is the better, for the owner, of the pool's
10-minute average, which a swap in the buy's own block can't move, and its
price now, since an average lags a market that just fell. The pool must have
at least 10 WETH of depth behind its price (`MIN_ORACLE_DEPTH`, a harmonic
mean over the same ten minutes), checked at every buy. This floor refuses
where the app's oracle only warns, which is what rule 2 in `AGENTS.md` warns
about: whoever moves the average can make buys wait. It is the right trade
here because nobody watches these buys to read a warning, the alternative is
no floor, and what it costs the owner is skipped slots, not money.

### The community window

Without it, a due buy's fee goes to whoever calls first, in practice the
fastest searcher's bot. The community window gives SPX holders first claim on
each buy's fee, without changing who may *make* the buy or anything about it.
Who may be paid, and when, as a table: `docs/DESIGN.md`, "How a buy works";
its threats and limits: `docs/THREAT-MODEL.md`, "The community window and the
SPX holder registry".

`execute(address rewardTo)` takes one argument, who receives this buy's fee:
any two `rewardTo` values the vault accepts give byte-identical buys, only the
fee's recipient and the count below differing
(`testFuzz_anyTwoAcceptedRewardTosMakeTheSameBuy`; decision 11). Naming the
recipient lets the vault check who is paid, not who sent the transaction, so a
keeper can sign with a hot key and be paid in a cold wallet, and a batcher in
the middle hides nothing.

**When a buy falls due.** The window runs from `dueSince`, the later of
`nextBuyAt` and the start of the current slot, never from `nextBuyAt` alone,
which is already past after a missed slot (decision 10). So every slot's buy
gets its own first claim, and a window always ends inside its slot
(`testFuzz_aWindowAlwaysEndsInsideItsSlot`).

**Inside the window.** While `block.timestamp < dueSince + communityWindow`,
`rewardTo` must be the owner or an address the SPX holder registry finds
eligible, or the vault reverts `NotEligible(rewardTo, windowEndsAt)`. After
it, any address will do, and the registry is not asked
(`test_afterItsWindowABatchAsksTheRegistryNothing`). Who may send the
transaction never changes; who may be paid does. `rewardTo == owner` is
always allowed, so **Trigger now** works inside the window, and anyone may
make an in-window buy by paying the fee back to the owner at their own gas
cost (`test_theOwnerMayBePaidInsideTheWindow`); such a buy isn't counted as
the community's.

**A registry that fails.** The vault asks with a low-level `STATICCALL` and a
fixed stipend (`ELIGIBILITY_GAS`, 100,000), copying back one word; only a
success answering a whole word equal to `true` counts (decision 14,
`test_aRegistryThatFailsCountsAsNotEligible`). A broken registry delays a buy
until its window ends or the owner makes it, and never touches the money. The
stipend is about nine times an honest answer from cold (decision 38), and a
buy is charged only what the answer uses.

**The window's length** is a term, `communityWindow` seconds. The factory
refuses one outside `MIN_COMMUNITY_WINDOW ≤ communityWindow ≤ min(interval /
4, MAX_COMMUNITY_WINDOW)`, 60 seconds to an hour
(`CommunityWindowOutOfRange(communityWindow, minimum, maximum)`,
`test_theFactoryHoldsTheWindowToItsBoundsToTheSecond`), and every vault has
one (decision 4). The minute keeps first claim from being nominal (five
blocks), the quarter keeps a window inside its slot, and the hour bounds the
wait for the open fallback. `MIN_INTERVAL` is 300, so every plan allows at
least 75 seconds. The app proposes 30 minutes, or a quarter of the interval
when that is shorter (decision 3).

**Turns, shipped unused.** A plan may share its window's first half out in
turns (`turnBuckets`, a term: 0, or 2 to `MAX_TURN_BUCKETS`, 64). Every
address falls in one bucket (`bucketOf`: `keccak256(address) mod k`) and each
slot draws one (`turnOf`: `keccak256(vault, slot) mod k`). Until `dueSince +
communityWindow / 2`, a `rewardTo` other than the owner must be eligible and
in that bucket, or the vault refuses `NotYourTurn(rewardTo, turn,
turnEndsAt)`. One 690 SPX moved into each bucket's address inside each buy's
own transaction can serve them all, so turns share first claims among
addresses, not necessarily holders (`docs/DESIGN.md`, "Risks and failure
modes"). The app creates every plan with none (`DEFAULT_TURN_BUCKETS`) until
decision 29 trips; then an app release, with nothing deployed, starts using
them (decision 35). A buy inside its turn costs about 1,000 gas more
(`test_whatTurnsCostABuy`). The keeper and Help run the network skip a vault
whose turn or window their `rewardTo` can't be paid in.

**What it records.** `windowBuys()` counts buys made inside their window and
paid to someone other than the owner, in the storage slot that already holds
`_buysDone`, `_lastBuyAt` and `_closed`, so it adds no storage write
(decision 13). `status()` returns `dueSince`, `windowEndsAt`, `turnEndsAt` and
`turn` beside the plan's progress, worked out exactly as `execute` works them
(`test_statusAgreesWithExecuteAtEveryEdge`).

**Two edges, by design.** A first buy whose window ended before its vault
existed, and a buy possible only after its window ended, are open to anyone
at once (`docs/THREAT-MODEL.md`, "The community window and the SPX holder
registry"): the contract records no creation time, which would tie a vault's
address to its block. So for a window under three minutes the app starts a
"first buy now" vault `vaultStartLead` (`120 + 60 − communityWindow` seconds,
105 for a five-minute plan) after the chain's time, leaving at least a minute
of first claim to a creation that takes two minutes to land.

**What it does not stop.** A flash borrow can meet the balance check at the
buy (decision 17), and a bot that buys 690 SPX and proves it is a community
keeper like anyone. None of this reaches the owner's money: at worst a fee
goes to someone the window was meant to keep out, as any fee after the window
may.

### Clones

Each vault is an EIP-1167 minimal proxy: 45 bytes that delegate every call to
one implementation, which the factory deploys, with the plan's terms appended
to the clone's own code (117 bytes; `libraries/VaultArgs.sol`). The registry's
address is an immutable of the implementation, the same for every clone. A
clone costs about 177,000 gas to create (`test_gas` in `Vault.t.sol`), about
29,000 of it the factory's list (below), and each call about 5,000 more.

The terms live in code because nothing can write code after deployment. There
is no initializer: the creating transaction writes the terms as it deploys the
clone, so there is nothing to call first or front-run. Each call reads them
with `EXTCODECOPY` of its own address, which under `delegatecall` is the
clone; `CODECOPY` would read the implementation, which carries no terms
(`test_codecopyReadsTheImplementationNotTheClone`). The implementation itself
refuses every call about a plan (`NotAClone`).

A clone's address comes from CREATE2, salt `keccak256(owner, nonce)`, over
code that carries the terms, so it commits to the owner and every term.
`predictVault` gives it before mining, and the Guard proves a vault is the
account's, on the plan's terms, by recomputing it. A clone made by hand runs
the same code with whatever terms its maker wrote; the app, the keeper and the
report trust only vaults a listed factory vouches for (`isVault`, or the
address recomputed from it).

### What the contracts tell the chain

The events carry what the report would otherwise need archive reads for:

- `Bought(slot, amountIn, amountOut, keeper, reward, floorOut, buyNumber,
  oracleDepth, rewardTo, dueSince)`: the floor the buy was held to (the fair
  amount is `floorOut × 10,000 / (10,000 − maxSlippageBps)`); the vault's buy
  count, so a missing log shows as a gap, which slot numbers can't; and the
  oracle pool's depth at that buy, the data that says whether
  `MIN_ORACLE_DEPTH` (10 ETH) is right (together about 900 gas a buy).
  `keeper` is the caller, an account or a batcher; `rewardTo` (indexed) and
  `dueSince` say who was paid and whether inside the window (decision 13).
- `VaultCreated(owner, vault, marketIndex, terms, funded)`, `funded` being the
  ether sent with the creation, so deposits are exact from the contracts' own
  events.
- `Proven(holder, blockNumber, balance, validUntil)`, from the registry, the
  public record of who has proven what, since it keeps no list.
- **The factory's list**: every vault it creates, append-only, read with
  `vaultCount()` and `vaultsPage(offset, limit)` (at most 1,000 a call), so a
  keeper finds vaults with no `eth_getLogs` range limits and no start block.
  It is written in the same call as `isVault`, so it is the same fact and
  gives nobody control; about 29,000 gas per creation, once.

Nothing records which frontend or keeper was used: a marker in calldata or an
event would fingerprint the people using it. `rewardTo` is no such marker; it
is who was paid.

### The market list

A plan does not name a token, a pair or a pool. The factory's constructor
takes a fixed list of markets, each a `(tokenOut, v2 pair, v3 oracle pool)`,
and a plan names an entry by index. On Ethereum, and so on the fork, the list
has one entry: SPX, traded on its Uniswap v2 pair
`0x52c77b0cb827afbad022e6d6caf2c44452edbc39`, its floor read from its 0.3%
Uniswap v3 pool `0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3`.

An open choice of market caused the worst findings of the security reviews: an
empty or thin genuine v3 pool makes the floor meaningless, a pool can be made
"deepest" for the minutes in which the choice is made, and a hostile token can
trap whoever pays for a buy's gas. A fixed list closes all three. The
constructor refuses an entry unless:

- the pair is the one Uniswap v2's factory lists for WETH and the token;
- the pool is the one Uniswap v3's factory lists for WETH, the token and the
  pool's own fee tier (an imitation answers `token0` and `fee` like the real
  thing; only the factory's mapping tells them apart);
- the pool keeps at least 100 observations and has at least 10 WETH of depth;
- the pool's 10-minute average is within 2% of the pair's mid price
  (`MAX_MARKET_GAP_BPS`);
- no token appears twice.

Depth is checked again at every buy; the pool–pair agreement is not, or anyone
moving the pair in the same block could stop a vault. These checks vet
markets, not tokens: a keeper-trap token with a genuine, deep market passes
them all (`test_r5b_aKeeperTrapTokenWithGenuineMarketsPassesEveryListingCheck`),
so tokens are vetted by hand. **Another list means another factory, at
another address.** No function adds or removes a market.

### The SPX holder registry

`SpxHolderRegistry` decides one thing, asked inside a buy's community window:
may this `rewardTo` be paid? It never touches a vault's funds, holds no tokens
or ether, and has no owner, admin, setter, upgrade, list or deposit. Its only
storage is one time per address that has proven, `validUntil` (mapping slot 0,
`test_validUntilIsMappingSlotZero`).

```solidity
interface ISpxHolderRegistry {
    function prove(address holder, bytes calldata header, bytes[] calldata accountProof,
        bytes[] calldata storageProof) external returns (uint64 validUntil);
    function isEligible(address holder) external view returns (bool);
    function validUntil(address holder) external view returns (uint64);
    event Proven(address indexed holder, uint256 indexed blockNumber, uint256 balance, uint64 validUntil);
    error NotNewer(uint64 validUntil);
}
```

**Eligible** (`isEligible`) means a proof still valid through `validUntil`
(checked first, so an address that never proved costs one storage read), an
account (no code, or only an EIP-7702 delegation designator, which only its
own key can put there), and at least `MIN_SPX` held now, by SPX's `balanceOf`.

**Accounts only,** because a contract can hand what it is paid to whoever
asks, so with contracts eligible a bot with no SPX could take every window's
fee (`test_aProvenContractThatHandsOutWhatItIsPaidIsNeverEligible`; the case,
and what it costs a contract wallet: `docs/THREAT-MODEL.md`, "The community
window and the SPX holder registry"). Code is judged at the moment of the buy
(`test_eligibilityIsJudgedOnTheCodeAtTheMomentOfTheBuy`).

**`prove`** records that `holder` held at least `MIN_SPX` when a recent block
closed. Anyone may send anyone's proof; `msg.sender` appears nowhere in it
(`testFuzz_anyoneMayProveAnyHolder`), so a hot wallet can prove a cold
`rewardTo`. In order:

1. It reads the block header (RLP) for its state root, number and timestamp
   (fields 3, 8 and 11) and requires its hash to equal the block's real hash,
   read from the chain, never the caller: `BLOCKHASH` for the last 256 blocks,
   EIP-2935's history contract (`HISTORY`) for the last 8,191. Any other block
   is `UnknownBlock`; a mismatch is `WrongBlockHash`.
2. It follows `accountProof` from the state root to SPX's storage root.
3. It follows `storageProof` to the holder's balance, at
   `keccak256(abi.encode(holder, 1))`.
4. It requires at least `MIN_SPX` (`BelowMinimum`) and sets `validUntil` to the
   block's time plus `PROOF_TTL`; a proof that wouldn't move it later reverts
   `NotNewer` (decision 16), so a private relay drops it.

**The verifier is not written here.** Steps 2 and 3 use Optimism's
MIT-licensed `SecureMerkleTrie` and RLP reader, vendored under
`contracts/vendor/optimism` at tag `op-contracts/v8.0.0` (commit `f45a5ccf…`)
with only their import paths changed; its README gives each file's hash and a
command to check them, and review starts there. The registry adds only the two
value shapes it expects (`BadProofValue`).

**Which block.** The app and the keeper prove the `finalized` block, about 13
minutes old, with `BLOCKHASH` as the fallback if a hard fork moves EIP-2935
(why: decision 15).

| Constant | Value | Basis |
|---|---|---|
| `SPX` | `0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C` | A plain contract, not a proxy; 8 decimals; 1,000,000,000 supply (checked 2026-10-02) |
| `BALANCE_SLOT` | 1 | Checked against `balanceOf` for three holders (`test_theConstantsAreTheAgreedOnesAndTheSlotIsSpxsBalance`) and for every recorded proof |
| `HISTORY` | `0x0000F90827F1C53a10cb7A02335B175320002935` | EIP-2935, live on mainnet |
| `HISTORY_BLOCKS` | 8,191 | EIP-2935's reach, about 27 hours |
| `MIN_SPX` | 690 SPX (`69_000_000_000`) | Decision 1: within reach of ordinary holders (about $293 at $0.4243 on 2026-10-02); a bot can carry it too |
| `PROOF_TTL` | 30 days, from the proven block's time | Decision 2 |

All are constants. Changing one is a new registry, and with it a new factory,
which names the registry in its constructor: a new contract release.

**What it costs** (fork, pinned block, `Registry.t.sol`). `prove` about
655,000 to 685,000 gas as a transaction, once every 30 days: 520,000 to
550,000 the call, nearly all of it the vendored reader decoding nodes, and
the rest its 8 KB of calldata and the 21,000 every transaction pays; about
0.00007 ETH at 0.1 gwei. `isEligible` about 11,200 gas cold and 2,200 warm.
Inside a buy, 9,463 gas when the holder sends it; in a batch paying one
`rewardTo`, 9,006 once and 3,001 for each later buy (`WhatV2AddsGasTest`,
`BatchGas.t.sol`).

What it can't stop and what proving makes public: `docs/THREAT-MODEL.md`, "The
community window and the SPX holder registry"; why proofs and not a deposit:
decision 8.

### One address, checkable from source

Every contract is deployed through the standard deterministic deployer
(`0x4e59b44847b379578588920ca78fbf26c0b4956c`) with a fixed salt, so each
address depends only on the bytecode and the constructor's arguments. The
factory's bytecode includes the implementation's, and its arguments are WETH,
Uniswap's two factories, the market list and the registry; the batcher's one
argument is WETH. So the registry's address pins its code, the factory's pins
the implementation, the markets and the registry, and the batcher's pins its
code on any chain's WETH. For Ethereum:

| Contract | Salt preimage | Address |
|---|---|---|
| SPX holder registry | `spdex.vault.registry.v2` | `0x2c7f732a453fe0a4a65f36ac564ff16007b5610d` (block 26,134,915) |
| Factory | `spdex.vault.factory.v2` | `0xbf40f0fb41e5ee1194173545749d80c4651bac32` (block 26,134,916) |
| Vault implementation | (deployed by the factory) | `0xeba51b96621f0fce83e017c0a46330c8cde323db` (block 26,134,916) |
| Batcher | `spdex.vault.batcher.v2` | `0xd1f8327aa8398997bd88165f420412c703ebfed0` (block 26,134,918) |

Each salt is the keccak256 of its preimage. The registry goes first: the
factory refuses one with no code (`NotARegistry`). The earlier test
deployment (release id `v1`: factory
`0xe4a1410a9ee0833d41e7514306e65ad729b7199e`, block 26,100,366;
implementation `0xb32b5e1092de9596877be9b6c783c7e98b55b1c6`; batcher
`0xc5ce65451dd5fc99d08eb18440b06f2bcca3c5a0`, block 26,100,368) has vaults
whose `execute()` takes no `rewardTo` and has no window, and a batcher bound
to its factory that is paid each fee and forwards it.

Any byte changed in the registry or the vendored verifier moves the registry
and the factory; in the batcher, the batcher alone. The compiler is pinned
(solc 0.8.33), metadata hashes are off, and `via_ir` is never used (it would
move every address and gas figure), so two honest builds produce the same
bytes. `packages/vault/src/artifacts.ts` is generated from the build, and the
`contracts` stage of `pnpm verify` fails on a stale copy. Anyone can recompute
the addresses the app and the keeper trust, as anyone can check the bundle's
CID.

**Sources and releases.** A *source* is one version of the contracts' code; a
*release* is one deployment of a source, with its own constructor arguments.
`artifacts.ts` exports every source under its own prefix (`V1_*`, `V2_*`) and
as data, `SOURCES`, with `features` read from its ABIs
(`executeTakesRewardTo`, `communityWindow`, `turns`, `registry`,
`sharedBatcher`); the current source also has unprefixed names (`VAULT_ABI`,
…) for creating vaults. The app, the Guard and the keeper ask a release's
source what it can do (`featuresOf`, `packages/vault/src/releases.ts`), never
which release it is, so a release built from an existing source is one entry
in `deployments.json` and no code anywhere (decision 36).

**Frozen sources.** Before `contracts/` changes after a release built from it
reaches mainnet, that source is frozen: a verbatim copy under
`packages/vault/releases/`, a forge profile that builds it with the same
settings, and its `SOURCES` row in the build marked frozen.
`build:artifacts` refuses to write, and `--check` fails, unless every frozen
source still builds to its deployed addresses, so the app and the keeper go
on shipping its ABIs and anyone can check them. Today that is the earlier test
deployment's, `packages/vault/releases/v1`, built by forge's `v1` profile.

**Every release is listed, for good.** `packages/vault/deployments.json` is
append-only (its format and rules: `AGENTS.md`, rule 6). `artifacts.ts`
carries it as `DEPLOYMENTS`, each release with the batcher its vaults go
through, and `BATCHERS`. `build:artifacts` recomputes every entry and refuses
one that differs, so the hand-filled blocks are the only edit an entry gets.
No release is removed: the keeper and the report serve every one, so a new
release never orphans an old one's vaults. The app lists, funds, closes and
triggers vaults from every listed factory, and creates only on the latest.

**The one-time deployment.** On a chain with no code at the latest release's
addresses, the app offers the deployment: the registry, then the factory, each
through the deterministic deployer (`deployRegistryCall`,
`deployFactoryCall`; `deployReleaseCalls(release)` lists a release's calls)
and confirmed before the next. It moves nobody's money, so it is not a Guard
path: the app checks instead that each contract isn't there yet and that a
call of exactly that transaction returns the address it trusts. Anyone may
send it, and it lands at the same address whoever does. The deployer reverts
without a reason, so the app first runs the creation code as a plain call
(`simulateFactoryDeployment`) to name a market that fails a check, with a
state override standing in for a missing registry
(`factoryRefusalBeforeRegistry`), so a factory that would be refused is said
before anyone pays for the registry. Two people deploying at once is a race
nobody can close: the second creation collides and burns nearly all its gas
limit, about the factory's 4.1 million (`Factory.t.sol`); the app checks for
the factory's code again just before the wallet opens. `docs/RELEASE.md` has
the runbook and the gas it measured.

### The batcher

`SpdexVaultBatcher` makes many due buys in one transaction, so a keeper pays a
transaction's fixed cost once: a later buy on a busy oracle pool costs about
106,000 gas in a batch (its warm registry check included), and the batch about
152,000 once (`BatchGas.t.sol`).

- **One more caller, with no more rights.**
  `executeBatch(vaults, rewardTo, minRewards, gasPerVault)` calls each listed
  address's `execute(rewardTo)` as anyone may, and each vault checks its own
  terms and pays `rewardTo` directly, so the window check sees the real
  recipient. No owner, fee, setter, `receive`, or storage but a transient
  lock, and no WETH passes through it.
- **Bound to no factory** (decision 34). `earned` is how much `rewardTo`'s
  WETH rose during the call, which no contract in the list can inflate
  without paying it (`test_earnedIsWhatRewardToReceivedNotWhatTheVaultsClaim`).
  With no answer to trust, it needs no factory: built for WETH alone, it
  serves every release whose vaults take `rewardTo`, mixed in one batch if
  need be (`test_vaultsOfTwoFactoriesBuyInOneBatch`). It calls whatever it is
  given, at the caller's expense, so choosing vaults is the caller's job: the
  keeper lists only proven clones of listed factories, the Guard checks every
  vault of a batch the app sends, and the report counts buys only from
  `Bought` logs of vaults a listed factory vouches for.
- **WETH sent to it stays there.** It refuses itself as `rewardTo` and can't
  send WETH, so WETH sent to it, or a fee a direct caller of a vault names it
  to receive after a window, is stranded for good
  (`test_aFeeNamedToTheBatcherByADirectCallerStaysThere`). A sweep would put
  WETH back through it, so there is none.
- **Each vault gets exactly the gas the caller names**, `gasPerVault`, from
  `MIN_EXECUTE_GAS` (400,000, what the app and the keeper send:
  `MAX_EXECUTE_GAS_LIMIT`) to `MAX_EXECUTE_GAS` (10,000,000), so a fork that
  repriced a buy needs a new figure off chain, never a new batcher. A vault is
  attempted only while its cap after the EVM's 1/64, plus `ATTEMPT_OVERHEAD`
  (53,650), is left (460,000 at the least cap); the rest are `NotTried`, never
  failed. It copies 4 bytes of a revert and 32 of a success, so no vault can
  return-bomb it.
- **One refusal does not sink the rest.** A vault that refuses (beaten to it,
  the price moved, `rewardTo` not eligible inside its window or turn) is
  recorded (`NotTriggered(vault, reason, gasUsed)`) and the others buy. If
  none bought, the call reverts `NothingBought(reasons)`; if what it earned is
  under `minRewards`, `TooLittle`. A revert-protected relay then drops it, so a
  lost race costs nothing, and an `eth_call` of a hopeless batch says why each
  vault failed.
- **Why it is not a fee.** Rule 6 allows a payment only to the `rewardTo` the
  caller of `execute` names. The batcher passes its caller's `rewardTo` on;
  it keeps and charges nothing, and `minRewards` is a condition the caller
  puts on its own transaction.

The app calls only this batcher, from Help run the network ("Helping run the
network", below).

### The buy fee

A vault pays one thing to anyone but its owner: its `keeperReward`, which the
app calls the **buy fee**. It is fixed at creation, written into the clone's
code, and nothing can change it afterwards, spDEX included. The app proposes
it for a new vault from `packages/vault/src/fee.ts` (decision 9):

```
network part = 126,000 gas × 0.15 gwei = 0.0000189 ETH, the same for every plan
share        = 0.25% of the buy, rounded up
ceiling      = 0.69% of the buy, rounded down: the contract's own limit
buy fee      = the network part and the share, or the ceiling if that is less
```

The earlier test deployment's vaults keep the fee they were made with (the
network part at 122,000 gas and a tenth more, under the same ceiling;
`v1BuyFee`), and the keeper prices their buys by that rule.

- **0.69%** is the most a buy can pay anyone for being made, the network cost
  included: a contract constant (`MAX_REWARD_BPS` in `VaultLimits.sol`), so
  the factory refuses a higher fee whoever writes the terms, and nobody who
  makes buys or is named to be paid for them, spDEX's developers among them,
  makes more. The app's `BUY_FEE_CEILING_BPS` is read from the build, so it
  can't drift.
- **The share** (`BUY_FEE_SHARE_BPS`, 25 basis points) is what a keeper is
  paid, beyond its gas, for making someone else's buy; it grows with the buy.
  A buy pays the same inside its window as after it (decision 5). A larger
  fee is a larger prize for a bot holding 690 SPX, which the report's
  concentration figure watches. A release may change the default under the
  ceiling for plans created after it; none can pass the ceiling without a new
  factory.
- **The network part** is one batched buy's gas: 110,000 for a later buy on a
  busy oracle pool, inside its window, paid to a community keeper
  (`BATCH_PER_BUY_GAS`; measured 105,969), plus a tenth of the 160,000 a batch
  pays once (`BATCH_FIXED_GAS`, measured 151,686; `FEE_BATCH_SIZE` 10):
  `BATCHED_BUY_GAS`, 126,000. It is priced at a release constant, 0.15 gwei
  (`FEE_NETWORK_REFERENCE`, a week of mainnet fees for cheap-block and
  deadline sends, re-derived by a release when fees change regime), never the
  fee of the moment: a plan fixes its fee for life, so pricing it live would
  make two identical plans pay up to 2.2 times apart for life.
- **Where the ceiling binds.** Below about 0.0043 ETH a buy
  (`CEILING_BINDS_BELOW`) the fee is 0.69% of the buy, less than the network
  part and the share, and a keeper either pays the rest of its gas or skips
  the buy. Under about 0.00152 ETH (`CHEAP_BATCHED_BUY_THRESHOLD`) it doesn't
  cover even a batched buy at a cheap block (126,000 gas at 0.083 gwei), and
  the form says such buys may be skipped. Under 0.000001 ETH it refuses the
  plan.
- **What the fee does not cover.** Gas above 0.15 gwei comes out of the
  share. On a $69 buy a batch of ten covers its gas up to about 0.67 gwei,
  and a buy sent alone (246,552 gas, `WhatV2AddsGasTest`) up to about 0.34;
  beyond that a keeper waits, skips or pays the difference. spDEX's developers
  may run one that does; nothing obliges them, or anyone.

At ETH at $2,643.94, the network part is $0.050. A $1 buy pays $0.0069, a $5
buy $0.0345 and a $10 buy $0.069 (0.69%, the ceiling), as does every buy up to
about $11.36; above that the fee is $0.050 and 0.25% of the buy: $0.1125 on
$25 (0.45%), $0.2225 on $69 (0.33%), $0.30 on $100 (0.3%) and $1.775 on $690
(0.26%). Shares are rounded up to a whole basis point, as the app shows them.
`docs/DESIGN.md`, "The fee", compares this with what other products charged
on 2026-10-02.

**Why the fee is not mutable on chain.** Changing it would need a setter, an
admin or a proxy, which rule 6 forbids: a fee switch is something someone must
be trusted with. What an owner signed is what they pay, so "Nobody can change
it afterwards, spDEX included" is true. The flexibility lives off chain: the
default for new plans changes with a release, an IPFS CID anyone can check;
each keeper operator sets its own policy; an owner who wants a newer rate can
close and recreate, for about 270,000 gas (a close, 52,484 on the fork, and a
funded creation, 216,263), and the app offers no move of its own
(decision 27). The ceiling is the one part on chain, a constant like every
limit in `VaultLimits.sol`, because a promise about the most anyone is paid is
worth only what can't be changed.

`VaultGuard` refuses a creation whose fee is above `feeCeiling`
(`VAULT_MALFORMED`), by name and figure, before anything is sent; the factory
would too (`RewardTooLarge`). Only creations: funding, closing or triggering
an existing vault is never refused for its fee, so a later, lower ceiling
can't trap anyone.

### The keeper

A due buy happens when someone sends it: an open tab's **Trigger now** (the
owner's wallet calling `execute(owner)`, the fee paid back to them), any tab's
**Help run the network** (below), or a keeper anyone can run, `pnpm keeper` or
its Docker image (`docs/KEEPER.md`). None is promised to run, and none needs
the owner's trust: a keeper can make a buy happen or not, never happen
differently.

`packages/vault/src/keeper.ts` is one tick and `scripts/keeper.ts` the loop
around it, which holds everything a tick must not touch (files, the lease,
signals, the wall clock), so every decision is unit-tested against a scripted
endpoint. A tick:

1. reads the head, and sends nothing on one that is stale or went backwards;
2. follows the one transaction in flight: its receipt, a resend with higher
   fees, a cancel, or giving it up once its nonce is used;
3. finds new vaults in each listed factory's list, a few pages a tick, never
   through `eth_getLogs` (or reads an allowlist);
4. works out from cached terms which are due, with each one's deadline and
   community window, by the vault's own arithmetic (`dueSinceAt`,
   `communityWindowEndsAt` in `keeper-plan.ts`; in the keeper's code "window"
   alone is a buy's slot);
5. decides whether to send now: with an eligible `rewardTo`, an in-window buy
   at once at the patient tip, urgent only in the window's last 2 minutes
   (`urgentFrom`, decision 19); with an ineligible one, not before the window
   ends; otherwise at a cheap block or a deadline;
6. proves each vault it would send for the first time to be its factory's
   clone, from owner, terms and nonce (`proveClones`, `keeper-read.ts`), never
   on an endpoint's word, since the batcher calls whatever it is given;
7. reads those vaults and their prices in one Multicall3, chooses a batch
   their fees pay for, per batcher, simulates it with `eth_call` at the fee it
   will pay, drops any vault that refuses, and signs and sends it.

Eligibility is read every tick from each release with a registry
(`readHolderStatus`, as the app reads it) and counts only while the proof is
still valid a block later; unreadable is not eligible, and a vault's owner is
eligible for that vault. A `NotEligible` refusal rests that vault until its
window ends.

- **What it signs.** One nonce manager (`keeper-send.ts`) signs only what
  `assertKeeperMaySign` allows (the list is `AGENTS.md` rule 2's), persists
  each signed transaction before broadcasting it, and holds a lease so two
  processes never sign with one key. It never prints the key.
- **Gas.** An explicit limit, never `eth_estimateGas`: 60,000, plus 127,000 a
  vault (178,000 for a first buy), plus what the batcher must have left
  before its last attempt (`minGasPerAttempt`, 460,000 at 400,000 a vault).
  An estimate finds the least gas at which the transaction doesn't revert,
  and inside a try/catch that is where later vaults quietly fail.
- **Proving, if asked to** (`SPDEX_KEEPER_PROVE=1`, decision 20): its
  `rewardTo`, with the app's own `buildHolderProof`, when it has no proof or
  five days or less left, at the patient tip with nothing else in flight. Its
  endpoint answers every figure a proof depends on, so the spending bounds run
  on the machine's clock (`PROVE_SPACING_SECONDS`): one try per five minutes,
  one proof a day, none for a day after one reverts.
- **Distrust.** A vault whose buy burned at least half its gas cap on chain
  and bought nothing is left alone for a week, or until a new batcher; an
  honest refusal it paid for rests a vault ten minutes, at most twice a slot.
- **Records.** Every decision is a JSONL record: typed fields validated and
  never redacted, free text redacted of the key and every configured URL. A
  heartbeat file feeds Docker's healthcheck, and a watchdog exits a keeper
  whose ticks stop completing.

What it earns and spends (fees against gas at the next base fee plus 12.5%,
an optional capped subsidy, a cold `rewardTo`'s runway, private orderflow and
`minRewards`) is `docs/KEEPER.md`'s, from "How it earns, and what it costs"
on.

### In the app

A vault plan is **Set and forget** in the form (`signer: "vault"`, config
version 7), and its config entry holds its vault's address once it exists.
The chain is that plan's source of truth: no ledger entry, no runner, no
scheduler module.

- **The buy fee on screen.** Called the buy fee, never a reward; in the chosen
  currency first when a rate is known, then the ether, with its exact share of
  the buy (`feeShareText`) and the rule that set it ("fixed", because the
  network part is a release constant). Notes under the choice
  (`vaultFeeNotes`): under about 0.00152 ETH a buy may be skipped; under about
  0.00274 ETH (`HELD_BELOW`, where the ceiling holds the fee below the network
  part) it depends on low network fees; when network fees are very low,
  confirming each buy yourself costs less. For a plan paying with ETH, the
  wallet choice gives one buy's network fee at today's fees, and warns when a
  vault would cost the whole plan less, its creation included.
- **Trigger now.** The due banner sets the buy fee beside what **Trigger now**
  costs at today's fees (`VAULT_GAS`: a busy pool's buy, not `EXECUTE_GAS`,
  which sizes a limit), and demotes the button when that costs more. It sends
  `execute(owner)` (`execute()` on an earlier test deployment vault), accepted
  whenever the buy is due and paying the fee back to the owner. Each buy in a
  vault's history says who made it (`buyMaker`).
- **The community window on screen.** One plain line in the plan says holders
  can earn its fee for the window's length, then anyone can. The window is
  `defaultCommunityWindow` (30 minutes, or a quarter of the interval when that
  is shorter); Expert alone offers 1, 5, 15, 30 and 60 minutes and "a quarter
  of the interval", anything above a quarter disabled (decision 26). It is a
  choice of the draft, not the config, which stays at version 9. While a buy
  is due inside its window, the card says until when, by this device's clock.
  Expert's details add the release, the window, when the current one ends, and
  `windowBuys`.
- **Reading.** Terms, progress and totals in one Multicall3 round trip;
  history from the vault's logs, best effort, missing buys reported as not
  shown. A vault from someone else's link is read-only.
- **Time** is the chain's: a vault judges "due" by the block a buy lands in,
  so start times and countdowns use the chain's time carried forward, never
  `Date.now()` alone: the pending block's timestamp where the endpoint gives
  one (an idle chain's latest block runs behind by however long it has been
  idle), else the latest's. Whether a buy can be triggered now is the vault's
  own answer at the latest block.
- **A vault no plan points at** still holds its budget and buys, so with a
  wallet connected the app finds it (`findVaultsByOwner` in `@spdex/vault`):
  each listed factory's `nonces` for the account, then its `VaultCreated`
  logs by owner topic, newest first, at that block, until every vault counted
  is found (the page's own plans count, once `findVaultNonce` proves each). It
  narrows a range an endpoint refuses, starts no earlier than the first block
  any of this repository's factories can have logged in, and stops after 40
  queries, saying how many it can't show. When that comes back incomplete it
  reads the factories' own lists (`searchVaultsFromFactoryList`,
  `lib/dca/factoryListSearch.ts`): every listed vault's `owner()`, compared in
  the page, at one block, through Multicall3 only (2 + ⌈N/1000⌉ + ⌈N/200⌉
  requests for N vaults). Neither is a privacy measure: the service sees the
  address anyway, and who owns a vault is public. The search runs once per
  account per service, on **Look again**, and by itself a few times over about
  fifteen minutes when one failed. Found vaults are listed under "Vaults on
  chain not in your plans", with **Add back to my plans** (`planFromVault`,
  once `vaultClaim` proves the vault the account's on those terms) and **Close
  and withdraw**. Nothing moves a vault to another release (decision 27).

The host composes six vault transactions: create (funded in the same
transaction, on the latest release only), fund, close, **Trigger now**, Help
run's batch and a `prove` ("Community keeping", below). `VaultGuard`
(`packages/guard/src/vault.ts`) checks them all, knowing each vault's release
(`VaultClaim.release`); row by row, `docs/THREAT-MODEL.md`, "An auto-buy
vault".

- **Checks.** Each call is compared byte for byte with a fresh encoding aimed
  at the factory the app computed, or at the plan's vault, proved by
  recomputing its address; then simulated for its effects (exactly one
  `VaultCreated` at the predicted address, funding arriving as the vault's
  WETH, a close paying only the account, a trigger paying the floor and the fee
  to the owner). Codes: `VAULT_MALFORMED`, `VAULT_NOT_DELIVERED`.
- **Unsimulated.** One that sends ether is never signed unchecked, whatever
  `requireSimulation` says: ether sent to an address with no code yet is lost.
  One that sends none (a close, a trigger, an unfunded creation, a `prove`)
  follows the setting, so a service that can't simulate never keeps an owner
  from their money.
- **At the signature.** Each call carries the chain it was checked for, read
  from the wallet as it is asked to send, so a wallet switched to another
  network meanwhile is refused. **Trigger now** carries a gas floor
  (`KEEPER_MIN_EXECUTE_GAS_LIMIT`, 396,000: `EXECUTE_GAS`, 330,000, and a
  fifth), because a buy estimated on a quiet pool runs out of gas when a trade
  lands on the pool first.
- **Recording a creation.** A plan's vault is written once, from the chain:
  the factory's `VaultCreated` in the receipt, or the code at the predicted
  address confirmed by `settleCreation`; never the prediction alone, which a
  creation from another tab could have moved to the next nonce.

### What the report answers

How vaults are used is answered from the chain and a keeper operator's own
logs, never from the app, which records nothing about its users (rule 4).
`pnpm keeper:report` (`src/report.ts`, run by `scripts/keeper-report.ts` or
Compose's `report` service) reads the contracts' events and the keeper's
JSONL and state through an endpoint the operator chooses, and writes CSV
tables and a `summary.json` answering twenty-one questions; its options,
files, provenance and completeness checks are `docs/KEEPER.md`'s, "The
report". It reads to `finalized` by default, gives the same files for the same
range, and leaves a figure it couldn't know empty, never zero.

Its last question, `q21`, is decision 29's concentration figure, which can
formally reopen turns among holders (decision 6). Swaps made in the app,
abandoned forms, errors people saw, which frontend made a vault and who uses
the app are deliberately unknowable.

## Collective DCA

"Collective DCA: auto-buy vaults" shows what every listed factory's vaults
have done: buys made, SPX delivered, vaults still buying, owner addresses, ETH
spent on buys and buy fees, the budget still committed and the ETH still held,
and the share of buys with a community window that paid a community keeper
inside it. It counts **vault activity only**: a swap carries no spDEX marker,
and none will be added, since it would publicly label every address that ever
used spDEX. The panel says so, always visible, and that addresses aren't
people.

**Host code, not a tracker module** (`packages/vault/src/platform.ts`,
`apps/web/src/lib/network/platform.ts`, `components/network/CollectiveDca.tsx`).
No manifest can declare a vault, whose address exists only once someone
creates it, and the tracker kind's only method is `scanPools`. So it is host
code, as `keeper-read.ts` and `report.ts` are, under the tracker's rules
anyway: display only, never read by a routing or signing decision, every
figure unknown rather than zero.

**The reads.** Everything at one block, so a vault that changed between two
batches isn't counted in two states, and through Multicall3 only (200 calls to
an `eth_call` with a 30,000,000 gas ceiling), because a service key limited to
a list of contracts can list Multicall3 but never a vault made later: the
block; each `DEPLOYMENTS` factory's `vaultCount()` (a factory with no code,
as every one is on a fork of the pinned block until something deploys it
there, answers empty and shows as "not deployed on this network", never
zeros); its
`vaultsPage(offset, 1000)`; and per vault `owner()` and `terms()` once per
chain for the session, then `buysDone()`, `closed()`, `totalOut()`, its WETH
balance and `windowBuys()`, each decoded by its release's ABI.
`totalRewards()` is `buysDone × keeperReward`, so it isn't read; nor is
`status()`. That is 2 requests, then per release ⌈N/1000⌉ pages and ⌈cN/200⌉
batches, c being 7 calls a vault at first and 5 once cached
(`platformReadCost`): 14, then 11, for 301 vaults.

The community keepers' share is Σ `windowBuys` over Σ `buysDone` of vaults
with a window, from state, a whole percentage rounded down ("less than 1%" for
a few), shown only when every such vault was read and "none yet" before the
first buy. Nothing is read until the panel is opened; a read is kept 5 minutes
per service, and **Read again** refreshes it. A read stops at 5,000 vaults and
offers the rest; an unreadable vault is left out of every total, which then
says "at least". No request names the person's address, the figures carry no
money value, and the footer names the block and the requests it took. The
ticker adds "N vault buys" once read.

The same lists serve the owner search in Trust and exits and the auto-buy
panel's fallback (`searchVaultsFromFactoryList`), which share the cache of
owners.

### Helping run the network

Under the Collective DCA figures, a connected wallet on the configured chain
can make other people's due vault buys in one transaction and be paid their
buy fees (`components/network/HelpRunNetwork.tsx`, `lib/network/batch.ts`).
The batch names the wallet as `rewardTo`, so each vault pays it directly. It
is offered only with private sending, since a public batch is copied by bots
and the loser still pays its network fee, and only for vaults whose source
takes `rewardTo` (decision 27). Nothing about the person's address is read
until they press **See which buys are due**.

1. **Which are due.** `readDueCandidates(rpc, read, { block })` reads, for
   each open latest-release vault in Collective DCA's read that holds a buy and
   its fee, what the keeper reads (`buysDone`, `lastBuyAt`, `closed`, WETH,
   `quote()`) and the block's time, one Multicall3 request per 30 vaults.
   Due-ness and windows come from the keeper's own `earliestBuyAt`,
   `dueSinceAt` and `communityWindowEndsAt`, never `status()`; a vault under
   its floor, or on a pool too thin to judge, is left out. The app never
   imports `keeper-read.ts`; `@spdex/vault` re-exports only `keeper-plan.ts`'s
   pure planning.
2. **Which are offered** (`splitByWindow`). A buy past its window, to anyone;
   one inside it only to a wallet the registry finds eligible with its proof
   valid a block (12 seconds) later (`readHolderStatus`,
   `eligibleInNextBlock`), unknown being no, the wallet's own vault included
   (its card's **Trigger now** makes that buy). Any other wallet sees when
   holders' first claim ends, why it isn't a community keeper (a contract, its
   shortfall against 690 SPX, a proof missing or lapsed) and a plain link to
   `docs/KEEPER.md`, "Becoming a community keeper", and no button for those
   buys. Keeping is paid work, never shown with an APR or projected earnings
   (decision 23).
3. **Which to make.** The gas price is read once and is the price signed. The
   keeper's own `selectBatch`, as a private send that plans no loss, picks at
   most 20 vaults, small buys first, each listed with its fee and no owner.
4. **A test-run from the person's address** (`eth_simulateV1`) at the exact gas
   limit it will be signed with (`batchGasLimit`), repeated until every vault
   left buys.
5. **Only when it pays.** `minRewards` = the test-run's gas × 1.1 × the price,
   rounded up; offered only when the fees reach it, and only for as much of
   the batch as the wallet can fund, keeping `GAS_RESERVE_WEI` back.
6. **The Guard.** `Engine.checkVaultBatch(intent)` builds the one call itself
   (`executeBatch` to the newest batcher, paying the account, with
   `minRewards` and the least `gasPerVault`, at exactly the gas limit and
   price), and `VaultGuard` checks it: never signed unverified, only vaults
   whose source takes `rewardTo`, through the second opinion when one is set,
   every `Bought` paying the account, `earned` the sum of the rewards, and a
   `minRewards` no lower than the test-run's gas × the signed price
   (`VAULT_NOT_DELIVERED`). A vault refusing `NotEligible` drops out without
   sinking the batch. **Make** shows only for a verified batch and re-checks
   when pressed. The batch path's full checks: `docs/THREAT-MODEL.md`.
7. **Sending.** Through the page's one wallet lock, with `walletSender` and
   `submit`, privately, with no public fallback, at the call's exact `gas` and
   `gasPrice` (`SendableCall.gas`/`gasPrice`). A wallet that can't
   `eth_signTransaction` is told it can't help. Whether a lost race costs its
   network fee is judged by the relay's address alone (`revertProtected`):
   only `rpc.flashbots.net` (or its `/fast` form) and
   `rpc.mevblocker.io/noreverts`, with no query, count as dropping a failing
   transaction.
8. **After.** The result comes from the receipt's `Batch` event, never the
   test-run, with a finality badge. Records keep a `buy-fees-earned` row,
   shown as fees received, never as a buy or a sale.

### Community keeping

A closed fold at the foot of Help run the network, **Community keeping**,
reads nothing until opened, and shows even without private sending, since
proving needs none. Community keepers make other people's buys and are paid
for each one; holding 690 SPX is the entry bar. The fold shows, at one block,
whether the connected wallet is eligible and until when, and its SPX against
`MIN_SPX`, "unknown" for anything unread; a contract is told only an ordinary
account can be paid as a community keeper.

- **Prove my SPX**, for an ordinary account holding `MIN_SPX` whose proof is
  missing or has five days or less left. The app reads the `finalized` block
  from the person's service and rebuilds its header as RLP
  (`blockHeaderRlp`, `@spdex/chain`), going no further unless it hashes to the
  block's hash (`checkedHeaderOf` also tries the answer's other hex fields,
  for a field a newer hard fork appended). Then `eth_getProof` for SPX's
  balance slot, checked against the header's state root and refused in words
  if the balance there is under `MIN_SPX`; `encodeProve`; the Guard's `prove`
  check (what it requires: `AGENTS.md`, rule 2); and one transaction, its
  limit the estimate and a fifth, at most 750,000 (`buildHolderProof`,
  `proveGasLimit`, `packages/vault/src/registry.ts`). A `NotNewer` proof is
  refused in words. Before a wallet's first proof, the panel says what proving
  publishes (decision 24). A proof goes privately when private sending is on,
  and publicly only after the panel asks; a receipt that doesn't come within
  the wait frees the panel.
- **Prove another address** (decision 22), a nested fold: the same for any
  address typed in (its checksum checked when in mixed case), the connected
  wallet paying the gas, so a hot browser wallet can prove a keeper's cold
  `rewardTo`. A contract, or an address under `MIN_SPX` now, is refused in
  words first.
- **Paste a proof**, a nested fold, opened when the person's service refuses
  `eth_getProof`: the two requests as `curl` commands to run elsewhere, and
  the pasted answers checked against the person's own service
  (`checkPastedProof`) before anything is sent. It never fetches from
  anywhere else (rule 4). What it checks: `docs/RPC-RUNBOOK.md`, "Proving SPX
  held: `eth_getProof`".
- **Lapse reminders** (decision 25). From 5 days before a proof lapses
  (`PROOF_LAPSE_WARNING_SECONDS`), a banner in the fold, and, if the person
  ticks its box, a notification (`lib/reminders/lapse.ts`) through the buy-due
  path, with no icon, by this device's clock.

Proving moves no money (a `prove` carries no ether, and a false one only
reverts), so it follows `requireSimulation` and may be signed "Checked on one
service". Every prove button is a money control (UI rule R2).

## What adding a module kind actually takes

The sandbox is kind-agnostic: `QuickJSRuntime` checks that code assigns
`globalThis.spdexModule` with a compatible API version, and its `#invoke`
takes a method name. The kind-specific part is the host's typed view, and it
is one table: `KIND_SPECS` (`packages/host/src/runtimes/kinds.ts`), a row per
kind with its interface name for load errors, the methods it must define, and
a `bind` that turns a runtime's raw "call this method" into the typed view,
parsing every answer with the kind's schema. Each runtime has one
`loadKind(moduleKind, source, broker)`; `load`, `loadRegistry` and
`loadTracker` remain as one-line delegations with unchanged signatures, which
the parity suite checks against `loadKind`. Every view is still precisely
typed, carries only its own kind's methods in both runtimes, and validates
output with the same code whichever runtime ran it. The table replaced a
hand-written load path per kind once the scheduler became the fourth; no kind
has needed a change to the broker or to the venue path.

Two things the table doesn't do, on purpose. Method names come only from it,
never from a manifest or config, because QuickJS calls a method by
interpolating its name into code it evaluates. And runtimes check a module's
shape, never its `manifest.kind`: "should this be driven as a scheduler" is
`assertLoadable`'s question, asked by every Engine seam that picks a module
(venue, tip list, tracker, scheduler) and by the conformance kit.

So a new kind is an interface and wire schema in `core`, a view type, a row in
`KIND_SPECS`, a row in the conformance kit's `EXERCISES` (whose type demands
one per loadable kind), and an entry in `IMPLEMENTED_MODULE_KINDS`. Using it
takes app wiring: a `BUILTIN_*` list in `apps/web/src/lib/engine.ts` and an
Engine method that picks a module, runs `assertLoadable`, loads it in the
runtime `strictSandbox` chooses and calls it (`dueBuys` is the scheduler's).
`tokenlist`, `oracle` and `submitter` are admitted and have no runtime path
yet.

## The config is the application

`SpdexConfig` is one serialisable value holding the app's whole behaviour. A
shipped preset is where it starts; the Features dialog, the Recurring tab and
the Expert view edit that one value, and the diff view compares it with the
preset. A beginner and a cypherpunk run identical code with different values;
no simplified path behaves differently.

It is the user's property, exported as TOML, shared as a URL fragment, pinned
to IPFS, so a config from an older build must still open: migrations live in
`packages/config`. It is at version 9.

- **5 → 6** adds `dca`, off and with no plans (a migration must never start
  spending), and no scheduler module entry, so an untouched config still
  equals the preset.
- **6 → 7** changes no config: version 7 lets a plan name the `"vault"`
  signer and hold its vault's address. The version moves so a build that knows
  only version 6 refuses a vault plan as newer instead of "repairing" it into a
  tab-run plan that would buy on top of the vault.
- **7 → 8** removes the `autopilot` signer: each such plan becomes a paused
  wallet plan with the same id and terms, so this browser's record of it
  carries on and nothing runs that nobody asked to. Resume restates the terms
  and binds the plan to the connected wallet. The schema and
  `ScheduledBuyGuard` both refuse `autopilot`.
- **8 → 9** adds `guard.secondOpinion`, `{ url: null }` when absent. It moves
  the version because zod drops keys it doesn't know: a version-8 build would
  open a version-9 config and silently drop a check the person switched on,
  so it refuses it as newer instead.

An older tab still open when a newer one saves is the same case in one
browser: the newer tab never adopts the older save, writes its own config
back once, and says so (`watchConfigFromOtherTabs`).

## The page

`apps/web/src/App.tsx` lays the page out the way spx6900.com's main menu is
laid out: a masthead, a status panel, and a column of at most eight **tiles**,
each a chip, a title and a one-line summary. What a tile holds and when it
exists is `apps/web/src/lib/tiles.ts` (`TILE_ORDER`, `TILES`); the primitives
are `TileGroup` and `Tile` in `packages/ui`.

- **One tile open at a time, and one on load.** Which one is state in `App`,
  never stored or in the URL (a `#tile=` would collide with `#receipt=` and
  settings links). On load it is a pending `#receipt=` link's tile, else
  Welcome while it shows, else Buy SPX (`initialOpen`). Nothing else opens by
  itself, a due buy included. Closed tiles stay mounted, so the auto-buy
  runner, balances and a wallet prompt in progress carry on.
- **The keyboard.** ↑/↓, Home and End move between tile headers, ↵ toggles
  one, Esc closes the innermost open fold and then the tile. Arrow keys are
  never page-global, and no key ever focuses a money control (R2).
- **Places.** Copy that sends someone somewhere names the place by its label
  (`PLACES` in `lib/places.tsx`, "Settings → Network service") and ends with a
  `GoTo`, which opens the tile, unfolds the section, switches to the Expert
  view first if the place is only there, and can show "← Back to …".
  `apps/web/src/copy.test.ts` refuses "Expert → …" in the copy.
- **Settings** is one tile: the view and features rows, then exclusive
  sections (currency, network service, tips, check this build, and in Expert
  markets, router, sending, safety and the settings file).
- **The status panel** (`components/shell/StatusWidget.tsx`) shows the
  service's state, the chain, the wallet, and the latest block and when it was
  read. It reads the block (`lib/chainHead.ts`) only on load with a service
  chosen, when the service changes, when the browser comes back online, and
  on ↻: **it never polls**, so an open tab neither bills the service nor tells
  it the tab is open. A failed read is "unknown", never 0. The service's
  address is **masked** here, in Settings and in errors (`lib/rpcDisplay.ts`:
  userinfo, path and query removed, long or key-like host labels cut), since
  such URLs often carry an API key; **Show** reveals it until the panel closes.
- **The disclaimer** (`components/shell/DisclaimerGate.tsx`, text in
  `lib/disclaimer.ts`) shows on a first visit and whenever
  `DISCLAIMER_VERSION` changes, before anything else, with the page inert
  behind it. It informs; it is not a clickwrap. Any key but scrolling and
  modifiers, a click outside the text, or **Continue** closes it, once it has
  been up 400 ms; the page then stays inert 500 ms more (`ARM_AFTER_MS`), and
  a settings link's **Apply** stays disabled 500 ms after it can take input,
  so a double press can't close the gate and apply a link. Every sentence
  names its source in the code beside it. **No lawyer has reviewed this
  text**: the community prototype is published without that review, a risk
  its publisher accepted, and the source says so in a `NOT REVIEWED BY A
  LAWYER` note. A release beyond the prototype should have a lawyer read it
  first. The footer's **Disclaimer** link shows it again.
- **Display settings** (`components/shell/DisplayDock.tsx`): colour mode, text
  size (A, A+, A++; A+ by default), motion and contrast, kept in
  `spdex.a11y.v2` (only what differs from the default; motion and contrast
  carried over once from `spdex.a11y.v1`) and applied before first paint by
  `lib/theme-boot.ts`. AUTO follows the system, and a manual choice can only
  add accessibility. Every font size is in rem (`css.test.ts`), and the
  layout's breakpoints and columns are in rem too, so a text size changes how
  big things are, never where: the dock stays pinned bottom-left from 90em.
- **Art.** The stickers and the line drawing under the footer are inline SVG
  components (`components/shell/art/`): no file, no request
  (`no-requests.test.ts` also holds each under 3,072 bytes). Every sticker
  carries a "spDEX · community" tab, and none copies spx6900.com's artwork or
  text. The backdrop is one pale picture behind the page where it has three
  columns (85em): travellers carrying an SPX banner on a crystal cliff, the
  SPX coin sealed in a clear crystal octahedron for Ethereum (the model's
  crystal, never the Ethereum logo glyph), and quiet sky behind the centre
  column. The coin is composited from SPX6900's logo file (the one exception
  to R8, below); `apps/web/src/assets/backdrop/README.md` says how the picture
  was made and how to replace it.
  - `Backdrop.tsx` is one empty element that `packages/ui/src/theme.css` fixes
    behind the page (z-index -1) under the paper's halftone;
    `apps/web/src/backdrop.css` names the picture only from 85em, which no
    phone reaches, and never on an iPhone or iPad (whose Safari can't fix a
    background to the window): AVIF where the browser can choose by `type()`,
    WebP elsewhere. In one column the page is plain paper.
  - It places the picture from the layout's own measures, so at every window
    and text size the banner's print sits 16px in from the left edge and the
    coin just right of the centre column, under the widget, clear of the
    stickers. At 3:2 and squarer the print is cut by the window's edge, and
    under about 700px tall the pinned dock can cover it. `e2e/shell.spec.ts`
    checks a sample of sizes at each text size. The sticky masthead and the
    gap above the widget lay the same picture fixed to the window; high
    contrast, forced colours and print drop all of it.
- **Fonts.** Orbitron (variable), Space Mono Regular and Bold and Bebas Neue
  ship in `apps/web/src/assets/fonts/`, each beside its SIL Open Font License,
  loaded by `apps/web/src/fonts.css` from the app's own origin with
  `font-display: swap` (297,564 bytes of TTF in the build). Body text keeps the
  system UI stack. The "I bought" card's PNG embeds the same files.
- **Words.** The tile that swaps and sets up auto-buys is chip BELIEVE, title
  **Buy SPX**, and the copy says "buy" and "swap", never "trade" (R7);
  `copy.test.ts` and `e2e/shell.spec.ts` fail on the word anywhere a person
  can read it, except the motto quoted as a saying. Community keeping is paid
  work, never an investment: no screen shows an APR or APY, a yield, a
  "reward", a projection or an "earn up to" (decision 23), which
  `e2e/shell.spec.ts` checks on every screen.

### UI rules

Every change to the page keeps these. Comments and tests cite them by number,
as "UI rule R2, docs/ARCHITECTURE.md", or "UI rule R2" once a file has said
where the rules are.

- **R1 · Green at every change.** `pnpm verify --strict` passes after every
  commit (`AGENTS.md` describes the gate).
- **R2 · Focus never lands on money.** No key, shortcut, `reveal`, `GoTo` or
  auto-focus ever focuses or presses a control that asks the wallet or changes
  money or settings. Neither does the second half of a double click or tap
  that lands after the page changed under the pointer: the page stays inert
  for `ARM_AFTER_MS` after the disclaimer closes, and a prompt that can appear
  under the pointer (Send publicly, a settings link's Apply) arms its button
  only after that long (`useArmed`). `MONEY_CONTROLS` in `lib/tiles.ts` is the
  list. It includes Swap, Start, a vault's create, fund, close and trigger,
  Help run's Make, Prove my SPX, Prove another address and sending a pasted
  proof, Confirm buy, Tip this address, Send publicly, Apply these settings,
  Remove and continue, turning auto-buy on, choosing or saving a network
  service, every button that opens the wallet, and anything marked
  `data-money-control`. Focus goes to the prompt around the control instead
  (its container, `tabIndex={-1}`, named by its title) or to its Cancel.
  `tiles.test.ts` and `e2e/shell.spec.ts` check it.
- **R3 · Checkable text.** Every sentence of the disclaimer, and every factual
  claim in the footer, the stickers and the rest of the copy, can be checked
  against the code. The disclaimer's sources are listed beside its text in
  `lib/disclaimer.ts`. Check them again whenever a signing path changes.
- **R4 · One copy of the chrome.** The masthead, display dock, status widget,
  ticker, key hints and footer are each rendered once. Only the stylesheet
  (the page layout block in `packages/ui/src/theme.css`) moves them between
  layouts. A second copy would duplicate test ids and what a screen reader
  reads.
- **R5 · Short copy.** Each visible element says one short sentence (about 15
  words at most, two sentences for a banner) or one line of figures, and a
  title is a few words. Lead with the number or the fact. Don't repeat what
  the page already says: "no servers" is on the tape sticker, the footer and
  the disclaimer, and nowhere else. Reasons go one tap away, in a `Term` (what
  a word means, why a figure is what it is) or a closed fold ("Why?", "How it
  works", "Details"). Both keep the text in the page, so tests and search
  still find it. A place is named by its label and a `GoTo` (see Places
  above), never as "Expert → …".
- **R6 · Honest limits stay visible.** Short copy never hides these behind a
  tap. Each stays on screen as a word, a badge or a line, and only its
  explanation moves into a `Term` or a fold: UNAUDITED and the 0.5 ETH cap;
  that anyone can make a vault's due buys, SPX holders first inside a buy's
  community window, and nobody has to; that only closing a vault stops it; who
  a buy fee is paid to; that missed buy times are skipped and the plan ends
  later; that a plan you confirm needs spDEX open; that a Permit2 permission is
  unlimited until revoked; that a later part of a split route can fail after
  an earlier one went through; every Guard refusal. Costs come before every
  choice, as one line of figures. A figure worked out from a limit says "up
  to", an estimate says "≈", and one spDEX doesn't know says "unknown", never
  0.
- **R7 · No "trade".** Copy never calls spDEX a trading tool, because the SPX
  motto is "STOP TRADING AND BELIEVE IN SOMETHING" (see Words above). The
  motto itself, quoted as a saying and attributed to the community, is the one
  exception.
- **R8 · Original, and no claim to standing.** No wording or artwork is copied
  from spx6900.com. A community saying is quoted as it stands, attributed and
  linked, and called a saying, never a commandment. spDEX never calls itself,
  the token or anyone "official" or "unofficial": SPX6900 has no official
  team, so neither word measures anything, and "community project" says what
  spDEX is. The disclaimer's "On an official release" (`OFFICIAL_RELEASE` in
  `lib/disclaimer.ts`) is the one use of the word: a copy at the address its
  publisher released it for, never a claim about SPX6900; `copy.test.ts` and
  `e2e/shell.spec.ts` take out exactly that and still refuse the word anywhere
  else. One exception to the rest, and only one: the SPX6900 logo, the
  community's mark, is the coin in the backdrop picture (sealed in the
  crystal, printed on the lead banner), composited from the logo file and used
  as the community uses it, to say what the page is for. It is never spDEX's
  own mark, never a claim to speak for SPX6900, and not under the
  repository's licence (README, License).

## What there is deliberately none of

- **No backend.** A static bundle; a feature that seems to need a server needs
  a module or a different design. A plan the owner confirms runs in the tab
  and says it stops when the tab does; a vault plan runs with no tab and no
  server, because a contract enforces it and whoever wants the fee sends the
  transaction. A keeper is software anyone may run, not a service the app
  depends on or contacts.
- **No telemetry, analytics, or error reporting**, not behind a flag
  (`AGENTS.md`, rule 4). Every request goes to the network service in use, the
  relay the person chose, or the second opinion they typed.
  `apps/web/src/no-requests.test.ts` is a partial
  check: it can't see a request made another way, the `lint` stage runs
  nothing, and the CSP leaves `connect-src` open so users can choose any
  endpoint, so review keeps the rest. It is also why Collective DCA counts
  vaults only.
- **No wallet-connection library.** The app needs four EIP-1193 methods; a
  connector framework would add a large dependency, another view of chain
  state, and a relay that watches sessions.
- **No price chart, and no value of anyone's holdings.** THERE IS NO CHART, as
  the community says, and a chart with one point on it is still a chart.
- **No remote font.** It would break the CSP and tell a third party every time
  the page opens; the display faces ship as the app's own assets.
- **No contract anyone controls.** Swaps, tips and tab-run auto-buys use no
  contract of spDEX's, which is why a split route can't be atomic
  (`docs/THREAT-MODEL.md`). The contracts spDEX does ship have no owner,
  admin, upgrade, pause or fee ("No contract anyone controls", above).

## Upgradeability

Two mechanisms, pulling in opposite directions on purpose.

**The capability broker is additive-only.** Capabilities may be added; an
existing signature never changes. A module written against an older host must
still load on a newer one, because the people running old pinned CIDs are
exactly the people the sovereignty pitch is aimed at.

**Module kinds are declared ahead of implementation.** `MODULE_KINDS` lists
nine: `venue`, `tokenlist`, `tiplist`, `oracle`, `submitter`, `panel`,
`policy`, `tracker` and `scheduler`. `IMPLEMENTED_MODULE_KINDS` admits all but
`panel` and `policy`, which stay reserved; four have a shipped module and a
runtime path (the rows of `KIND_SPECS`), and the Guard's oracle cross-check is
host-side. Declaring kinds up front means adding one fills in a branch the
type system already knows, and `assertLoadable` refuses a module of a kind
other than the one asked for, not implemented, or not loadable, with a
readable message rather than a half-load ("What adding a module kind actually
takes"). The config is versioned on the same logic ("The config is the
application").

**The contracts cannot be upgraded at all,** and that is the point of them. A
vault keeps its code for good, keepers go on serving it, and closing it needs
only its owner's wallet calling `close()`; this app is not in that path. So
every change of behaviour on chain means new contracts at new addresses,
beside the old ones, never in their place, and the design keeps such changes
small and rare (decisions 34–38). What a change takes (`docs/RELEASE.md` has
the procedure):

- **Nothing deployed.** A different default fee or window, turns among holders
  once decision 29 trips (in the vault already, unused: `turnBuckets`), or a
  new gas figure for batched buys, which the batcher takes from its caller:
  an app release.
- **A batcher alone.** Bound to no factory, a fixed batcher is one more
  `batchers` entry in `deployments.json`, deployed by itself, and every
  release whose vaults take `rewardTo` goes through it.
- **A factory from the same code.** Another market list or registry is a
  release built from an existing source: a `releases` entry the build fills
  in, one deployment, and no code anywhere, since everything off chain goes by
  a source's features, not a release's name.
- **New code.** A fix to the vault, factory or registry, a new limit
  (`MAX_FUNDING`, after an audit) or a new venue is a new source: the deployed
  one frozen first ("Frozen sources", above), the new one built from
  `contracts/`, and a new contract release from it.

`deployments.json` only grows, so every earlier release's vaults run on and
are served. Nothing a fork can reprice may strand anyone's money: `close` pays
the budget as WETH if unwrapping fails (decision 37), and the registry's
stipend has about nine times the room an honest answer needs (decision 38).

A bug in the registry found after deployment cannot reach a vault's money.
The response is decision 31, with its notice ready and empty
(`REGISTRY_ADVISORY`, `lib/dca/advisory.ts`, null in every build until then):
`docs/THREAT-MODEL.md`, "The community window and the SPX holder registry".

## Determinism

The rules are `AGENTS.md`'s ("Determinism rules"). Integration tests fork
mainnet at a pinned block, and `scripts/anvil-fork.mjs` asserts the fork
produced the expected block *hash* there; never move the pin to `latest` or
bump it to make a test pass. The vault's forge tests pin the same block
(`packages/vault/test/forge/utils/Fork.sol`), fork it themselves from the
archive endpoint, and move time only inside their own EVM (`vm.warp`). A fork
can't prove a block it mined, so the registry's tests send real mainnet
proofs, recorded for blocks up to the pinned one
(`packages/vault/test/fixtures/proofs`, `scripts/record-proofs.mjs`).

Modules read no clock and no randomness, so identical inputs give
byte-identical output; a module relying on them fails in QuickJS and in the
conformance kit. The kit repeats each kind's characteristic call, which for a
venue is `discoverPools`, not `buildCalls`, so it doesn't by itself show that
a venue builds identical plans.

## Further reading

- `docs/THREAT-MODEL.md` — what the Guard defends against, and what it does not
- `docs/WRITING-MODULES.md` — the module interface
- `docs/DESIGN.md` — the contracts' design, the community window, and the
  numbered decisions
- `docs/KEEPER.md` — running a keeper, and its report
- `docs/RELEASE.md` — the release checklist, and deploying the contracts
- `docs/IPFS-RELEASE.md` — reproducible builds and publishing
- `docs/WALKAWAY.md` — checking a copy of spDEX, and doing without it
- `AGENTS.md` — the verify gate, and what each stage proves
