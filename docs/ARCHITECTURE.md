# Architecture

spDEX is a **host** plus **modules**. The host owns the four things that must
not be delegated — the signer, the network, storage, and the screen — and
treats everything else as a module the user chooses.

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
   (fast path)      (sandbox)        venues v2 and v3,
                                     tip list, tracker,
                                     scheduler
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
`TxPlan` and the `SwapIntent` everything else is phrased in terms of.

`packages/vault` sits beside `chain` and outside the module path: the
contracts spDEX ships (the auto-buy vault, its factory and the batcher), the
TypeScript generated from them, the buy fee (`fee.ts`), and the keeper and its
report, which the app never imports. It is host code, not a module, for the
reason routing is — it decides where money goes. See "No contract anyone
controls" below. `docker/keeper` packages the keeper for operators.

## The five rules the shape enforces

**1. Modules propose; the host performs.** A module returns approvals, calls,
and what it claims the user will receive. It never touches a signer, a socket,
storage, or the DOM. In the QuickJS sandbox they are not reachable at all. The
native runtime runs first-party code as ordinary JavaScript in the page, where
they are, so there the rule holds only because the same source has to run in
the sandbox too, and a module that reached for them would fail there. If
widening `VenueContext` seems necessary to let a module do something directly,
that is the bug.

**2. Modules do not author intent.** The host builds the `SwapIntent` from what
the user was actually shown and attaches it to the plan. A module therefore
cannot propose a plan whose promise differs from the one on screen; that class
of attack is closed by construction rather than by a check.

**3. Every plan reaches the signer through the Guard.** Native runtime included.
There is no bypass and no fast path — a first-party module executes faster, and
is trusted exactly as much as a stranger's.

**4. Routing is host-side.** Deliberately not a module: routing decides where
the user's money goes, so it is audited once in the trusted core rather than
being something each venue gets to influence.

**5. The capability broker is additive-only.** Add capabilities; never change an
existing signature. A v1 module must still load on a v3 host.

## Why two runtimes

`native` runs a first-party module as ordinary JavaScript. `quickjs` runs the
*same source text* inside a WASM sandbox. Both marshal through the same JSON
wire types, so a module that keeps the rules in `docs/WRITING-MODULES.md`
cannot behave differently because of where it runs. One that breaks them can:
natively the clock, randomness and the page's globals are all there, and a
module that reads them works on the fast path and fails in the sandbox. The
`parity` gate checks the runtimes themselves: the same source, run both ways,
must give byte-identical output and be refused identically when it oversteps.
That stage runs fixture modules written to exercise every kind, honest and
hostile, not the shipped ones. Each first-party module compares its own code
across the two runtimes in its own tests instead: whole outputs in the unit
tests of the tip list, tracker and scheduler, and, in the venues' fork tests,
pool discovery and quotes against live chain state — not `buildCalls`, whose
output is what gets signed, and only when the fork-backed `integration` stage
runs.

Those comparisons are what make the fast path honest. Without them, "native is
just faster" would be an assertion; with them, a drift in what they compare
fails the build. A drift in how a shipped venue builds its calls would not.
What stands there is the Guard, which judges the built plan the same way
whichever runtime produced it.
`strictSandbox` in the config routes everything through QuickJS so a user can
check the claim on their own machine.

## Native ether

spDEX could not swap ETH at all until recently: the token list was WETH, SPX
and USDC, and there is no wrap button, so anyone arriving with ether was stuck
before they started.

There are **no new pools** behind this. v2 and v3 pools are always ERC-20
pairs — both factories are typed on two token addresses — so every "ETH" pool
in them is really WETH. What changed is which of the router's entry points a
venue encodes, so the wrap happens inside the swap rather than as a
transaction of its own:

| Direction | v2 | v3 |
|---|---|---|
| ETH in | `swapExactETHForTokens`, value attached | `exactInputSingle` **unchanged**, value attached — SwapRouter02 wraps its own balance |
| ETH out | `swapExactTokensForETH` | `multicall([exactInputSingle → router, unwrapWETH9 → user])` |

`WireBuildParams` gained optional `nativeIn`/`nativeOut` flags. Additive, so a
module written before they existed still loads — it ignores them, builds the
wrapped path, and then *fails the Guard*, because the intent says ether and the
simulation shows WETH. Loudly wrong rather than silently wrong.

The Guard needed no changes at all. It was built for this: `eth_simulateV1`
with `traceTransfers` reports native movement as an ordinary Transfer log from
`0xeeee…eeee`, which is the same pseudo-address the intent uses, so one decoder
covers both and there is no native special case anywhere in the effects layer.
Internal transfers are traced too, which is what makes the v3 unwrap-and-forward
path verifiable.

The oracle did need a change, found later. It asked Uniswap v3's factory for a
pool keyed on `0xeeee…eeee`, which no pool is, so every swap into or out of
ether silently had no price cross-check — and a recurring buy, most often ETH
for SPX, would have inherited the gap. It now prices ether as WETH. That is
exact rather than approximate: WETH redeems 1:1 at the same 18 decimals, and
the Guard measures ether in raw wei from the same simulation, so the ratio
carries over unchanged. Ether against WETH becomes one token against itself,
which has no market and so no opinion — correct, since wrapping is 1:1 by
contract.

Two host-side details that are not cosmetic. The intent always names what the
*user* chose, while discovery, quoting and routing run on `tradedAs(token)` —
the ERC-20 the pools are denominated in — because the intent is the promise the
Guard judges and it has to describe what really moves. And **Max** holds back
a hundredth of an ether, since selling every last wei leaves nothing to sign
with and the failure would arrive after the user had committed.

## Second opinion

The Guard's strongest layer is a test-run, and a test-run is one network
service's answer. A service that lies can show a clean transfer where a theft
would happen, and within one service there is no defence against that. A
**second opinion** (`guard.secondOpinion.url`, Settings → Safety) is a second
service, run by someone else, that test-runs every transaction too; faking a
test-run then takes both.

**Where it sits.** `packages/guard/src/second-opinion.ts`:
`SecondOpinionPair` holds the two services and the header they last agreed
on; `pair.provider(primary)` wraps any `SimulationProvider` as an
`AgreeingSimulationProvider`; `applySecondOpinion` is the last step of every
check that simulates. The Engine (`apps/web/src/lib/engine.ts`) wraps the
provider of every Guard it builds that simulates (`Guard`, `TipGuard`, the
`Guard` inside `ScheduledBuyGuard`, and the lazily built `VaultGuard`), and
only the preview Guard, which simulates nothing, is without one. The
structural red-team test reads `engine.ts` and fails on a
Guard class it doesn't know, so a new Guard can't quietly skip it. The same
address twice, after normalising it, is no second opinion: the Engine ignores
it and the strip says it doesn't count.

**A check, step by step.**

1. Both services' latest block numbers, in parallel. A service 1–3 blocks
   behind the other, either one, is asked for its head again, up to twice,
   500 ms apart, so a check made right after the person's own transaction
   (tips after their swap) isn't pinned to the block before it. Still more
   than 1 apart (`MAX_HEAD_GAP`): wait 2 s and ask again; still more than 1
   is a disagreement (`heads`), whichever is behind.
2. The lower head's header from both: its hash, time and gas limit must be the
   same, or after one retry it is a disagreement (`block-hash`). An agreed
   header is shared for 4 s across the legs of one quote; heads are always
   read fresh.
3. Both test-run the identical request on that block, named by hash (EIP-1898),
   with the next block pinned (number + 1, time + 12 s from the agreed
   header, its gas limit, a zero fee recipient, randomness and base fee) and
   an explicit gas limit per call (the request's own for a batch of vault
   buys; otherwise at most 16,777,216).
4. Compared: the outcome; for a success, every real log in order; and each
   account's net ether change, summed from the `traceTransfers` records so
   that clients ordering those differently still agree. Gas and revert
   strings aren't compared.

**What comes back.** Agreement: the main service's outcome, marked `agrees`.
A disagreement: a *reverted* outcome whose reason starts
`second opinion disagrees: `, so every path refuses it even before
`applySecondOpinion` relabels it `SECOND_OPINION_DISAGREES`. The second
service failing (an error, 8 s without an answer, 12 s spent on its requests
in one check (`SECOND_OPINION_BUDGET_MS`, which the main service's requests
don't draw on), no `eth_simulateV1`, no answer for a block at or below its
own head): the main outcome, marked `unavailable`, which
`applySecondOpinion` turns from `verified` into `unverified` with
`SECOND_OPINION_UNAVAILABLE` ("Checked on one service"), or into a refusal
wherever a path never signs unchecked. The main service failing before a
comparison (its head, the header, or its test-run on the agreed block), or
saying it can't test-run at all: the second service is still asked. The
main service's unpinned test-run is compared with the second's (the pinned
one if it was already asked, otherwise an unpinned one), and a difference
is a disagreement; when the main service gives no test-run, the second's is
judged in its place. Either is marked `uncompared`, and a pass becomes
`SIMULATION_UNAVAILABLE` ("Not checked", with `detail.failure`, so the app
tells it apart from a service without `eth_simulateV1`). Reasons are fixed
phrases, never the service's own error text, which could carry its key.

**In the app.** The setting tests a service before it can be saved
(`testSecondOpinion`): the configured chain, then one 1-wei ether transfer
from a state-overridden account test-run on both exactly as every check is,
which must match, the ether-transfer record included. The status panel's SAFETY row says
"checks on 2 services" before any check, "checked on 2 services" after one,
or "second opinion not answering" after a check where it didn't. The swap banner has its own "Checked on one service"
branch; a scheduled buy it leaves unverified is skipped, carrying
`SECOND_OPINION_UNAVAILABLE`; vault and Permit2 refusals it causes say that
the transaction waits until both agree. Typed money is sized from rates
both services agree on to within 1% when the second service answers, and
from the main service alone when it doesn't (`lib/money/rates.ts`, with the
Engine's `secondOpinionRates`, which reads through the second service with
its own oracle instance).

**What it doesn't check.** Only test-runs are compared. The Guard's 10-minute
price check, balances, allowances, code at an address, vault state and fees
are read from the main service alone; cross-reading the price check on the
second service is left out of this release. A check can run one block
behind the main service's newest. Per check it costs a head and a
header read on both, in parallel, and one `eth_simulateV1` on the second, in
parallel with the main one.

## Features, and what they map to

`packages/config/src/features.ts` holds the only mapping from a named
capability to the config changes it implies. A feature is a module plus
settings; the Features dialog edits features, the Expert view edits the config
directly, and both write the same object. There is deliberately no
feature that cannot be expressed as config, because one would be a second and
divergent source of truth.

The catalogue is explicit about which features are modules and which are host
settings — the UI shows the module id, or the words "host setting". "Every
feature is a module" is not yet true, and a catalogue implying otherwise would
be the kind of overstatement this repo keeps finding in its own documentation.

Not everything on the page is a feature. Amounts in money, Your activity, the
finality badge, Welcome, Your stack, the card, Collective DCA and Trust and
exits have no toggle and no config: each is display that reads only when it
is on screen or opened, or a preference this browser keeps (currency, number
style, a hidden Welcome, a stack goal, notifications), which would mark the
config customised and add noise to every shared link.

## Tip splits

The first feature added after the module boundary was designed, and therefore
the first real test of it. Three pieces:

- **`modules/tiplist-spx-community`** — a `tiplist` module answering "who can I
  tip?". It declares *no capabilities and no contracts*, so the broker gives
  it nothing at all. It holds real entries only, which the maintainer adds
  (see "The tip registry" below). Today it holds one, spDEX's own donation
  vault (`kind: "builder"`), which like every entry is never pre-selected. It
  is the one entry without a proof link: the host names it from
  `SPDEX_DONATION_ADDRESS` (@spdex/core), so the picker calls it "spDEX's
  own" whatever a list says.
- **`apps/web/src/lib/tips.ts`** — the host computes each share from the
  balance the swap *actually delivered*, not from the quote. Tipping a share of
  a prediction pays the recipient out of the user's slippage whenever a swap
  underdelivers.
- **`packages/guard/src/tips.ts`** — a separate Guard path with its own
  invariants, because a tip is a different action from a swap and deserves a
  different proof rather than an exemption from the swap's.

Tips go out after the swap settles. One recipient is one ordinary ERC-20
transfer. Two or more are one transaction, through Uniswap's Permit2, in the
order `apps/web/src/lib/tipFlow.ts` follows:

1. **Is Permit2 the one spDEX knows?** The code at its address must hash to
   `PERMIT2_CODE_HASH` (`packages/core/src/tips.ts`). Permit2 bakes its chain
   id into its code, so that is Ethereum's hash, and a fork's; anywhere else,
   or when the code can't be read, the tips go as separate transfers.
2. **Is the standing permission needed?** Permit2's allowance on the token is
   read, and counts as short when it can't be. When it is short, the
   permission is built as a plan of its own (`TipPermissionPlan`,
   `approve(PERMIT2, max)`), and the Guard checks it now, before the
   signature: exactly that, on the token the tip sends, for a tip to two or
   more people, and test-run, since a grant is never sent on the static
   checks alone. A refusal sends the tips as separate transfers without
   asking the wallet for anything, rather than after a signature nothing
   could use.
3. **The signature.** A random unused nonce (a random word and bit of
   Permit2's nonce bitmap, read first so a used one is never picked) and a
   deadline twenty minutes out by the page's clock. The Guard compares the
   exact string the wallet will be handed with `permit2BatchTypedDataJson` of
   the intent, byte for byte, before `eth_signTypedData_v4` is called. The
   permit names the user as its spender: Permit2 hashes `msg.sender` in as the
   spender, so only a transaction the user sends can spend it. A wallet that
   can't sign typed data gets separate transfers; a person who declines gets
   no tips.
4. **The standing permission**, when step 2 found it short. The status line
   says what it is while the wallet asks: unlimited, standing until revoked,
   and usable by a Permit2 signature or approval from any site. Declined,
   that swap's tips go as separate transfers, and the result says so, and
   that the signature just given goes unused: it moves nothing by itself,
   only a transaction the user sends could spend it, and it expires within
   twenty minutes.
5. **The transaction.** `permitTransferFrom` with every recipient, encoded by
   the same core function the Guard re-encodes with, checked byte for byte and
   simulated like any tip, then sent through the ordinary submitter, private
   sending included. A batch whose simulation only reverts (an account whose
   own code answers for its signatures, as an EIP-7702 delegation does) falls
   back to separate transfers, and so does one whose signature expired while
   the permission was confirmed; any other refusal stands.

The signature comes before the permission. It costs no fee, doesn't depend on
the allowance, and shows whether the wallet can sign typed data at all before
any standing permission is asked for, so a wallet that can't is never asked
for a permission it could not use. A permission nothing used can still be left
behind, but only after a signature: when the batch then reverts for the
account, the Guard refuses it, or the person declines it. The note says so,
with where to revoke it. A wallet that can't sign, or an account the batch
reverts for, is remembered for the session: that wallet's tips go as
transfers from then on, and the Tip row says so before the swap. Every
prompt, the tips' included, is numbered as one count ("step 3 of 5"), sized
before the swap and settled by the tip flow as it learns what is left.

No contract of spDEX's is involved, and none was added: Permit2 is already
deployed and has no owner. What it adds is a standing permission, which is
why it is asked for in the course of a tip and nowhere else, explained where
it is asked, and listed with **Revoke** in Settings → Tips. It is also why the
swap Guard refuses any plan that calls Permit2 or approves it
(`PERMIT2_TARGET`), and reads Permit2's own `Approval` and `Permit` events as
approvals in every simulation: with that permission in place, an allowance
inside Permit2 left behind by a hostile venue would let its holder take the
token with no signature. It saves wallet
prompts and waiting rather than gas: on the fork a batch for two measured
about 159,000 gas against 150,000 for two transfers, and for five about
275,000 against 375,000. Each batch also sets a bit in a fresh word of
Permit2's nonce bitmap, around 20,000 gas that a sequential nonce would save
after the first; a random word needs no record of past nonces in the browser,
which is the trade.

### The tip registry: who can be picked, and who is paid

Three sources name an address, and none is trusted for more than naming it:

- **The shipped list** (`modules/tiplist-spx-community/module.js`), data a
  maintainer fills in: `id`, `label`, `handle`, `address` (EIP-55), `ens`
  (shown, never resolved), `note` (why listed), `proof` (an https link to the
  person's own post of the address; never fetched), `kind`, `listed`, and an
  optional `claim`, the person's EIP-191 signature over
  `"spDEX tip list: <address> is <handle>, <yyyy-mm>"`, which the page checks
  offline and shows as SIGNED only when it recovers the entry's address
  (otherwise PROOF LINK ONLY). The listing checklist and the format are in the
  module's header. Every entry is held to `tipListProblems`
  (`packages/chain/src/tipList.ts`) by the module's own tests: checksummed,
  unique ids and addresses, no two alike in their first or last four hex
  digits and no two current names that read alike, no public development
  account, token contract, Permit2, zero, burn or other known contract, a
  note and an https proof (except spDEX's own donation vault, named by the
  caller as `rules.own`, which must be kind "builder"), clean names. Every id is also recorded, with its
  address, in the append-only `shipped-ids.json` beside the module, and the
  tests refuse an id whose address changed: a new address is a new id. The
  page itself refuses a list only for a repeated id; it checks every address
  it would tip on its own. The fields are optional on the wire
  (`WireTipCandidateSchema`), so a v1 module still loads. An entry is removed
  by retiring it for a release (`retired: "why"`) and replaced by retiring it
  with `replacedBy`; a recipient chosen from a retired entry is skipped, even
  if the address is also in "My tip list" with an older confirmation, until
  the person keeps it after seeing that reason (`keptRetired`) and confirms
  again, or switches, with both addresses shown. Nothing switches on its
  own. The page reads the shipped lists once there is a network service,
  tips on or off, so a new address is compared with them either way; until
  they are read, every check says so rather than finding nothing.
- **The test entries** (`modules/tiplist-dev-fixtures`): anvil's accounts #1
  to #3, which the fork specs tip. The Engine asks this module only when the
  network is one of `PLACEHOLDER_CHAINS` (the fork, 690069, and 31337), and a
  picker withholds its entries anywhere else. The twenty accounts of the
  public test mnemonic are `PUBLIC_DEV_ACCOUNTS` (`packages/core/src/devAccounts.ts`,
  checked against a fresh derivation in `packages/chain`): outside those
  networks the host refuses them, skips them and the Guard refuses a transfer
  to one, whatever list names them.
- **"My tip list"** (`apps/web/src/lib/tiplist/store.ts`), the person's own:
  localStorage `spdex.tiplist.v1`, not the config, up to 50 addresses with a
  private name, added by address or by ENS name. An ENS name is read through
  the person's own network service only (`packages/chain/src/ens.ts`: the
  registry's `resolver`, then that resolver's `addr`; no CCIP-Read, no
  wildcard parents), and the address is what is saved. Before saving, the
  address is refused if it is the zero or burn address, the person's own, a
  public test account off a test network, or a contract a token is lost in
  (`apps/web/src/lib/tiplist/contracts.ts`), and warned about, needing "Add
  anyway", if it starts or ends like a listed, saved or chosen address, if its
  name reads like a listed or saved one at another address (homoglyphs
  folded), if the name mixes alphabets, or if there is code at it. With a
  second opinion set, the ENS name and the code are read through it too, and
  a name the two services point at different addresses is refused
  (`apps/web/src/lib/tiplist/lookup.ts`). Reordered by buttons, removed with
  a five-second Undo (removing one that is chosen takes it out of the Tip row
  too, and Undo puts both back), exported and imported as
  `spdex-tip-list.json`; imported entries arrive unconfirmed and marked
  imported, without any ENS name the file claims, and an entry whose name
  reads like a listed or saved name at another address is left out. A chosen
  saved address is written to the config as "My tip list", never with the
  private name.

**Who is paid** is one function, `tippableRecipients`
(`apps/web/src/lib/tiplist/checks.ts`). The transfers (`tipTransfersFor`),
the delivery and prompt counts, the summary card and the Tip row all take its
answer, never `config.tips` itself. It skips a recipient that is not listed
and has no `confirmed` stamp, one whose listed entry is retired (unless kept
since), a public test account off a test network, a known contract, and the
connected account (which TipGuard would refuse for the whole tip); a skipped
share is not sent and not spread over the others. Tags (LISTED, MINE, UNLISTED, RETIRED) come
from matching the address against the lists, never from what a config says
about itself, so a settings link that writes `source: "tiplist-spx-community"`
beside its own address still reads UNLISTED. The first tip to an address the
list doesn't vouch for waits for the person on the Tip row: the name, the
whole address in groups of four, the lookalike result and what its name
reads like (a listed or saved name at another address, mixed alphabets),
then **Tip this address**. The settings-link prompt lists every new tip
address the same way before "Apply these settings". On the first load of the
build with the list (storage held none), recipients already in the config
were stamped confirmed once, since the person chose them before the check
existed; those picked from a shipped list need no stamp and got none. A list
storage can't read is never migrated over, and one saved by a newer build is
never written over.

The Guard doesn't rely on any of it. `tipIntentViolations` refuses, as
`TIP_MALFORMED` with a `detail.reason`, a transfer to the token being tipped
(`token-contract`), to Permit2 (`permit2`), to `0x…dEaD` (`burn`), to a public
development account off a test network (`public-dev-account`), and to any
contract the host passes in `refuseRecipients` (`known-contract`: the listed
tokens, the vault factory, batcher and implementation, the venues'
contracts; a person's own vault is not in it, since vaults can't be listed
ahead, and "My tip list" warns about code at any address instead). Refusal only, so it can
narrow what passes and never widen it; the red-team cases are in
`packages/guard/test/redteam/tips.test.ts` and `tips-permit2.test.ts`.

## Pool statistics

The third module kind, and the one that shows the capability model paying for
itself rather than merely constraining things.

Reading a pool's reserves looks impossible here. A module may only call
contracts its manifest declares, and a pool's address is not known until
a factory returns it — which is exactly why `WirePoolRef.depth` was a
venue-defined proxy instead of a real figure.

The way through is that **the broker checks a call's target, not its
arguments**. `balanceOf(pool)` is a call to the *token*, whose address is fixed
and trivially declarable, with the pool as a parameter. So
`modules/tracker-pool-stats` reads the true balance any pool holds while
declaring three token contracts and nothing else. No dynamic address is
allowlisted and the broker did not change by a line.

The cost is stated rather than hidden: a tracker knows only the tokens it
declared, and a pool holding anything else comes back `supported: false`. A
fabricated zero would be indistinguishable from an empty pool, and one of those
is a reason not to trade.

Three sources meet in `apps/web/src/lib/stats.ts`, kept apart deliberately:

- the **tracker** reports balances, sandboxed and untrusted;
- the **host** reads volume from Swap logs, because `eth_getLogs` is not a
  capability any module gets — a log filter is a far larger surface than a
  batched `eth_call`, and widening the broker for a display statistic would be
  a bad trade;
- the **oracle** prices it, reusing the same time-weighted feed the Guard
  cross-checks swaps against rather than a second one that could disagree.

None of it is in the path of a signature. A tracker that lies costs a bad
decision, not a bad transaction, which is why every figure degrades to
*unknown* rather than to zero — including when an endpoint caps log queries,
which most hosted ones do aggressively. The reader steps the window down until
one is accepted and the column says which period it actually covers.

## Money

Money in spDEX is how an amount is typed and how a figure is shown, and
nothing more. What is quoted, saved, checked and signed is always a token
amount. The Guard never sees a currency, a plan's config is unchanged
(`amountPerBuy` in base units, as before), and no rate ever refuses or changes
a plan.

**Two rates, both read through the person's network service.**

- **Dollars** are spDEX's 10-minute average in USDC (`Engine.usdRates`), the
  same oracle instance the Guard cross-checks swaps against, never a second
  one that could disagree. Native ether is priced as WETH, and USDC is counted
  as exactly one dollar, as everywhere else in spDEX; a note says when
  Chainlink's USDC/USD answer is more than 1% away.
- **The other 16 currencies** are Chainlink's dollar price of each
  (`packages/chain/src/fx.ts`; the proxies are `CHAINLINK_FEEDS` in
  `constants.ts`, and the fork integration test reads every `description()`
  and `decimals()` again). All 16 answers and USDC/USD come back from one
  Multicall3 `aggregate3` call that is the same whatever currency the person
  chose, so the request says nothing about where they are, and switching
  currency reads nothing. The currencies people ask for that have no feed on
  Ethereum (INR, HKD, SEK, NOK, PLN, ZAR) aren't offered: a rate from
  anywhere else would mean asking a third party.
- **An answer is unknown** when its call failed, it is zero or less, it was
  never updated, its decimals differ from the table (they are read in the same
  call, so a repointed proxy can't scale amounts by 10¹⁰), it is more than
  `FX_MAX_AGE_SECONDS` (432,000 seconds, five days) old by chain time, or it
  is outside 0.2× to 5× of its answer at `FX_REFERENCE_BLOCK`. Five days
  covers a weekend's market close (49 hours), a 24-hour heartbeat and a
  holiday. The references are refreshed at each release.

**When they are read** (`apps/web/src/lib/money/rates.ts`). Only when
something on screen needs them: an amount field used, a quote, a panel with a
"≈" figure. Then dollars again every 5 minutes and currencies every 15, while
the tab is visible and something still needs them. A failed refresh keeps the
last answer for display, for up to 30 minutes, and tries again after a minute.
So the default page makes no background reads for money, and money figures no
longer depend on Pool statistics; the Features dialog's cost text says so.
Rates belong to the service that answered them, and a new service drops them.

**Sizing, the part that moves money** (`lib/money/resolve.ts`,
`lib/money/convert.ts`). Every step is integer arithmetic with one division,
rounded down, then cut to six significant digits (`floorSignificant`), so the
amount signed is one a person can read back: $20 at 2,451.31 USDC per ETH is
0.0081589 ETH, a vector the unit tests pin.

- **Frozen.** A money amount is sized against one set of rates and kept with
  them. A re-render or a background refresh never sizes it again; a newer
  price is offered ("Newer price from 14:07 · Use it"), never applied.
- **Fresh, or no button.** Get price and Start are enabled only while the
  dollar price it was sized with is at most 5 minutes old by the tab's own
  `performance.now()`, and the tab hasn't been hidden since that read.
  Otherwise the field offers "Use the price now", and shows the new token
  amount before either button enables.
- **Bound to its currency.** An amount in euros needs a valid euro answer
  from the same read. Without one it is refused; it is never sized as
  dollars. A "≈" figure may fall back to dollars, with a note saying so;
  sizing never does.
- **Token first.** Confirm lines lead with the token amount and name the
  money as what was typed ("You pay 0.0081589 ETH: the $20.00 you typed, at
  the price from 14:02."), never echoing it back through the same rate as if
  that confirmed anything. A change to the resolved amount clears a quote
  already on screen, so the field and You pay never disagree.
- **No repricing.** A plan typed as $20 saves the token amount and spends
  exactly that at every buy. The form says so before Start, and says that
  paying with USDC is how to spend the same dollars each time.

**Parsing** (`lib/money/parse.ts`, `parseDecimal`). It replaced a parser that
deleted every comma, so a phone keypad in a comma-decimal region typed `0,5`
and was quoted 5 ETH. The decimal and group marks come from `Intl` for the
person's number style, plus what keyboards actually type (a plain space for a
narrow one, `'` for `’`). Grouping is accepted only where it can't be
misread (`10,000.5` pasted from a balance), `1,500` or `1.500` alone is
refused with a choice of its two readings, a mark that doesn't fit the style
is refused with a one-tap fix, and another currency's symbol is refused
rather than guessed (`$` is also the peso's sign). A field of whole numbers
(yen, won, rupiah, a recurring plan's count) reads the page format's own
group mark as grouping, since nobody types a decimal there, and offers any
other mark only its whole-number reading. Arabic, Persian and Indic digits,
and the Arabic decimal and group marks, are read as typed; "Automatic" shows
Latin digits. Fields are written back
with `formatAmountForField` (the locale's mark, no grouping), so they read
back as written; `formatAmountExact` stays machine format for code that
compares amounts.

**Preferences** (`lib/money/prefs.ts`, `spdex.money.v1`). The currency, the
number style and each field's unit belong to the browser, like the theme, and
never enter the config, an export or a share link. A fresh browser starts in
the currency of the first language tag that names a region (`es-AR` → pesos;
a bare `es` names none and means dollars), in that currency's unit rather
than ETH, since newcomers think in money. The token amount is always shown
under it.

What it deliberately doesn't do: no price chart, no price history, no value of
anyone's holdings, and no average cost. The ticker's "% to flip" stays in
dollars, the meme's own unit.

## Records

A one-time swap used to leave no trace in spDEX. The chain has it, but nothing
tied it to the person except their address. Your activity, the finality
badge, Your stack and the "I bought" card are what this browser records and
what it can show from the chain, and each of them keeps the rule that unknown
is never zero.

**What is recorded** (`apps/web/src/lib/records/store.ts`,
`spdex.receipts.v1`). A swap is recorded after it settles, and a partial swap
too (`ExecutionError` with legs done), with its tips; plan buys come from the
auto-buy ledger, and vault plans' buys are read from the chain. The store keeps
at most 1,000 swaps and tips, oldest dropped first with a note, writes under
one Web Lock (`spdex.receipts`) as the ledger does, and never writes over a
record it can't read. It holds addresses and hashes, so it never enters the
config, an export or a share link.

**Rows are the chain's account** (`lib/records/build.ts`, `attribution.ts`,
pure). Every row's account is its first transaction's receipt `from`, read
once and kept forever with the fee and the block; a row whose receipt can't be
read is listed as "wallet unknown" and left out of totals, never credited to
the connected wallet. What was sold is the transaction's value for ether and
`Transfer` logs from the account for tokens; what was bought is `Transfer` logs
to the account. Nothing is taken from the quote.

**Value at the time** (`lib/records/values.ts`), in order: `twap-seen`, the
rates this browser held when it saw the trade settle, if read at most 10
minutes earlier; then `chainlink-at-block`, only when the person presses "Fill
in values from the chain": Chainlink's ETH/USD, USDC/USD and every currency
answer at the trade's block, one Multicall3 `eth_call` per block, at most 200
per press, which needs a service that keeps old state. A trade that sold SPX
stays blank: nothing on chain says what SPX was worth at a past block. So
does a row of buy fees, whose sold and value cells are left empty rather than
written as 0, and "Fill in values" skips it. Each
source keeps every currency's answer, so a later change of currency leaves
nothing blank that was known. Otherwise the cell is blank, never 0, and there
is no average cost anywhere. A vault buy the owner triggered themselves has
no buy fee (it came back to them), and its network fee is read from that
transaction's receipt, unknown until then, never 0.

**Reads.** None until Your activity is opened, Your stack comes on screen, or
Welcome waits for a first buy. Then one receipt per transaction not yet cached
and each vault plan's history, best effort.

**The file and the statement.** The CSV (`lib/records/csv.ts`,
`spdex-activity-v1`) is machine format whatever the page's number style, quoted
as RFC 4180 says, with a leading `'` on any cell a spreadsheet would run as a
formula, since plan names are anyone's text. What it leaves out is said on
screen and on the statement, never as a trailing row that would break the
parsers it is for. The statement is a print-only container and
`window.print()`: per-token totals, no averages, and "Not tax advice".

**Reminders** (`lib/reminders/`). A plan you confirm can go into your own
calendar as an `.ics` file (RFC 5545, escaped and folded; no address, key or
hash in it): one repeating event for a whole number of days, the next 48 buy
times for an hourly plan, none under an hour and none for a vault. And an open
tab can notify you when a buy falls due while it is hidden: the permission is
asked only when the box is checked, and the notification has no icon, image or
badge, each of which would be a fetch (`no-requests.test.ts` fails on one).
There is no push service: Web Push needs an application server (rule 5).

**Included → Final** (`lib/finality.ts`, `components/trust/FinalityBadge.tsx`).
"Final" is the person's network service's word, from
`eth_getBlockByNumber("finalized")`; a service that doesn't report one makes
finality unknown, never assumed. The receipt is polled every 12 seconds while
a transaction waits, one finalized-block read every 30 seconds serves the whole
page, the block is read once more at the end to notice a replaced one, and
after 45 minutes the badge stops and points to an explorer. On the local fork
`finalized` is 64 blocks behind the head.

**Your stack** (`lib/culture/stack.ts`). Holding is one `balanceOf`. Stacked
is the measured SPX of this browser's buys plus each vault's own `totalOut`;
vault figures come from the vaults' counters, which are exact, never from
their logs, which a service may serve only in part. Put in is what was sold for
SPX, with its value at the time where known ("for 20 of 23 buys" otherwise).
The goal counts Holding, however the SPX got there. No value now, no gain or
loss, no projection.

**The card, and checking it** (`lib/culture/card.ts`, `receipt.ts`). The card's
preview is JSX, so React escapes the caption; its PNG is that mounted SVG,
serialized, drawn from a `data:` URL onto a 1,200 × 675 canvas and saved
through `lib/download.ts`. It shows the amount, the date, the network and the
hash, never a price or a money figure. A `#receipt=<chain>:<hash>` link opens
a view that trusts the card for nothing: it reads the transaction through the
viewer's own service, counts only `Transfer` logs emitted by the SPX contract,
netted per address, and never treats a pool as a receiver (SPX paid into one
was sold). "Bought" is only what a market's swap paid out: SPX a pool spDEX
itself discovers for SPX (from every listed token, so a USDC buy counts) sent
the receiver, less what they sent it back, and no more than that pool's own
v2 or v3 `Swap` logs say it paid them. It is named as a vault's when the
receiver owns an `isVault` vault whose `Bought` is in the logs. Anything else
the receiver gained is a separate line, "received from … (an account)", and a
pool's payout with no swap behind it (liquidity taken out, a skim) is said to
be not a purchase.
A visitor with no service chosen yet sees why the page is waiting, and nothing
is read until they choose one.

**Addresses a file carries** (`lib/links.ts`). A card or a calendar file
outlives the tab, so the link it prints is a build setting,
`VITE_SPDEX_APP_URL`, and never the address bar, which may be a dev server, a
shared gateway or a stranger's copy. Unset, the file has no link and says so.
Verify this build's `git clone` line works the same way, from
`VITE_SPDEX_SOURCE_URL`.

## Recurring buys

Auto-buy brought the fourth module kind, `scheduler`, and is the first feature
that spends the user's money on a schedule. That is the shape of every attack
in `docs/THREAT-MODEL.md`, so what follows is mostly about where each decision
lives and what checks it.

A plan runs one of two ways, because people want one of two things from a
recurring buy: to be asked at each buy, or to set it and forget it. This
section is about the first, **Confirm each buy myself**: a plan the owner's
own wallet approves buy by buy, run by a tab. The second, **Set and forget**,
is a vault that runs on chain with no tab at all; it shares only the form and
the list of plans with the first, and has a section of its own, "No contract
anyone controls", below.

A plan is set up in the Recurring tab of the **Buy SPX** tile and runs from its
card in the **Auto-buys** tile (`apps/web/src/components/dca/`). Those screens display
and ask; `apps/web/src/lib/dca/useAutoBuy.ts`, the one React hook under `lib/`,
wires everything below to the page — one `DcaRunner` per tab, built while
auto-buy is on and rebuilt when the engine or the config changes — and turns
each click into the one call it means on the runner, the record or the vault
code. None of those screens signs or sends anything itself, and none of the
checks below lives in one.

**The config holds the plan.** A plan in `dca.plans` says what to sell, what to
buy, how much each time, how often, how many times, when to start, and which of
the two ways it runs. There is no "forever": the most a plan can ever spend is
`amountPerBuy × maxBuys`, known before it starts. It sits in `SpdexConfig`
beside the tip policy for the same reason — an instruction to move money is
something the user can read, export, diff and share — and the only addresses
in it are the two tokens, and a vault plan's vault once it exists, which is a
public fact on chain. It holds no account address, no key and no history,
which are facts about one browser that a shared link would leak. Every plan in
a config from outside this browser arrives paused: `arrivePaused` runs inside
`importConfig`, the one funnel a link and a pasted file share, because only the
link is staged for review.

**This browser holds the record.** Which wallet a plan buys for, which address
signs, how many buys settled, how much of the budget is committed, which buy
window was last used: `apps/web/src/lib/dca/ledger.ts`, in localStorage. It
fails closed on a record it cannot read: that is `"unavailable"`, never an empty
ledger, and no plan buys until it can be read. A record that is simply not there
is another matter. The plan does not buy — it shows as not started here — and
the Guard would refuse a buy that got that far, counting a missing record as a
spent budget. But starting the plan is what writes a record, and it starts from
zero: on another computer, and here too if this browser's record was lost. Only
that deliberate act by the owner stands between the two.

**The scheduler module proposes.** `modules/scheduler-dca` is handed the plans,
a summary of what each has bought, and the time — the host's, since a module
may not read a clock — and answers which buys are due now, how large, and when
each plan's next one could be. It declares no capabilities and no contracts.
Time is divided into windows of the plan's interval — "buy times", on screen —
and only the window open now is ever due. One missed while no tab was open is
recorded as missed and skipped, not made up, because a catch-up burst defeats
the averaging and is what anyone able to delay the app would want to provoke.

**The host and the Guard hold the envelope.** `vetScheduleDecision` sorts the
answer before anything is quoted, refusing a buy for an unknown plan, a second
buy for one plan, a window other than the one open now or one already used, an
amount that is empty or larger than the plan's, or a plan with no buys left.
What survives is quoted fresh by `Engine.quoteScheduled` — the same routing as a
manual swap, with the plan's recorded signer as the account and its owner as the
recipient — and judged by `ScheduledBuyGuard`. The plan comes first: pair,
chain, signer, delivery to the owner and nobody else, a price floor on every
leg, one buy's worth summed across legs, the budget against what is already
committed, the window, and an interval of at least `MIN_DCA_INTERVAL_SECONDS`.
Then every leg goes through the unchanged swap Guard and must come back
`verified`: `unverified` is signable for a manual swap because a person reads
the banner that says so, and here nobody does. The schedule layer wraps the
Guard rather than adding an option to it, for the reason tips got a path of
their own — an option on the swap check is one edit away from an exemption in
it. Wrapped, it can only add refusals.

**Claim before signing.** After a signable verdict and before the first
signature, the buy's window and its full `maxAmountIn` are written to the
record, and given back only when spDEX can tell nothing was bought. A crash in
between costs a skipped buy, never a second one in that window. How it tells
depends on who broadcasts. spDEX records each transaction's hash before
broadcasting whenever it posts the signed bytes itself, as it does for a buy
sent privately. A wallet that broadcasts a buy itself
reports the hash only once it has sent it, so a wallet-mode claim also records
the owner's next nonce. If the tab is lost before the hash arrives, a later
look settles the buy by that nonce: once the owner's account has used it, the
buy counts as made, whatever went out in its place, and it is given back only
if the nonce is still unused once the buy's deadline has passed on chain. The
record therefore errs toward counting a buy that did not happen, rather than
missing one that did.

**One tab acts.** A Web Lock, `spdex.dca.leader`, held for the life of the tab,
decides which tab runs auto-buys; the others watch and take over when it
closes. Two tabs would otherwise be two schedulers. Without Web Locks nothing
runs, and the runner reports why rather than guessing.

**A wallet-mode buy never opens the wallet on a timer.** When one falls due the
runner marks the plan due and does nothing more until `confirmDue` is called —
the **Confirm buy** button on the plan's card. That call re-quotes,
re-checks and claims, and only then opens the wallet. A prompt that appears by
itself on a tab someone left open is a prompt people learn to click through;
one left waiting overnight would, once approved, send a transaction past its
deadline that reverts and still pays its fee. A buy time that ends unconfirmed
is recorded as not confirmed.

**No spending wallets.** Until config version 8 a third signer, `autopilot`,
bought without asking from a *spending wallet*: a key this browser generated
for one plan, which the owner funded. It was neither of the two things people
want — it bought unattended, but only while a tab was open — and a vault does
"set and forget" without spDEX holding a key, so it was removed (`DCA_SIGNERS`
in `packages/core/src/dca.ts` says so; the migration is under "The config is
the application"). No release ever made a spending wallet, and since
2026-10-02 the app no longer reads or withdraws them.

**What it deliberately does not do.** Scheduled buys never tip. Each uses one
market (`maxSplits = 1`, whatever the Router setting says for manual swaps): a
split buy is a transaction per leg, and for a token sale a permission per leg
too, so every extra leg is another wallet prompt. With one market the stated
costs are one transaction per buy — two for a token sale, the permission and
the swap. An oracle warning asks before a buy opens the wallet — the verdict
itself stays signable, because the oracle may never refuse. "Buy
anyway" re-quotes and goes ahead only if the fresh divergence is no larger than
the one the owner saw. Three buy times in a row with a refused or failed buy
halt the plan until the owner resumes it. The count rises at the first failure
in a buy time, so the third halts the plan at once, without waiting for that
buy time's retries.

Manual swaps and scheduled buys reach the chain through one function,
`executeQuote` in `apps/web/src/lib/execute.ts`, handed the user's wallet as
the sender: every call of every leg, in order, from the account the verdict
was checked for.

## No contract anyone controls

Until auto-buy vaults, spDEX shipped no contract at all, and "No contract of
our own" was on the list of things there is deliberately none of. That heading
is now "No contract anyone controls". What changed, and what did not:

**What changed.** People wanted auto-buys that go on while no spDEX page is
open. A plan run by a tab cannot: browsers slow a background tab, phones pause
one almost at once, and a closed one runs nothing. A server that ran plans
would be a backend, which rule 5 in `AGENTS.md` rules out, and it would have to
hold people's keys or money. A contract cannot wake itself up either: something
has to send each buy's transaction. So the "server of sorts" is a contract that
holds one plan's budget and enforces the plan itself, so that it does not
matter who sends the transaction. The caller chooses only *when*, and only
inside a window that is due; never how much, what, to whom, or at what price.
Anyone may trigger a due buy and is paid a fixed buy fee from the vault for
it. So spDEX now ships three contracts in `packages/vault/contracts`:
`SpdexVaultFactory`, `SpdexDcaVault`, and `SpdexVaultBatcher`, which lets a
keeper trigger many vaults' buys in one transaction. With them come the
TypeScript generated from them (`@spdex/vault`) and a keeper.

**What did not.** Nobody controls them. The factory and the batcher have no
owner, no admin, no fee and no upgrade path. A vault has no pause switch
anyone else holds. None of the three takes a fee; any keeper, including one
spDEX's developers may run, collects each vault's buy fee on the buys it
triggers. Once a vault exists, what it does is fixed:
its terms are part of its code, and the implementation it delegates to is part
of its proxy. That is what the old heading was protecting: there is still
nothing for us, or anyone who takes this repository over, to switch. What is
gone is "no contract to trust". These contracts are **unaudited**, and someone
who chooses a vault trusts their code with what they put in. That is why every
vault's budget is capped at 0.5 ETH (`MAX_FUNDING`), and why the app marks the
choice **Unaudited** wherever it offers it.

### What a vault can and cannot do

A vault is one plan: buy SPX with WETH, `amountPerBuy` at a time, one buy per
window of `interval` seconds from `startAt`, at most `maxBuys` times.

It can:

- make at most one buy per window, and none sooner than half an interval after
  the last, so one push of the price cannot cover the end of one window and the
  start of the next. A window nobody triggers is skipped, never made up later,
  for the reason a tab-run plan skips one: a catch-up burst defeats the
  averaging, and it is exactly what someone able to delay buys would want to
  provoke;
- swap on its market's Uniswap v2 pair with the output paid straight to its
  owner, so it never holds what it buys, and refuse the buy (`DeliveredShort`)
  if the owner received less than the pair sent;
- refuse a buy priced more than `maxSlippageBps` below its price reference
  (below);
- pay whoever triggered the buy its buy fee (`keeperReward`) in WETH, never as
  a raw ether transfer, which would let an unknown address run code in the
  middle of a buy;
- take more budget from its owner (`fund`, which sends back whatever the
  remaining buys and their fees don't need), return everything to the owner as
  ether (`close`, which pays WETH instead to an owner that refuses ether, and
  can be called again to sweep anything that arrives later), and send the owner
  any token it received by mistake (`rescue`; WETH only once closed).

It cannot:

- change a term, pause, or be upgraded. `close` is the only way to stop it;
- send its money anywhere except into a buy delivered to its owner, its
  caller's fixed buy fee, or back to its owner;
- buy a token, or use a pair or pool, that its factory did not list;
- take more than 0.5 ETH from its owner. Creation refuses a budget (every buy
  plus its buy fee) above `MAX_FUNDING`, and `fund` never takes the vault's WETH
  past what the remaining buys and their fees need. The cap limits what
  the owner can put in, not what the vault can hold: anyone can send a vault
  WETH, even before it exists, and `close` returns that too. The cap is per
  vault, and nothing stops one account from creating several;
- wake itself up. A plan runs only while somebody triggers it.

**The price floor.** Each buy must deliver at least `amountPerBuy` worth of
SPX at a Uniswap v3 pool's price, less `maxSlippageBps`. The contract allows up
to 5%; the app offers 1%, 2% or 3%. The price is the better, for the owner, of
the pool's 10-minute average and its price now. The average is the same kind
of reference the Guard's oracle cross-check reads, and a swap in the buy's own
block cannot move it. The price now is there because an average lags, and a
market that has just fallen should not be bought at the stale average less the
allowance. The pool must also have at least 10 WETH of depth behind its price
(`MIN_ORACLE_DEPTH`, a harmonic mean over the same ten minutes), checked at
every buy, because a pool that can be moved for free should be refused rather
than believed.

This floor refuses, where the app's oracle only warns. That is exactly what
rule 2 in `AGENTS.md` warns about: whoever moves the average can make buys
wait. It is the right trade here because nobody watches these buys to read a
warning, and the alternative is a buy with no floor at all. What it costs the
owner is skipped windows, not money. `docs/THREAT-MODEL.md` says what moving it
costs, and what a keeper can take within the allowance.

### Clones

Each vault is an EIP-1167 minimal proxy: 45 bytes that delegate every call to
one implementation, which the factory deploys, with the plan's terms appended
to the clone's own code (112 bytes; `libraries/VaultArgs.sol` has the layout).
A full contract per plan cost about 2.3 million gas to create. A clone costs
about 175,000 (measured on the fork), of which about 29,000 is the factory
adding it to its list (below), and each call about 5,000 more, for the proxy,
the `delegatecall` and reading the terms back.

The terms live in code rather than in storage because nothing can write code
after it is deployed, the same guarantee `immutable` gave the full contract.
There is no initializer. The creating transaction writes the terms as it
deploys the clone, so no clone ever exists without them, and there is nothing
to call first or front-run. Each call reads the terms back with `EXTCODECOPY`
of its own address: under `delegatecall` that address is the clone, whereas
`CODECOPY` would read the implementation's code, which carries no terms
(`test_codecopyReadsTheImplementationNotTheClone`). The implementation itself
refuses every call about a plan (`NotAClone`).

A clone's address comes from CREATE2, with the salt `keccak256(owner, nonce)`,
over code that carries the terms. So the address commits to the owner and to
every term. `predictVault` gives it before the transaction is mined, and the
Guard proves that a vault is the account's, on the plan's terms, by recomputing
that address rather than by believing a read.

A clone made by hand, outside the factory, runs the same code with whatever
terms its maker wrote into it. The factory's `isVault` is how the app, the
keeper and the batcher tell its vaults from those, and none of them trusts a
vault the factory does not vouch for.

### What the contracts tell the chain

Everything the beta needs to learn about vaults is in their own events and
state (see "Beta data", below), so the events carry what would otherwise need
archive reads:

- `Bought(slot, amountIn, amountOut, keeper, reward, floorOut, buyNumber,
  oracleDepth)`. Besides what was bought and what its caller was paid, the
  floor the buy was held to, so execution against the oracle is one event's
  arithmetic (the fair amount is `floorOut × 10,000 / (10,000 −
  maxSlippageBps)`); the vault's buy count, this buy included, so a missing
  log shows as a gap, which slot numbers cannot show because windows
  legitimately go unbought; and the oracle pool's depth at that buy, the only
  data that can say during the beta whether `MIN_ORACLE_DEPTH` (10 ETH) is
  right before it is fixed for good. About 900 gas a buy.
- `VaultCreated(owner, vault, marketIndex, terms, funded)`. `funded` is the
  ether sent with the creation, so deposits are exact from the factory's and
  the vaults' own events rather than from WETH's.
- **The factory's list.** The factory keeps every vault it creates in an
  append-only list, read with `vaultCount()` and `vaultsPage(offset, limit)`
  (at most 1,000 a call). A keeper finds vaults there exactly, with no
  `eth_getLogs` range limits and no start block to know; a stranger starting
  months after deployment would otherwise need tens of thousands of log
  queries on a hosted free tier. It is written in the same call as `isVault`,
  so it is the same fact and gives nobody any control. It costs about 29,000
  gas per creation, once.

Nothing records which frontend or keeper was used. A marker in calldata or an
event would answer that, and would fingerprint the people using it on chain.

### The market list

A plan does not name a token, a pair or a pool. The factory's constructor
takes a fixed list of markets, each a `(tokenOut, v2 pair, v3 oracle pool)`,
and a plan names an entry by its index. On Ethereum, and so on the fork, the
list has exactly one entry: SPX, traded on its v2 pair
`0x52c77b0cb827afbad022e6d6caf2c44452edbc39`, with its price floor read from
its 0.3% v3 pool `0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3`.

The first design let a vault use any token with a v2 pair and a v3 pool
against WETH. The phase-5a security reviews showed that the open choice caused
the worst findings: an empty or thin genuine v3 pool makes the floor
meaningless, a pool can be made "deepest" for the few minutes in which the
choice is made, and a hostile token can run code that traps whoever pays for a
buy's gas. Taking the choice away closed all three.

The constructor refuses any entry that fails a check it can make:

- the pair must be the one Uniswap v2's factory lists for WETH and the token;
- the pool must be the one Uniswap v3's factory lists for WETH, the token and
  the pool's own fee tier. An imitation answers `token0` and `fee` like the
  real thing, and only the factory's mapping tells them apart;
- the pool must keep at least 100 observations and have at least 10 WETH of
  depth;
- the pool's 10-minute average must agree with the pair's mid price within 2%
  (`MAX_MARKET_GAP_BPS`);
- no token may appear twice.

Depth is checked again at every buy, since liquidity can leave. The agreement
between pool and pair is not, because a vault that refused to buy while they
disagreed could be stopped by anyone willing to move the pair in the same
block.

These checks vet markets, not tokens. A token whose own code is written to
trap a keeper passes all of them once it has a genuine, deep market
(`test_r5b_aKeeperTrapTokenWithGenuineMarketsPassesEveryListingCheck`), so
tokens are vetted by hand, by whoever writes a list. **Another list means
another factory, at another address.** No function adds or removes a market.

### One address, checkable from source

The factory is deployed through the standard deterministic deployer
(`0x4e59b44847b379578588920ca78fbf26c0b4956c`) with a fixed salt. So its
address depends only on its bytecode, which includes the implementation's
because the constructor deploys it, and on its constructor arguments: WETH,
Uniswap's two factories and the market list. For Ethereum's list that address
is `0xe4a1410a9ee0833d41e7514306e65ad729b7199e`, and the implementation it
deploys is at `0xb32b5e1092de9596877be9b6c783c7e98b55b1c6`. The batcher is
deployed the same way, with a salt of its own
(`keccak256("spdex.vault.batcher.v1")`) and its factory as its one constructor
argument, so its address follows from its code and its factory's:
`0xc5ce65451dd5fc99d08eb18440b06f2bcca3c5a0`. The compiler is pinned (solc
0.8.33), metadata hashes are off, and `via_ir` is never used (it would move
every address and every gas figure), so two honest builds produce the same
bytes. `packages/vault/src/artifacts.ts` is generated from the build, and the
`contracts` stage of `pnpm verify` rebuilds it and fails on a stale copy.
Anyone can recompute the addresses the app and the keeper trust, just as anyone
can check the bundle's CID.

**Every release is listed, for good.** `packages/vault/deployments.json` lists
each release — a factory, its batcher, and the mainnet blocks they were
deployed in — oldest first, and `artifacts.ts` carries it as `DEPLOYMENTS`.
`build:artifacts` rewrites only a trailing release not yet deployed (its blocks
still null), and adds a new entry after one that is; the blocks are filled in
by hand after the mainnet deployment, the only edit an entry ever gets, and
freeze it. `--check` fails when a frozen entry changed or the last entry is not
this build. No release is ever removed: the keeper and the report serve every
listed release, each batch going to its own release's batcher, so a new
release never orphans an old one's vaults. Today there is one, `v1`, not yet on
mainnet. The app reads the last release's factory only. Once a second release
exists, the intent is that the app lists, funds and closes vaults from every
listed factory and creates only on the latest; that is agreed, not built.

The app checks that there is code at that address. On a chain where there is
none yet, it offers the one-time deployment. Anyone may send it: the factory
has no owner to set, and it lands at the same address with the same list
whoever sends it. It costs about 3.6 million gas (3,562,618 on the fork), and
the batcher, which anyone may deploy after it, about 600,000 (601,283). A
deployment sent while a market fails a check reverts, and succeeds when sent
again once the market passes. The deterministic deployer reverts without a
reason, so the app first runs the creation code as a plain call
(`simulateFactoryDeployment`), which names the refusal.

Two people sending it at about the same time is a race nobody can close. The
second transaction's creation collides with the factory the first just made,
and a CREATE2 collision reverts having used nearly all of its gas limit:
roughly the 3.6 million again, times the wallet's padding (`Factory.t.sol`
pins that a second deployment fails). The app checks for the factory's code once more just
before the wallet opens, which narrows the window, and the button says the
rest.

### The batcher

A keeper that sends one transaction per buy pays a transaction's fixed costs
on every buy. `SpdexVaultBatcher` lets it make many due buys in one:
`executeBatch(vaults, rewardTo, minRewards)` calls `execute` on each listed
vault its factory vouches for, and passes every buy fee on to `rewardTo` in
the same transaction. In a batch, a later buy on a busy oracle pool costs
about 101,000 gas, and the batch about 151,000 once, where a transaction of
its own would pay that once-per-transaction part for every buy
(`BatchGas.t.sol` pins both figures).

- **One more caller, with no more rights.** It calls each vault's `execute` as
  anyone may, and each vault still checks its own terms and pays its caller,
  here the batcher. It is bound at construction to one factory and asks that
  factory's `isVault` on chain before calling any vault: one it does not vouch
  for is skipped with no call (`NotFromFactory`). It has no owner, fee, setter
  or storage but a transient lock, no `receive`, and holds nothing between
  calls: every wei of WETH it holds at the end goes to `rewardTo`.
- **Each vault gets exactly 400,000 gas** (`EXECUTE_GAS_CAP`, which
  `@spdex/vault` mirrors as `MAX_EXECUTE_GAS_LIMIT`). A vault is attempted
  only while at least 460,000 is left (`MIN_GAS_PER_ATTEMPT`: the cap after
  the 1/64 the EVM keeps back, plus what finishing the batch costs), so a
  hostile vault can burn its cap and no more, and when gas runs short the rest
  are `NotTried`, never failed. It copies 32 bytes of a success and 4 of a
  revert, so no vault can return-bomb it.
- **One refusal does not sink the rest.** A vault that refuses — another
  trigger got there first, the price moved — is recorded
  (`NotTriggered(vault, reason, gasUsed)`) and the others still buy. If none
  bought, the call reverts `NothingBought(reasons)`; if what it earned falls
  short of the caller's `minRewards`, it reverts `TooLittle`. A private,
  revert-protected relay then drops the transaction, so a lost race costs its
  sender nothing, and an `eth_call` of a hopeless batch says why each vault
  failed.
- **Earned, never swept.** `Batch` reports `earned`, the WETH that arrived
  during the call (the fees of the vaults that bought), apart from `swept`,
  WETH it already held because someone sent it. Only `earned` counts toward
  `minRewards`, and the report never counts `swept` as revenue.
- **Why passing the fee on is not a fee.** Rule 6 allows a payment only to the
  caller of `execute`. The batcher is that caller, and in the same transaction
  hands the payment to whoever called the batcher, at the address that caller
  names: the caller's own reward, sent where the caller chooses. The batcher
  keeps nothing and charges nothing, and `minRewards` is a condition the caller
  puts on its own transaction. A vault's caller still chooses only *when*.

The app neither deploys nor calls it. It knows the listed batchers' addresses
only to say "triggered in a batch" in a vault's history.

### The buy fee

A vault pays one thing to anyone but its owner: its `keeperReward`, which the
app calls the **buy fee**. It is fixed at creation, written into the clone's
code (`VaultArgs.sol`), and nothing can change it afterwards, spDEX included.
The app proposes it from `packages/vault/src/fee.ts`:

```
network part = 122,000 gas × 0.15 gwei = 0.0000183 ETH, the same for every plan
its tenth    = 10% of the network part, rounded up = 0.00000183 ETH
ceiling      = 0.69% of the buy, rounded down: the contract's own limit
buy fee      = the network part and its tenth (0.00002013 ETH), or the ceiling if that is less
```

- **0.69%** is the most a buy can pay anyone for being made, the network
  cost included. It is a contract constant (`MAX_REWARD_BPS` in
  `VaultLimits.sol`): the factory refuses a vault whose fee is higher,
  whoever writes its terms. What a keeper keeps is the fee less the network
  fee it paid, so nobody who triggers buys, spDEX's developers among them,
  makes more than 0.69% of a buy. The app has no ceiling of its own to drift
  from it: `BUY_FEE_CEILING_BPS` is read from the build.
- **The tenth** (`BUY_FEE_MARKUP_BPS`) is all the fee asks for beyond cost
  while spDEX is a prototype: about half a cent a buy. A later release may
  raise the default towards the ceiling, for plans created after it. None can
  pass the ceiling without a new factory at a new address.
- **The network part** is one batched buy's gas: 106,000 for a buy in a batch
  on a busy oracle pool (`BATCH_PER_BUY_GAS`; measured 101,255) and a tenth of
  the 160,000 a batch pays once (`BATCH_FIXED_GAS`, measured 150,602;
  `FEE_BATCH_SIZE` 10). It is priced at a constant of the release, 0.15 gwei
  (`FEE_NETWORK_REFERENCE`), never at the fee of the moment. A plan fixes its
  fee for every buy it will ever make, and keepers pay at each buy, not at
  creation: priced live, two identical plans made in a dip and in a spike
  would pay up to 2.2 times apart for life, for a figure that says nothing
  about what keepers will pay. 0.15 gwei blends a week of mainnet fees for
  cheap-block and deadline sends, with room for the small batches of the
  early beta, and is re-derived by a release when fees change regime.
- **Where the ceiling binds.** Below about 0.00292 ETH a buy
  (`FULL_FEE_BUY_THRESHOLD`) the fee is 0.69% of the buy, which is less than
  the network part and its tenth; there a keeper that triggers the buy pays
  the rest of its network cost, or skips it, and nothing obliges one not to
  skip. Under about 0.00147 ETH (`CHEAP_BATCHED_BUY_THRESHOLD`) the fee does
  not cover even a batched buy at a cheap block, and the form says such buys
  may be skipped. Under 0.000001 ETH it refuses the plan.
- **What the fee does not cover.** A fee this close to cost pays a keeper
  only when buys share transactions and blocks are cheap: a batch of ten
  covers its gas up to about 0.165 gwei, a buy sent alone only under about
  0.076. Otherwise a keeper waits, skips the buy or pays the difference
  itself. spDEX's developers may run one that does during the prototype;
  nothing obliges them, or anyone.

At ETH at $2,643.94, a $1 buy pays $0.0069 and a $5 buy $0.0345 (0.69%, the
ceiling), and every buy from $7.71 up pays $0.0532: 0.54% of $10, 0.22% of
$25, 0.08% of $69. `docs/KEEPER.md` has what that leaves a keeper at each fee
level and batch size, the losses on small batches included.

**Why the fee is not mutable on chain, even in the beta.**

- It would need someone who can change it: a setter, an admin, a proxy. Rule
  6 forbids exactly that. A fee switch is a switch someone must be trusted
  with, and the first thing an attacker, a regulator or a future maintainer
  reaches for.
- What an owner signed is what they pay. Each vault's fee is in its code, and
  nothing can raise it afterwards; the app says "Nobody can change it
  afterwards, spDEX included", and means it.
- The beta still gets the flexibility it needs, off chain. The default for new
  plans (`fee.ts`) changes with a release, an IPFS CID anyone can check. Each
  keeper operator sets its own policy in its environment: which vaults, how
  much subsidy, what tips. An owner who wants a newer rate can close and
  recreate, for about 267,000 gas (a close, 52,484 on the fork, and a funded
  creation, about 214,600).
- Too low, and an operator absorbs it or keepers skip those buys. Too high,
  and the next release lowers the default. Neither needs a contract change.
- The ceiling is the one part that is on chain, and it is a constant like
  every other limit in `VaultLimits.sol`: a promise about the most anyone is
  ever paid is worth only what cannot be changed.

`VaultGuard` refuses a creation whose fee is above `feeCeiling`
(`VAULT_MALFORMED`), by name and figure, before anything is sent; the factory
would refuse it too (`RewardTooLarge`). Only creations. Funding, closing or
triggering a vault is never refused for its fee: this factory cannot make one
that pays more, and a later release with a lower ceiling must not trap the
owners of vaults made under this one.

### The keeper

There is still no server. A due buy happens when someone sends it: a
stranger's keeper, an open spDEX tab's **Trigger now** (the owner's own wallet
calling `execute`, with the buy fee paid back to them), any tab's **Help run
the network** (a batch of other people's due buys from the person's own
wallet, "Helping run the network" below), or a keeper anyone can run,
`pnpm keeper` or its Docker image (`docs/KEEPER.md`). None is promised to
run, and none needs the owner's trust: a keeper can make a buy happen or not
happen, but never make it happen differently.

`packages/vault/src/keeper.ts` is one tick, and `scripts/keeper.ts` the loop
around it, holding everything a tick must not touch — files, the lease,
signals, the wall clock — so that every decision is unit-tested against a
scripted endpoint. A tick:

1. reads the head, and sends nothing on one that is stale or went backwards;
2. follows the one transaction in flight, if any: its receipt, a resend with
   higher fees, a cancel, or giving it up once its nonce is used;
3. finds new vaults in each listed release's factory list, a few pages a tick,
   never through `eth_getLogs` (or reads an allowlist);
4. works out from the cached terms alone which vaults are due, and each one's
   window and deadline;
5. decides whether to send now: at a cheap block (a base fee under a
   percentile of recent ones, rising from the 10th at a window's start to the
   60th at its deadline), at a deadline (two hours before a daily window
   closes, less for shorter plans; plans under an hour go as soon as due), or
   at once when told to;
6. only then reads those vaults and their prices, in one Multicall3, and
   chooses a batch their fees pay for;
7. simulates the batch with `eth_call` at the fee it will pay, drops any vault
   that refuses, and signs and sends it.

- **Economics.** Each vault's fee is set against its share of the batch's gas
  (`BATCH_PER_BUY_GAS`, 51,000 more for a first buy, and a share of
  `BATCH_FIXED_GAS`, scaled by what mined batches really used) at the next
  block's base fee plus 12.5% and the tip. A vault whose fee covers that goes
  in. One whose fee falls short rides along only if it pays the fee spDEX
  proposes for its size and, by default, buys at least 0.0003 ETH on a plan
  at least an hour apart, oldest vaults first, so a flood of new vaults cannot
  crowd out older ones. By default the other vaults' surplus must carry it,
  and a keeper never plans a loss. An operator may choose to subsidise the
  rest, within caps per buy, per vault and per owner each day: each vault is
  booked at most its own shortfall, within its own caps, never on another
  vault's allowance, and a breaker stops all subsidy once a day's realised
  losses reach the daily cap.
- **Gas.** An explicit limit, never `eth_estimateGas`: 60,000, plus 127,000 a
  vault (178,000 for a first buy), plus `MIN_GAS_PER_ATTEMPT`, so every vault
  gets its whole cap. An estimate searches for the least gas at which the
  transaction does not revert, and inside a try/catch that is where later
  vaults quietly fail.
- **One nonce manager signs everything** (`keeper-send.ts`), and only what
  `assertKeeperMaySign` allows: a batch to a listed batcher paying the
  configured `rewardTo`, a listed batcher's deployment, a 0-value cancel to
  itself, or a WETH unwrap when it is its own `rewardTo`. It persists each
  signed transaction before broadcasting it, so a crash between the two
  finishes on restart, and a lease stops two processes signing with one key.
- **Private orderflow.** Sent through a revert-protected relay
  (`SPDEX_KEEPER_SEND_URL`), a batch carries `minRewards`, so a partial race
  cannot land it at a loss and a lost one costs nothing. Without one, the
  keeper warns at start, sends `minRewards` of 0, and holds each pair's total
  in one batch to 0.1% of the pair's WETH, which bounds the sandwich a public
  batch invites.
- **Distrust.** Only vaults a listed factory vouches for, re-checked on chain
  by the batcher; each attempt capped at 400,000 gas; a vault whose buy burned
  at least half its cap on chain and bought nothing is left alone for a week,
  or until a new batcher.
  Honest failures — another trigger first, the price moved — never hold a
  vault back longer than a window: a refusal it paid for rests ten minutes,
  at most twice a window, and one seen in a simulation costs nothing.
- **Records.** Every decision is a JSONL record: typed fields validated and
  never redacted, free text redacted of the key and every configured URL. A
  heartbeat file feeds Docker's healthcheck, and a watchdog exits a keeper
  whose ticks stop completing.

It signs with `@spdex/chain`'s `signPrepared` and never prints the key.

### In the app

A vault plan is the second way a plan runs, **Set and forget** in the form
(`signer: "vault"`, added in config version 7), and its config entry holds its
vault's address once the vault exists. The chain is that plan's source of
truth. It has no ledger entry and no runner, and no scheduler module sees it.

- **The buy fee on screen.** The form and the card call `keeperReward` the buy
  fee, never a reward, and show it in the chosen currency first when a rate is
  known ("≈ $0.05" or "≈ €0.05", then the ether), with its
  exact share of the buy (`feeShareText`) and the rule that set it: "a fixed
  amount for network fees plus 10% of that, never more than 0.69% of the buy" —
  "fixed", because the network part is a release constant, not the gas price
  of the moment. The fee needs no fee read; only the creation's own network
  fee waits for one. Notes under the choice (`vaultFeeNotes`) say what the fee
  pays for: a buy under about 0.00147 ETH "may be skipped"; one held at the
  ceiling, under about 0.00292 ETH, "depends on low network fees"; and when
  network fees are very low, confirming each buy yourself costs less than the
  vault's fee. That every vault buy rests on keepers sharing transactions is
  true of all of them, so the fee's tip says it and no note does. The other
  way round, for a plan paying with ETH, the wallet choice
  gives one buy's network fee at today's fees the way the vault choice gives
  its buy fee, and when the plan's network fees are high, the warning says
  when a vault would cost the whole plan less, its creation included. The due
  banner gives the buy fee a keeper is paid beside the network fee **Trigger
  now** costs at today's fees (`VAULT_GAS`: a busy pool's buy, not
  `EXECUTE_GAS`, which sizes a limit); when the network fee is more, it says
  so, and **Trigger now** stops being the main button. A buy made through any
  listed batcher reads "triggered in a batch" in the vault's history, rather
  than naming the batcher.

- **Reading.** The card reads terms, progress and totals from the vault in one
  Multicall3 round trip, and history from the vault's own logs, best effort.
  Buys the history could not find are reported as not shown, never guessed. A
  figure that cannot be read is unknown, not zero.
- **Time.** Time is the chain's. A vault judges "due" by the block a buy
  lands in, so start times and countdowns use the chain's time carried
  forward, never `Date.now()` on its own: the pending block's timestamp where
  the endpoint gives one, the latest block's otherwise. Pending first because
  an idle chain's latest block runs behind by however long it has been idle
  (minutes on the local fork), and a start of "latest + 5 minutes" was due the
  moment its vault was mined. Whether a buy can be triggered now is still the
  vault's own answer at the latest block.
- **Someone else's vault.** A plan that arrives in a link and points at
  another wallet's vault is shown read-only.
- **A vault no plan points at.** The config is not where the app's knowledge
  of a vault ends, because the vault never depended on it: a card deleted,
  settings replaced or wiped, or a new browser leaves it holding its budget
  and buying. With a wallet connected where vaults are offered, the app asks
  the factory how many vaults the account has created (`nonces`), and if any,
  asks again at the newest block and reads the factory's `VaultCreated` logs
  by their owner topic, newest first, up to that block, until every vault
  counted is accounted for (`findVaultsByOwner` in `@spdex/vault`). The count
  and the logs describe one block, so a newer vault can't stand in for an
  older one the search didn't reach. The vaults the page already shows — its
  vault plans', read — count too, each once `findVaultNonce` proves by its
  address that it is one of those counted, so a plan's vault is never
  "missing", and a search the plans cover reads no log. It narrows its
  window when an endpoint refuses a range, reads nothing before the first
  block any factory of this repository's can have logged in, and stops after
  40 queries; then the page says how many of the factory's count it can't
  show, and why, since those are known to exist. When the log search comes
  back incomplete, as it does on a service that caps `eth_getLogs`, the app
  also reads the factory's own list (`searchVaultsFromFactoryList`,
  `lib/dca/factoryListSearch.ts`): every listed vault's `owner()`, compared in
  the page, at one block and through Multicall3 only. That is 2 + ⌈N/1000⌉ +
  ⌈N/200⌉ requests for N listed vaults, and fewer once owners are cached, since
  an owner never changes. It has neither the one-year nor the 40-query bound,
  and never calls `nonces(owner)`. It is not a privacy measure: the service
  still sees the address in every balance read, and who owns a vault is public.
  Trust and exits offers the same search as a button ("Find my vaults from the
  factory's list"), and what it finds is listed here too. The search runs
  once per account on each network service (an Engine rebuilt for another
  setting keeps what it found), again on **Look again**, which also reads
  every known vault again, and again by itself, a few times over about
  fifteen minutes, when a search failed or read nothing. A vault plan deleted
  on the page joins the list at once, from its last read. The ones no plan points at are listed under
  "Vaults on chain not in your plans": **Add back to my plans** writes the
  plan the vault's own terms describe (`planFromVault`) with `addDcaPlan`,
  once `vaultClaim` proves the vault the account's on those terms, and **Close
  and withdraw** sends a card's close, checked by `VaultGuard` against that
  plan. Closed, empty ones are one collapsed line.

The four transactions the owner's wallet signs are create (funded in the same
transaction), fund, close and **Trigger now**. The host composes them, and
`VaultGuard` (`packages/guard/src/vault.ts`) checks them, for the reason tips
and scheduled buys are checked: "we wrote it" has never been an exemption.

- **Static checks.** Each call is compared byte for byte with a fresh encoding
  aimed at the factory the app computed, or at the plan's own vault. The Guard
  proves that vault by recomputing its address. A creation whose buy fee is
  above the 0.69% ceiling is refused; a vault that already exists is never
  refused for its fee.
- **Simulated effects.** A creation must produce exactly one `VaultCreated`,
  from the factory, for this account, on these terms, at the predicted address,
  and the vault must hold every wei sent. Funding must arrive as the vault's
  WETH. A close must pay only the account. A trigger must deliver at least the
  floor to the owner and the buy fee to the caller.
- **Its codes.** `VAULT_MALFORMED` and `VAULT_NOT_DELIVERED`.
- **When simulation is unavailable.** A vault transaction that sends ether is
  never signed unchecked, whatever `requireSimulation` says, because ether sent
  to an address with no code yet is simply lost. One that sends none (a close,
  a trigger, an unfunded creation) follows the setting, so an endpoint that
  cannot simulate never keeps an owner from their own money.
- **At the signature.** Each call carries the chain it was checked for: the
  wallet is asked which chain it is on the moment it is asked to send, and the
  id goes with the transaction, so a wallet switched to another network while
  the check ran is refused rather than signing there. **Trigger now** carries
  a gas floor of its own (`KEEPER_MIN_EXECUTE_GAS_LIMIT`, 384,000), because a
  buy estimated on a quiet pool runs out of gas when a trade lands on the pool
  first.
- **Recording a creation.** A plan's vault is written once, from what the
  chain shows: the factory's `VaultCreated` in the receipt, or, when the
  receipt can't be read, the code at the predicted address confirmed by
  `settleCreation`. Never the prediction on its own, which a creation from
  another tab could have moved to the next nonce's address.

The factory's one-time deployment moves nobody's money and does not go through
the Guard. Instead, the app checks that the factory is not already there, that
the listing checks pass right now, and that a call of exactly that transaction
returns the address the app trusts.

### Beta data

The beta's questions — is anyone using vaults, do buys get made, does the fee
pay for them, is the oracle floor right — are answered from the chain and from
a keeper operator's own logs, never from the app, which records nothing about
the people using it (rule 4). `pnpm keeper:report` (`src/report.ts`, run by
`scripts/keeper-report.ts`, or Compose's `report` service) reads, through an
endpoint the operator chooses: the factories' `VaultCreated`; every listed
batcher's `Batch`, `Triggered` and `NotTriggered`; each vault's own events;
block timestamps and batch receipts; and a daily ETH/USD from Chainlink's
aggregator logs. It joins those with the operator's keeper JSONL and state,
and writes CSV tables and a `summary.json` answering twenty questions: buys and
volume, new plans, deposits and value held, fee revenue, gas against revenue,
subsidy against its caps, execution against the oracle, every window's fate,
time into the window, failures, keeper uptime, inclusion and resends, the fee
at send against the target, who triggers, vault lifecycles, oracle health,
whether `MIN_ORACLE_DEPTH` is right, whether the data is complete, whether the
cost model is right, and token tips.

It reads to `finalized` by default, so nothing it reports can be reorganised
away; the same range always gives the same files; it keeps to a request rate
and waits out rate limits; and it records its provenance: the block range and
its hashes, each log file's sha256, the price source, and the endpoint's host,
never its URL. A figure it could not know is empty or null, never zero.
Completeness is checked rather than assumed: every vault's `buyNumber` must run
without gaps, and every batch's `earned` must equal the fees of the buys it
made, and a block range the endpoint would not serve is listed as unknown.

Some things are deliberately unknowable: swaps made in the app as such, forms
abandoned, errors people saw, which frontend created a vault, and who uses the
app. A marker in calldata or an event would answer the fourth, and was
rejected because it would fingerprint people on chain. What people think
comes through channels they choose, such as GitHub issues.

## Collective DCA

"Collective DCA: auto-buy vaults" shows what every vault has done: buys made,
SPX delivered to owners, vaults still buying, owner addresses, ETH spent on
buys and buy fees paid, with the budget still committed and the ETH vaults
still hold. It counts **vault activity only**. A one-time swap or a buy someone
confirms in their own wallet is an ordinary Uniswap trade that carries no
spDEX marker, and none will be added: a marker would publicly label every
address that ever used spDEX. The panel says so under the figures, always
visible, and says that addresses aren't people.

**Host code, not a tracker module** (`packages/vault/src/platform.ts`, with
`apps/web/src/lib/network/platform.ts` and
`components/network/CollectiveDca.tsx`). The broker checks every call's
target against the manifest, and a vault's address exists only once someone
creates it, so no manifest can declare one; the tracker trick of reading a
declared token's `balanceOf` reaches a vault's WETH but not its owner, terms
or progress. And the tracker kind's only method is `scanPools`. So it is host
code, as `keeper-read.ts` and `report.ts` are, under the tracker's rules
anyway: display only, never read by a routing or signing decision, and every
figure unknown rather than zero.

**The reads.** Everything is read at one block, through Multicall3 only, 200
calls to an `eth_call` with a 30,000,000 gas ceiling. One block, because a
vault bought or closed between two batches would otherwise be counted in one
state for one figure and in another for the next. Multicall3 only, because a
network service key restricted to a list of contracts can list Multicall3 but
never a vault made after the key was set up.

1. `eth_blockNumber` gives the block.
2. Each factory in `DEPLOYMENTS` is asked `vaultCount()`. Through Multicall3,
   a factory with no code answers with empty data, which is how "not deployed
   on this network" is told apart from "no vaults yet": the first shows a
   sentence, never a grid of zeros. Mainnet reads that way today.
3. `vaultsPage(offset, 1000)` lists the vaults, 1,000 to a call. Every listed
   vault is one the factory vouches for: the call that set `isVault` also
   appended it.
4. Per vault, `owner()` and `terms()` once per chain for the session (a
   vault's address commits to both), then `buysDone()`, `closed()`,
   `totalOut()` and its WETH balance. `totalRewards()` and `status()` aren't
   read: the first is `buysDone × keeperReward`.

That is 2 + ⌈N/1000⌉ + ⌈6N/200⌉ requests the first time for N vaults (13 at
301) and 2 + ⌈N/1000⌉ + ⌈4N/200⌉ after. Nothing is read until the panel is
opened; a read is kept for 5 minutes per network service, and **Read again**
refreshes it. A read stops at 5,000 vaults and offers the rest, and until
then the totals say "at least". A vault whose calls fail is left out of every
total, which then says "at least", with how many couldn't be read. No request
names the person's address.

The figures are counts of vaults, ETH and SPX, with no money value anywhere,
and the footer names the block and how many requests it took. Once read, the
ticker adds "N vault buys"; it is dropped when unknown.

The same list serves the owner search in Trust and exits and the auto-buy
panel's fallback (`searchVaultsFromFactoryList`, "In the app" above), and the
two share the cache of owners.

### Helping run the network

Under the Collective DCA figures, a connected wallet on the configured chain
can make other people's due vault buys in one transaction and be paid their
buy fees (`components/network/HelpRunNetwork.tsx`, `lib/network/batch.ts`).
It is offered only with private sending: a batch sent publicly is copied by
bots that take the fees first, and the copy's loser still pays its network
fee. Nothing about the person's address is read until they press **See which
buys are due**.

1. **Which are due.** `readDueCandidates(rpc, read, { block })`
   (`packages/vault/src/platform.ts`) reads, for each vault in Collective
   DCA's read that isn't closed, has buys left and holds a buy and its fee,
   the same five things the keeper does (`buysDone`, `lastBuyAt`, `closed`,
   WETH, `quote()`), and the block's time, in one Multicall3 request per 30
   vaults. Due-ness is worked out locally with the keeper's `earliestBuyAt`,
   never `status()`; a vault whose quote is under its floor, or whose price
   pool is too thin to judge it, is left out, as the keeper leaves it. The app doesn't import `keeper-read.ts`: it pulls in the
   keeper's sender and config; `@spdex/vault` re-exports only the keeper's
   pure planning from `keeper-plan.ts`.
2. **Which to make.** The gas price is read once and is the price signed.
   The keeper's own `selectBatch`, as a private send that plans no loss, at
   most 20 vaults, small buys first. Every due vault is listed with its fee,
   and no owner; unticking one asks again.
3. **A test-run from the person's address** (`eth_simulateV1`) at the exact
   gas limit it will be signed with (`batchGasLimit`), since the batcher
   decides by the gas left whether to try each vault. Only the vaults that
   bought stay, and it is run again until every one does; a batch that would
   pass on swept WETH isn't offered.
4. **Only when it pays.** `minRewards` = the test-run's gas × 1.1 × the price,
   rounded up; offered only when the fees earned reach it, and only for as
   much of the batch as the wallet can put up the maximum fee for, keeping
   `GAS_RESERVE_WEI` back.
5. **The Guard.** `Engine.checkVaultBatch(intent)` builds the one call itself
   (`executeBatch(vaults, account, minRewards)` to the factory's batcher, at
   exactly the gas limit and price) and has `VaultGuard` check it: the batch
   path is never signed unverified, and runs through the second opinion when
   one is set. It also refuses (`VAULT_NOT_DELIVERED`) a `minRewards` below
   the gas its own test-run of the call used × the signed price, taking the
   larger of the two services' gas figures when there is a second opinion;
   the price is the main service's. The **Make** button shows only for a
   verified batch, and the check runs again when it is pressed.
6. **Sending.** Through the page's one wallet lock, with `walletSender` and
   `submit`, privately, with no public fallback, signed at the call's exact
   `gas` and `gasPrice` (`SendableCall.gas`/`gasPrice`: no estimate is taken).
   A wallet that can't `eth_signTransaction` is told it can't help.
7. **After.** The result is read from the receipt's `Batch` event, never the
   test-run: buys made, WETH received, the network fee, and each untried
   vault's reason, with a finality badge. The browser's records keep a
   `buy-fees-earned` row, which Your activity, the CSV and the statement show
   as fees received, never as a buy or a sale.

## What adding a module kind actually takes

Worth recording, because it is the honest answer to "is this modular?".

The sandbox turned out to be kind-agnostic from the start: `QuickJSRuntime`
validates that code assigns `globalThis.spdexModule` and declares a compatible
API version, and its `#invoke` takes a method name. Nothing in it knew what a
venue was.

The *host's typed view* was the venue-shaped part. `LoadedModule` hardcoded
`discoverPools`/`quoteBatch`/`buildCalls`, so `MODULE_KINDS` could name
`tokenlist` and `oracle` while no runtime could load either. `tiplist` and then
`tracker` each added an interface, an entry point on each runtime
(`loadRegistry`, `loadTracker`), a shape check and its own copy of the output
parse — about eighty lines the first time, with no change to the broker and
none to the venue path. Three near-identical load paths was the point at which
they started asking to be one, and this document said then that a fourth kind
would be the signal to generalise rather than to add a fourth method.

The scheduler was the fourth, and the seam became a table. `KIND_SPECS`, in
`packages/host/src/runtimes/kinds.ts`, has one row per kind: the name of its
interface for the load error, the methods a module of that kind must define,
and a `bind` that turns a runtime's raw "call this method" into the typed view,
parsing every answer with the kind's schema. Each runtime has one
`loadKind(moduleKind, source, broker)`. `load`, `loadRegistry` and
`loadTracker` survive as one-line delegations with unchanged signatures, and
the parity suite checks that each is equivalent to `loadKind` for its kind.
What the separate methods were protecting survives too: every view is still
precisely typed and, in both runtimes, carries only its own kind's methods —
the sandbox's single view class used to carry all five. Output validation is
now literally the same code whichever runtime ran the module.

Two things the table does not do, on purpose. Method names come only from it,
never from a manifest or a config, because QuickJS calls a method by
interpolating its name into code it evaluates. And the runtimes still check a
module's shape, never its `manifest.kind`: "can this be driven as a scheduler"
is their question, "should it be" is `assertLoadable`'s, asked by the seam that
picks a module for a job. Every seam in the Engine asks it — venue, tip list,
tracker and scheduler — and so does the conformance kit.

So a new kind is now an interface and wire schema in `core`, a view type, a row
in `KIND_SPECS`, a row in the conformance kit's `EXERCISES` (its type demands
one for every loadable kind, so a kind cannot become loadable without the kit
learning to check it), and an entry in `IMPLEMENTED_MODULE_KINDS`. That makes
the kind loadable. Using it still takes app wiring the table does not cover: a
`BUILTIN_*` list of shipped modules in `apps/web/src/lib/engine.ts`, and an
Engine method that picks one, runs `assertLoadable`, loads it in the runtime
`strictSandbox` chooses and calls it — `dueBuys` is the scheduler's. `tokenlist`,
`oracle` and `submitter` are admitted and still have no runtime path.

## The config is the application

`SpdexConfig` is one serialisable value holding the whole of the app's
behaviour. A shipped preset is where it starts; the Features dialog, the
Recurring tab and the Expert view all edit that one value; the diff view
compares it with the preset. A beginner and a cypherpunk run
identical code with different values — there is no simplified path that quietly
behaves differently from the real one.

It is versioned from the first commit because it is the user's property: they
export it as TOML, share it as a URL fragment, pin it to IPFS. A config written
by an older build must still open. Migrations live in `packages/config`.

It is at version 9. The step from 5 added `dca`, switched off and with no plans
— a config written before plans existed was buying nothing on a timer, and a
migration that started spending on one would be indefensible however sensible
the plan — and deliberately no scheduler module entry, so an untouched config
still compares equal to the preset. The module arrives with the feature, when
the user turns auto-buy on.

The step from 6 to 7 changes nothing in the config. Version 7 lets a plan name
a third signer, `"vault"`, and hold its vault's address, and every v6 config is
already a valid v7 one. The version moves anyway, for the builds that came
before it. A v6 build handed a vault plan now refuses the config as newer than
it understands, instead of rejecting it as a broken file. That matters because
the obvious repair for a "broken" plan, turning it into one a tab runs, would
have the tab buy on top of the vault, and every buy would happen twice.

The step from 7 to 8 removes the third signer, `autopilot`. Every plan that
named it becomes a wallet plan with the same id and terms, and is paused
whatever it was. A wallet plan, because that is the one a migration can make:
a vault plan pays with ether only and is a contract to be created and funded
on chain, which a migration cannot do and should not decide to. The same id,
so this browser's record of what the plan bought and committed carries on,
and a resumed plan goes on where it stopped rather than starting its budget
again. Paused, because running it would change behaviour nobody asked to
change: an autopilot plan bought from money already moved into its spending
wallet, and a running wallet plan would ask the owner's wallet to pay for
each buy. Resume states the terms again and binds the plan to the connected
wallet, keeping its buys, what it spent and its windows. A config or link
written as version 6 or 7 still opens, through the chain of migrations; the
schema and `ScheduledBuyGuard` both refuse `autopilot` as a signer. The
spending wallet is not config and is not migrated, and the app no longer
reads it.

The step from 8 to 9 adds `guard.secondOpinion`, as `{ url: null }` (no
second opinion) when it is absent, and changes nothing else. It moves the
version for the reason 6 → 7 did, the other way round: zod drops keys it
doesn't know, so a v8 build handed a v9 config would open it and quietly
drop a check the person switched on. A v8 build refuses it as newer instead.
An older tab still open when a newer one saves is the same case in one
browser: the newer tab never adopts an older version's save, writes its own
config back once, and says so (`watchConfigFromOtherTabs`).

## The page

`apps/web/src/App.tsx` lays the page out the way spx6900.com's main menu is
laid out: a masthead, a status panel, and a column of at most eight **tiles**,
each a chip, a title and a one-line summary. What a tile holds and when it
exists is `apps/web/src/lib/tiles.ts` (`TILE_ORDER`, `TILES`); the primitives
are `TileGroup` and `Tile` in `packages/ui`.

- **One tile open at a time, and one on load.** Which one is open is state in
  `App`, never stored and never in the URL (a `#tile=` would collide with
  `#receipt=` and settings links). On load it is a pending `#receipt=` link's
  tile, else Welcome while it shows, else Buy SPX (`initialOpen`): a column of
  closed headers read as far too small a page on a desktop. Hiding Welcome
  opens Buy SPX in its place. Nothing else opens by itself, a due buy
  included. Closed tiles stay mounted,
  so the auto-buy runner, balances and a wallet prompt in progress carry on.
- **The keyboard.** ↑/↓, Home and End move between tile headers, ↵ toggles one,
  Esc closes the innermost open fold and then the tile. Arrow keys are never
  page-global. No key, shortcut, `reveal` or `GoTo` ever focuses a control that
  asks the wallet or changes money or settings (`MONEY_CONTROLS` in
  `lib/tiles.ts`): focus goes to the prompt around it instead.
- **Places.** Copy that sends someone somewhere names the place by its label
  (`PLACES` in `lib/places.tsx`, "Settings → Network service") and ends with a
  `GoTo`, which opens the tile, unfolds the section, switches to the Expert view
  first if the place is only there, and can show "← Back to …" to return.
  `apps/web/src/copy.test.ts` refuses "Expert → …" in the copy.
- **Settings** is one tile: the view and features rows, then exclusive sections
  (currency, network service, tips, check this build, and in the Expert view
  markets, router, sending, safety and the settings file).
- **The status panel** (`components/shell/StatusWidget.tsx`) shows the network
  service's state, the chain, the latest block and the time it was read, and
  the wallet. It reads the block through `lib/chainHead.ts` only when the page
  loads with a service chosen, when the service changes, when the browser comes
  back online, and when the person presses ↻: **it never polls**, so an open
  tab doesn't bill the service or tell it the tab is open. A failed read is
  "unknown", never 0. The service's address is **masked** here, in Settings and
  in error messages (`lib/rpcDisplay.ts`: userinfo, path and query removed, long
  or key-like host labels cut), because such URLs often carry an API key and
  screenshots travel; **Show** reveals it until the panel closes.
- **The disclaimer** (`components/shell/DisclaimerGate.tsx`, text in
  `lib/disclaimer.ts`) is shown on a first visit and again whenever
  `DISCLAIMER_VERSION` changes, before anything else, with the page behind it
  inert. It informs; it is not a clickwrap agreement. Any key but scrolling and
  modifier keys, a click outside the text, or **Continue** closes it, and only
  once it has been up for 400 ms. After it closes, the page stays inert for
  500 ms more (`ARM_AFTER_MS`), and a settings link's **Apply** stays disabled
  for 500 ms after it can take input, so a double press can't close the gate
  and apply a link. Every sentence in it names its source in the
  code beside it, to be checked again whenever a signing path changes. **No
  lawyer has reviewed this text**: the community prototype is published
  without that review, a risk its publisher accepted, and the source says so
  in a `NOT REVIEWED BY A LAWYER` note. A release beyond the prototype should
  have a lawyer read it first. The footer's **Disclaimer**
  link shows it again.
- **Display settings** (`components/shell/DisplayDock.tsx`): colour mode, text
  size (A, A+, A++; A+ by default), motion and contrast, kept per browser in
  `spdex.a11y.v2` (only what differs from the default; motion and contrast
  carried over once from v1, never its size) and applied before first paint
  by `lib/theme-boot.ts`. AUTO follows the system, and a manual choice can
  only add accessibility, never remove it. Every font size in the stylesheets
  is in rem (`css.test.ts`), and the page layout's breakpoints are the same at
  every text size, with its columns in rem: a size changes how big things
  are, never where they are, so the dock stays pinned bottom-left from 90em
  whatever the size.
- **Art.** The stickers and the line drawing under the footer are inline SVG
  components (`components/shell/art/`): no file, no request (checked by
  `no-requests.test.ts`, which also holds each art file under 3,072 bytes).
  Every sticker carries a "spDEX · community" tab, and none copies
  spx6900.com's artwork or text. The backdrop is a picture: one pale
  illustration filling the window behind the page where it has three columns
  (85em), the stickers and tiles over it, as spx6900.com's page sits on its
  own. On the left, travellers carry an SPX banner on a crystal cliff. On the
  right, the SPX coin is sealed inside a clear crystal octahedron for Ethereum
  (the model's crystal, never the Ethereum logo glyph). Between them, behind
  the centre column, are quiet sky and plain. It was generated locally with
  Krea 2 Turbo. The coin was composited from SPX6900's logo file, used as the
  community uses it (the one exception to R8, below), and the whole graded to
  near-monochrome; how it was made is in
  `apps/web/src/assets/backdrop/README.md`, beside the two files.
  `components/shell/art/Backdrop.tsx` is one empty element, and
  `packages/ui/src/theme.css` fixes it behind the page (z-index -1, under the
  stickers) with the paper's halftone over it. `apps/web/src/backdrop.css`
  names the picture only from 85em, which no phone reaches held either way,
  and never on an iPhone or iPad (whose Safari can't fix a background to the
  window, so the masthead's piece of it wouldn't line up): the AVIF (70 KB)
  where the browser can choose by `type()`, the WebP (109 KB) elsewhere. In
  one column there are no rails for it, and the page is the plain paper. It
  also places the picture from the layout's own measures (the centre
  column's edge, the rails' minimum, the widget's height, in rem and vw), so
  at every window and text size the banner's print sits 16px in from the
  window's left edge and the crystal's coin just right of the centre column,
  under the widget. The stickers keep to each rail's right-hand side to leave
  those two places free. Windows of 3:2 and squarer are the exception: there
  the coin stays clear and the print is cut by the window's edge, and under
  about 700px tall the pinned dock can cover the print. `e2e/shell.spec.ts`
  checks a sample of sizes at each text size. The sticky masthead and the
  gap above the pinned widget lay the same picture fixed to the window, so
  the stickers scroll under them with no paper box over the art. The line
  map under the footer goes where the picture shows, and in PASTEL the stamp
  prints on a white ground of its own. All of it goes under high contrast,
  forced colours and print, where nothing names the picture either.
- **Fonts.** Orbitron (variable), Space Mono Regular and Bold and Bebas Neue ship
  in `apps/web/src/assets/fonts/`, each beside its SIL Open Font License, loaded
  by `apps/web/src/fonts.css` from the app's own origin with
  `font-display: swap` (297,564 bytes of TTF in the build). Inter is not
  bundled; body text keeps the system UI stack. The "I bought" card's PNG
  embeds the same files, read back from the same origin when it is made.
- **Words.** spDEX never calls itself a trading tool: the SPX motto is "STOP
  TRADING AND BELIEVE IN SOMETHING". The tile that swaps and sets up auto-buys is
  chip BELIEVE, title **Buy SPX**, and the copy says "buy" and "swap".
  `copy.test.ts` and `e2e/shell.spec.ts` fail on the word anywhere a person can
  read it, except the motto quoted as a saying.

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
  only after that long (`useArmed`). `MONEY_CONTROLS` in `lib/tiles.ts` is
  the list. It includes Swap, Start, a vault's create, fund, close and
  trigger, Confirm buy, Tip this address, Send publicly, Apply
  these settings, Remove and continue, turning
  auto-buy on, choosing or saving a network service, every button that opens
  the wallet, and anything marked `data-money-control`. Focus goes to the
  prompt around the control instead (its container, `tabIndex={-1}`, named by
  its title) or to its Cancel. `tiles.test.ts` and `e2e/shell.spec.ts` check
  it.
- **R3 · Checkable text.** Every sentence of the disclaimer, and every
  factual claim in the footer, the stickers and the rest of the copy, can be
  checked against the code. The disclaimer's sources are listed beside its
  text in `lib/disclaimer.ts`. Check them again whenever a signing path
  changes.
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
  that anyone can make a vault's due buys and nobody has to; that only
  closing a vault stops it; who a buy fee is paid to; that missed buy times
  are skipped and the plan ends later; that a plan you confirm needs spDEX
  open; that a Permit2 permission is unlimited until revoked; that a later
  part of a split route can fail after an earlier one went through; every
  Guard refusal. Costs come before every choice, as one line of figures. A
  figure worked out from a limit says "up to", an estimate says "≈", and one
  spDEX doesn't know says "unknown", never 0.
- **R7 · No "trade".** Copy never calls spDEX a trading tool, because the SPX
  motto is "STOP TRADING AND BELIEVE IN SOMETHING" (see Words above). The
  motto itself, quoted as a saying and attributed to the community, is the
  one exception.
- **R8 · Original, and no claim to standing.** No wording or artwork is
  copied from spx6900.com. A community saying is quoted as it stands,
  attributed and linked, and called a saying, never a commandment. spDEX
  never calls itself, the token or anyone "official" or "unofficial":
  SPX6900 has no official team, so neither word measures anything, and
  "community project" says what spDEX is. The disclaimer's "On an official
  release" (`OFFICIAL_RELEASE` in `lib/disclaimer.ts`) is the one use of the
  word: a copy at the address its publisher released it for, never a claim
  about SPX6900; `copy.test.ts` and `e2e/shell.spec.ts` take out exactly that
  and still refuse the word anywhere else. One exception to the rest, and only
  one: the SPX6900 logo, the community's mark, is the coin in the backdrop
  picture (sealed in the crystal, printed on the lead banner), composited
  from the logo file and used as the community uses it, to say what the page
  is for. It is never spDEX's own mark, never a claim to speak for
  SPX6900, and not under the repository's licence (README, License).

## What there is deliberately none of

- **No backend.** A static bundle. A feature that seems to need a server needs a
  module or a different design. Auto-buy is the example twice over. A plan
  the owner confirms runs in the tab and says plainly that it stops when the
  tab does. A vault plan runs with no tab, and still no server: a contract
  enforces the plan, and whoever wants the buy fee sends the transaction. A
  keeper is software anyone may run against a public contract, not a service
  the app depends on or contacts.
- **No telemetry, analytics, or error reporting.** Not behind a flag. Every
  request the app makes goes to the network service in use — the built-in
  one the disclaimer names, used by default only at its publisher's origin,
  or one the person chose — or the relay the person chose, or the second
  opinion they typed. The
  mechanical check is partial: `apps/web/src/no-requests.test.ts`, in `unit`,
  fails on any `fetch(`, `XMLHttpRequest`, `WebSocket(`, `EventSource(`,
  `sendBeacon` or `new Image(` in the app's and the host packages' source
  beyond a short list allowed per file, and on a notification that would
  fetch an icon. It can't see a request made another way, the `lint` stage
  runs nothing, and the CSP leaves `connect-src` open so users can choose any
  endpoint, so review keeps the rest. The same rule is why Collective DCA
  counts vaults only: nothing marks a swap as spDEX's.
- **No wallet-connection library.** The app needs four EIP-1193 methods. A
  connector framework would add a large dependency, another view of chain state
  nobody chose, and a relay that watches sessions.
- **No price chart, and no value of anyone's holdings.** Your stack shows what
  you hold and what you put in, never what it is worth; there is no price
  history and no average cost. THERE IS NO CHART, as the community says,
  and a chart with one point on it is still a chart.
- **No remote font.** A font from another origin breaks the CSP and tells a
  third party every time the page opens. The display faces ship with the app
  instead, as its own assets (see "The page" above); body text keeps the
  system's UI font.
- **No contract anyone controls.** Swaps, tips and tab-run auto-buys go
  through no contract of spDEX's, which is why a split route cannot be atomic
  (see `docs/THREAT-MODEL.md`). The contracts spDEX does ship, the auto-buy
  vault, its factory and the batcher, have no owner, admin, upgrade, pause or
  fee, and a new market list means a new factory, never an edit. What changed,
  and what that does and does not buy, is under "No contract anyone controls"
  above. They are unaudited, which is why each vault is capped at 0.5 ETH.

## Upgradeability

Two mechanisms, and they pull in opposite directions on purpose.

**The capability broker is additive-only.** Capabilities may be added; an
existing signature may never change. A module written against a v1 host must
still load on a v3 one, because the people running old pinned CIDs are exactly
the people the sovereignty pitch is aimed at.

**Module kinds are declared ahead of implementation.** `MODULE_KINDS` lists
nine: `venue`, `tokenlist`, `tiplist`, `oracle`, `submitter`, `panel`,
`policy`, `tracker` and `scheduler`. `IMPLEMENTED_MODULE_KINDS` admits all but
`panel` and `policy`, which stay reserved. Four of the admitted kinds have a
shipped module and a runtime path both runtimes exercise — `venue`, `tiplist`,
`tracker` and `scheduler`, the rows of `KIND_SPECS` — while `tokenlist`,
`oracle` and `submitter` have neither yet; the Guard's oracle cross-check is
host-side rather than a module. Declaring kinds up front means adding one later
fills in a branch the type system already knows about, rather than widening a
contract every existing module must be re-checked against. `assertLoadable`
refuses a module whose manifest declares a kind other than the one asked for,
a kind the host does not implement, or one no runtime can load, with a
readable message rather than by loading it half-way. Every Engine seam and the
conformance kit call it.

The config is versioned on the same logic: a config exported by an older build
must still open, so `packages/config` carries migrations rather than a schema
that quietly changes meaning.

**The vault contracts are the exception: they cannot be upgraded at all,** and
that is the point of them. A bug fix, a new limit or a new market means a new
factory at a new address, a release whose generated artifacts point at it,
and a new entry in `deployments.json` beside the old ones, never in their
place. A batcher with a bug is replaced the same way, by new code or a new
salt, in an entry naming the same factory; vaults are unaffected, since the
batcher has no rights over them. Vaults already created keep the code they
were created with, keepers go on serving them through their own release's
batcher, and closing one needs only its owner's wallet calling `close()`. The
vault pays the owner itself; this app is not in that path.

## Determinism

Integration tests fork mainnet at a pinned block, and `scripts/anvil-fork.mjs`
asserts the fork produced the expected block *hash* at that height. Never change
the pin to `latest`, and never bump it to make a test pass — a drifting block
silently invalidates every quote assertion in the repo.

The vault's forge tests pin the same block as a constant
(`packages/vault/test/forge/utils/Fork.sol`) and fork it themselves from the
archive endpoint, never from the shared local fork. That lets them move time
freely with `vm.warp`, which stays inside the test's own EVM. No test moves the
shared fork's clock: a test that needs a second buy window leaves it to forge.

Modules must not read a clock or randomness, so that identical inputs produce
byte-identical output. The sandbox has neither; natively they exist, and a
module relying on them fails in QuickJS and in the conformance kit. The kit's
determinism check repeats each kind's characteristic call, which for a venue is
`discoverPools` rather than `buildCalls`, so it does not by itself show that a
venue builds identical plans.

## Further reading

- `docs/THREAT-MODEL.md` — what the Guard defends against, and what it does not
- `docs/WRITING-MODULES.md` — the module interface
- `docs/IPFS-RELEASE.md` — reproducible builds and publishing
- `docs/RELEASE.md` — the release checklist, and deploying the contracts
- `docs/WALKAWAY.md` — checking a copy of spDEX, and doing without it
- `AGENTS.md` — the verify gate, and what each stage proves
