# spDEX

**A swap interface you assemble yourself.** A community project for SPX6900
holders who would rather verify than trust.

spDEX is not a fork of anyone's frontend. It is a small, auditable **host** that
owns the four things that matter — your signer, your RPC, your storage, your
screen — and treats everything else as a **module you choose**: which venues,
which individual pools, which token lists, how your transaction reaches the
chain. Pick them yourself, or take the recommended preset and swap in one click.

- **No contract anyone controls, no admin key, no protocol fee, no governance
  token.** spDEX routes across pools that already exist. Its optional
  contracts — the auto-buy vault, its factory, the batcher keepers use to
  trigger many vaults at once, and from v2 the SPX holder registry — have no
  owner, no upgrade and no fee, so nobody (us included) can change a vault or
  take what is in it. There is nothing here to rug. They are unaudited,
  though; see below.
- **A vault plan pays a fixed buy fee** for each buy it makes, to whoever
  makes the buy or the address they name. For a plan made from v2 on, it is
  a fixed amount for network fees plus 0.25% of the buy, never more than
  0.69% of the buy, network cost included; a v1 plan keeps the fee it was
  made with (the fixed amount plus 10% of that). The 0.69% is in the
  contract: no vault can be created that pays more, so nobody who makes buys,
  spDEX's developers included, ever makes more than that on one. No contract
  takes it. spDEX's developers may run a keeper that collects this fee on the
  buys it makes, as a community keeper like any other, with no special
  treatment; nothing obliges them, or anyone, to make any buy. A swap you
  send yourself pays spDEX nothing.
- **SPX holders first.** For the first minutes after each buy of a v2 vault
  falls due, its fee can be paid only to an SPX holder who makes the buy, or
  back to you; after that, anyone may make it. Community keepers make other
  people's buys and are paid for each one; holding 690 SPX is the entry bar.
  The SPX stays in the holder's wallet: nothing is deposited or locked, and
  nobody keeps a list. See "v2: SPX holders first" below.
- **No backend, no telemetry, ever.** A static bundle you can pin to IPFS and
  serve yourself. Bring your own RPC.
- **Pool-level control.** Not "use Uniswap" — *use the SPX/WETH 1% pool and
  nothing else*, if that is what you want.
- **Anyone can write a module**, and that is safe because the host simulates
  what a module proposes and refuses to sign anything that doesn't match what
  you were shown.
- **A second opinion, if you want one.** Add a second network service, run by
  someone else, in Settings → Safety, and every transaction is test-run on both,
  on the same block, and compared. If they disagree, spDEX won't let you sign.
  If the second doesn't answer, a one-time swap says "Checked on one service",
  an auto-buy you confirm is skipped, and a vault transaction that sends ether
  or a Permit2 permission waits until both agree.
- **Swap native ETH**, in or out, in one transaction. There are no native pools
  in Uniswap v2 or v3 — every "ETH" pool is WETH — so spDEX uses the routers'
  wrapping entry points rather than making you wrap first.
- **See what is in each pool.** TVL, fee tier, recent volume and each pool's
  share of the pair — read by a sandboxed tracker that declares three token
  contracts and never touches a transaction. On by default.
- **Features you opt into.** Which venues, whether to send privately, whether
  to sandbox spDEX's own modules too, whether to tip, whether to auto-buy —
  chosen in a dialog on first run, each one stating what it costs. Most are a
  module; the dialog says which.
- **Tip splits.** Send a small share of each swap to people you pick: from the
  list spDEX ships (spDEX's own donation vault, named by the source itself,
  and each person listed with a link to their own post of the address), or
  from **My tip list**, addresses you save by address or ENS name, kept in this
  browser only and exportable as a file. Every address is shown in full and
  checked before it is saved (checksum, lookalikes, contracts), and the first
  tip to a new one asks you to check it. Computed from what the swap actually
  delivered, capped at 5% by the host, and every transfer checked by the Guard
  like any other. One person is
  one transfer. Two or more are paid in one transaction through Uniswap's
  Permit2, after one signature and, the first time, a standing permission for
  Permit2 on that token, which Settings → Tips can revoke. The signature comes
  first, so a wallet that can't sign one is never asked for the permission.
  The Guard checks both before your wallet is asked, as it checks every
  transaction.
- **Auto-buy.** Set a plan once in the Recurring tab — what to buy, what to
  pay with, how much, how often, how many times — and each buy is made when
  it falls due: dollar-cost averaging, with a total you know before it
  starts. Two ways to run it:
  - **Confirm each buy myself.** Your own wallet, which never opens by
    itself: a due buy waits on its plan's card until you click **Confirm
    buy**, so you need to be there, with spDEX open.
  - **Set and forget** — a vault, no tab needed: it buys when triggered, with or without
    spDEX open. It is a small contract you create for one plan. It holds the
    plan's budget and makes each buy itself, whoever triggers it. For the
    first minutes after each buy falls due (its community window: 30 minutes
    by default, or a quarter of the time between buys when that is shorter), the buy fee
    can go only to an SPX holder who makes the buy, or back to you; after
    that, anyone may make it and be paid its buy fee: a keeper bot, an open
    spDEX tab, or a keeper you run yourself (`docs/KEEPER.md`, with Docker).
    None is guaranteed to, and a buy time nobody triggers is skipped. It buys SPX
    only, paid with ETH, and refuses any buy whose price is more than your
    allowance (1%, 2% or 3%) worse than Uniswap v3's 10-minute average, or
    than the pool's price now if that is better for you. It is
    **unaudited**, you can put at most 0.5 ETH into one, and only you can
    withdraw.

  A plan you confirm is quoted fresh at each buy, on one market, and checked
  by the Guard against the plan you wrote, and a buy that cannot be checked
  is not made. A vault checks its own buys, on chain. Each plan's card shows
  how far it has got, what it has bought and at what average rate, and every
  buy with its transaction. A buy time nobody acts on is skipped rather than
  made up, and scheduled buys never tip. `docs/TRY-IT.md` walks through both
  on a local fork.
- **Type amounts in money.** Dollars or one of 16 other currencies, in the
  number style you write (`0,5` is half an ether where the decimal mark is a
  comma). Money is only how you type: the field shows the token amount it
  comes to at once, and that token amount is what is quoted, saved and
  signed. Dollars use spDEX's 10-minute average price; other currencies use
  Chainlink's rate against the dollar, read on Ethereum through your network
  service, in one request that is the same whichever currency you chose. A
  mark that doesn't fit your number style is refused with a one-tap fix,
  never read as something else.
- **Your records, kept here.** Your activity lists the swaps and tips made in
  this browser, the plan buys you confirmed, and your vaults' buys from the
  chain, each with what arrived as the chain measured it and what the sold
  side was worth then where spDEX knew. Download it as a CSV or print a
  statement; nothing is uploaded. A swap's result shows **Sent → Included →
  Final** as your network service reports the block.
- **Reminders without a server.** A plan you confirm can go into your own
  calendar as a file, and an open tab can notify you when a buy is due. No
  push service, no account.
- **Welcome, new aeon.** Four steps for someone new to SPX6900 — a wallet, ETH
  on Ethereum, the contract to check, a first buy of $6.90, $69 or $690. It is
  open when the page loads. What spDEX is, a community project, is said under
  the wordmark, in the footer and in the disclaimer.
- **Your stack.** The SPX in your wallet, what spDEX has stacked for you and
  what you put in, and a goal counted in SPX. No price, no chart, and never
  what it is worth.
- **An "I bought" card** of a buy, saved as a PNG, with its transaction hash
  and a `#receipt=` link. Whoever opens that link sees what the chain says the
  transaction did, read through their own network service rather than taken
  from the card.
- **Collective DCA.** What every auto-buy vault has done — buys, SPX
  delivered, vaults still buying, ETH spent — read from both releases'
  factory lists at one block when you open the panel, v1 and v2 counted
  together, with the share of v2 buys paid to community keepers inside
  their community windows.
- **Help run the network.** A panel of its own at the foot of the page: make
  the v2 vault buys that are due right now from your own wallet, in one
  transaction, and be paid their buy fees. Offered only with private sending,
  and only when the fees cover the network fee at the price your wallet
  signs; the Guard checks the batch before your wallet is asked. A buy still
  inside its community window is offered only to a wallet that is a
  community keeper. Its **Community keeping** fold says whether yours is,
  and for an ordinary account holding 690 SPX, **Prove my SPX** makes it
  one: a single transaction, once every 30 days.
- **Trust and exits** (Settings → Check this build). How to check the copy you
  are running, and how to do without spDEX: close a vault from any wallet, find
  your vaults from the factories' lists, run a keeper, keep your settings and
  records. `docs/WALKAWAY.md` says the same.
- **A page of tiles, and display settings.** The page is a short column of
  tiles, one open at a time, like spx6900.com's main menu, with a disclaimer on
  a first visit and a status panel that reads the latest block only when asked
  (never on a timer). **Aa Display** holds the two colour modes spx6900.com has,
  NEON and PASTEL, and text size, motion and contrast. Those choices stay in
  this browser rather than in the config: a display preference has no business
  in a diff or a shared link. The display faces ship with the app, from its
  own origin (`docs/DEVELOPMENT.md`).

## Don't trust — verify

The security model is not "we vet module authors." It is that **nothing reaches
your signer until the host proves the outcome matches your intent:**

```
module proposes a transaction
   ↓
STATIC    targets declared in the module's manifest?
          approval bounded?
   ↓
SIMULATE  run it against chain state before you sign
          ├─ you receive at least minOut, measured at your address
          ├─ you spend at most maxIn
          ├─ nothing else leaves your wallet
          └─ no approval to anyone undeclared
   ↓
ORACLE    independent price check — Uniswap's own time-weighted
          average, read from the endpoint you already chose.
          Warns; never refuses. See below.
   ↓
you sign — or spDEX refuses and names the invariant that failed
```

A module that lies fails simulation regardless of what it claimed. This is why
handing a stranger's module to a first-time user is defensible.

The oracle layer is deliberately weaker than the two above it. It compares the
price you would actually execute at against a time-weighted market price, and
raises a **warning** — it cannot block a swap. Two reasons: an executed price is
net of pool fees and your own price impact, so a large trade in a high-fee pool
diverges legitimately; and an oracle that can refuse transactions is an oracle
worth attacking into refusing them.

That claim is a test suite, not a promise: `pnpm verify` runs a red-team suite
of deliberately malicious modules the Guard must block. You can run it yourself.
The vault's rules are tests too: forge tests on a fork of mainnet, in the same
gate, including the attacks its security reviews tried. So are the SPX holder
registry's: real proofs recorded from mainnet must prove, and false, altered
and fuzzed ones must not.

## v2: SPX holders first

v2 is the second release of the auto-buy contracts. It is built and tested,
and `packages/vault/deployments.json` records the addresses this build
deploys to; until those are deployed on Ethereum, v1's are the only ones
live. v1 stays live and unchanged for good: its vaults, factory and batcher
keep working as they always have, and the app goes on showing, funding,
triggering and closing them. There is no move from v1 to v2; new plans are
made on the latest release. `docs/V2_UPGRADE.md` is the design.

What a v2 vault does differently:

- **A community window on every buy.** For the first minutes after a buy
  falls due — 30 by default, a quarter of the time between buys for plans
  that buy more often than every two hours, never under a minute or over an
  hour — its fee can be paid only to an SPX holder who makes the buy, or back
  to you. After that, anyone can make it, as with v1. The window is fixed
  when the plan is made; in Expert you can choose it.
- **Community keepers.** Community keepers make other people's buys and are
  paid for each one; holding 690 SPX is the entry bar. An address qualifies
  while it held at least 690 SPX at the end of a block in the last 30 days,
  proven from Ethereum's own records (a proof lasts 30 days, and anyone may
  send one), and holds that much at the moment of the buy. It must be an ordinary account,
  not a contract wallet. Nothing
  is deposited or locked, the SPX stays in the holder's wallet, and there is
  no list and no admin. A proof is one transaction of about 655,000 to
  685,000 gas, about 0.00007 ETH at 0.1 gwei. The **Community keeping** fold
  under Help run the network builds and sends it in the browser; a keeper
  you run can do it for you (`docs/KEEPER.md`, "Becoming a community
  keeper").
- **Trigger now** works on a due buy inside its window too, and pays the
  fee back to you.
- **The buy fee** for new plans is a fixed amount for network fees plus
  0.25% of the buy, never more than 0.69% of it. At ETH at $2,643.94 that is
  $0.0345 on a $5 buy (the 0.69% ceiling), $0.22 on $69 (0.33%) and $1.77
  on $690 (0.26%), where v1's default was about $0.053 on any buy from $7.71
  up.
- **Built to change without new contracts.** Nothing deployed can ever be
  changed, so v2 ships what is most likely to be wanted next, unused: turns
  among holders, which give each holder first claim on its share of buys
  rather than letting the fastest win, if one keeper ever wins most of them
  (`docs/V2_UPGRADE.md`, decisions 29 and 35). The batcher is bound to no
  factory, so later releases share it, and the app and the keeper treat
  releases as data, so a release with another market list is one line in
  `deployments.json`. `docs/ARCHITECTURE.md`, "Upgradeability", says what
  still needs new contracts.

## Quick start

```bash
pnpm install
pnpm verify        # the gate; fork stages skip until the two steps below (see AGENTS.md)

# A local mainnet fork, pinned to a known block. Needs Foundry and an archive
# endpoint (docs/DEVELOPMENT.md): Alchemy's free tier works.
echo 'SPDEX_FORK_RPC_URL=https://<an archive endpoint>' >> .env.local
pnpm anvil:fork             # terminal 1
pnpm dev:web                # terminal 2: http://localhost:5173
pnpm dev:fund 0xYourAddress # play money on the fork
```

`docs/TRY-IT.md` walks through it, wallet setup included.

To run a keeper — the bot that makes due vault buys and is paid their buy
fees — see `docs/KEEPER.md`: five steps with Docker, what it costs to run,
and how to become a community keeper.

Feedback goes to GitHub issues on spDEX's repository: a bug report or an
idea, each a short form (`.github/ISSUE_TEMPLATE/`). The app records nothing
about the people who use it, so an issue you choose to write is the only way
we hear what worked and what didn't. A release can link the form from its
footer (`VITE_SPDEX_FEEDBACK_URL`). To change the code, start with
`CONTRIBUTING.md`; security problems go to `docs/SECURITY.md`, never a public
issue.

## Status

Early — a working prototype. Ethereum mainnet only, Uniswap v2 and v3. The
module boundary is designed so chains, venues, trackers and schedulers are
additive rather than rewrites. The scheduler was the fourth module kind, and
the point at which the host's load path became one table instead of growing a
fourth hand-written method; `docs/ARCHITECTURE.md` says what that did and did
not cost.

Known limits, stated rather than buried — `docs/THREAT-MODEL.md` has the
reasoning for each:

- **A split route is not atomic.** spDEX's swaps go through no contract of its
  own, so a multi-leg route is several transactions. Each leg is checked
  against its own minimum, so no leg can underpay you, but a later one can
  revert while earlier ones have executed. The app says so on any route with more than one leg.
- **The token list is three hardcoded tokens, plus native ether.** A list is a
  trust decision — it decides which contract the word "USDC" points at — so it
  belongs to the user. The `tokenlist` module kind exists for that; until it ships, three
  entries whose decimals were read on-chain beats three hundred nobody checked.
- **Volume depends on your endpoint.** Hosted RPCs cap log queries hard — some
  free tiers at ten blocks — so spDEX narrows the window until one is accepted
  and labels the column with the period it actually covers, or says volume is
  unavailable. TVL and fees are unaffected; they come from chain reads. Running
  your own node removes the limit.
- **Tips are extra wallet prompts.** After the swap, one transfer for one
  person; for two or more, one signature and one transaction through Permit2,
  with a standing permission for Permit2 between them the first time. Decline
  that permission and the signature goes unused (it expires in 20 minutes)
  and the tips go as one transfer each. That permission is unlimited, which
  is Permit2's convention, and stands until you revoke it. While it does,
  Permit2 moves that token on a signature or a Permit2 approval you give, and
  spDEX checks only the ones it asks for, so a Permit2 request for that token
  is worth reading as closely as a transaction, from any site that asks.
  Revoking does not erase approvals other sites set up inside Permit2; they
  work again if the permission is given again.
  Batching saves prompts and waiting, not always gas: on the fork, two people
  cost about 159,000 gas in one transaction against 150,000 as two transfers,
  and five cost 275,000 against 375,000. It needs Ethereum's Permit2, so on
  any other chain tips go as one transfer each. The list spDEX ships holds
  spDEX's own donation vault, never chosen for you; its maintainer adds people
  who agree, each with a public post of the address
  (`modules/tiplist-spx-community/module.js` says how); the test
  addresses the fork specs tip are offered only on a local test network. An
  ENS name is read through your own service, without CCIP-Read, so a name
  kept off chain has to be pasted as an address.
- **Your endpoint operator sees everything you do.** Private sending hides
  you from the mempool, not from your node. Run your own. A second opinion
  sees what you are about to sign too.
- **A second opinion checks test-runs, nothing else.** It catches a service
  lying about what a transaction does. Prices and the Guard's 10-minute price
  check, balances, allowances, which contract sits at an address, vault state
  and fees still come from your main service alone (typed money is the
  exception: when the second service answers, it is sized only from rates
  both agree on to within 1%; when it doesn't, from your main service
  alone). Two
  services run by one operator are one opinion; spDEX warns only when their
  addresses make it obvious. No test-run, on one service or two, catches a
  contract built to behave differently a few seconds later.
- **Helping run the network needs private sending,** and a wallet that can
  sign without broadcasting. Someone may make the same buys first; then yours
  buys nothing, and costs nothing only if your relay drops failing
  transactions. Your address becomes public as the one who made the buys. It
  offers v2 vaults' buys only (v1's are left to keepers and anyone else), and
  a buy still inside its community window only to a community keeper's
  wallet.
- **A plan you confirm yourself runs only while spDEX is open in a tab.**
  There is no server to run it anywhere else. A buy time that passes while no
  tab is open — or while the browser has paused a background one, which
  phones do almost at once — is skipped, never made up in a burst later, and
  the plan ends later instead. What such a plan has bought is recorded in this
  browser; the same plan started on another computer, or here again after
  this browser's record of it was lost, counts from zero.
- **A vault plan runs only while somebody triggers it.** Still no server: a
  buy happens when a keeper bot, an open spDEX tab or a keeper you run sends
  the transaction, for the buy fee. Nobody promises to, and a buy time nobody
  triggers is skipped. On a v2 vault, a buy inside its community window waits
  for a community keeper, or for you; if none makes it, anyone may once the
  window ends, and a window is never longer than an hour. The fee is priced
  for a buy that shares its transaction with others, and never above 0.69%
  of the buy, so on small buys it does not cover a buy made on its own;
  keepers that put many vaults' buys into one transaction, through
  the batcher, pay less per buy, and the form says when a plan's buys are too
  small even for them.
  The vault's record is on chain, so it counts the
  same from any browser. So is the vault itself: with your wallet connected,
  spDEX looks on chain for the vaults you created and lists any your plans
  don't point at (a card deleted, settings lost, a new browser), to close or
  add back. It can look only as far back as your network service lets it, and
  says how many it found when that isn't all of them.
- **The vault is unaudited.** That is why you can put at most 0.5 ETH into one
  (per vault; nothing limits how many one account creates), and why the app
  marks it Unaudited wherever it offers it. v2 is more code than v1 — the
  community window, and the SPX holder registry with its proof verifier
  (Optimism's, vendored unchanged) — and is unaudited too, under the same
  cap. A keeper can choose when a due buy happens and trade around it,
  within your allowance; on a v2 vault it also names who is paid the fee.
  It cannot change where the tokens go or how much is spent. There is no
  pause: closing it, which returns everything to you, is the only stop. It
  buys SPX only, because the factory's list of markets is fixed; another
  list would be another factory.
- **The community window filters past holding, not people.** It favours
  addresses that held 690 SPX at the end of a block in the last 30 days and
  hold it at the moment of the buy. SPX borrowed inside the buy's own
  transaction (Uniswap v4 lends it for no fee) passes that second check, so
  an address can buy 690 SPX, prove it, sell it back and stay eligible for 30
  days. A bot that holds 690 SPX is a community keeper like anyone, and
  inside a window the fastest community keeper wins. At worst a fee goes to
  someone the window was meant to keep out, as any fee could in v1; nothing
  in it reaches a vault's money (`docs/THREAT-MODEL.md`, "The community
  window and the SPX holder registry").
- **Proving is public.** A proof says on chain, for good, that an address
  held at least 690 SPX, and a keeper's buys put the address it is paid at
  beside the key that sent them. Prove a wallet kept for the SPX, not your
  main one. Proving needs a network service that answers `eth_getProof`;
  where yours doesn't, the panel shows the requests to run against another
  service and checks what you paste against your own.
- **A plan you confirm needs you there at every buy time.** Your wallet never
  opens by itself, so a due buy waits for you to confirm it, and one not
  confirmed before its buy time ends is skipped. A vault is the way to buy
  with nobody there.
- **No buy is made on an endpoint that cannot simulate.** Every scheduled buy
  from a tab must be proven by `eth_simulateV1` before it is signed, and on an
  endpoint without it every buy is skipped. spDEX will not create or fund a
  vault through such an endpoint either. The public fallback spDEX offers when it is
  opened somewhere other than its own address is such an endpoint.
- **Money is only how you type an amount.** What a plan saves and each buy
  spends is the token amount, so a plan typed as $20 spends the same ETH
  every time, whatever that is worth then; to spend the same dollars, pay
  with USDC. Typing in money makes the amount you sign depend on your network
  service's answers (the 10-minute average, and Chainlink for currencies other
  than dollars), so the token amount beside it is the thing to check. A price
  read more than 5 minutes ago, or before the tab was last hidden, sizes
  nothing until you press "Use the price now". A currency's rate counts as
  unavailable when it is more than 5 days old or far from where it was at
  release, and then that currency is refused for typing and figures fall back
  to dollars with a note. USDC is counted as exactly $1, with a note when it
  is more than 1% off. INR, HKD, SEK, NOK, PLN and ZAR aren't offered: there
  is no rate for them on Ethereum that spDEX could read without asking a
  third party.
- **Stats count vaults only.** Collective DCA counts auto-buy vaults made by
  spDEX's factories, from any app. One-time swaps and plans you confirm are
  ordinary Uniswap trades with no spDEX marker, so nothing can count them —
  and a marker would label every address that used spDEX. Owners are
  addresses, not people. Where a release's factory isn't deployed (v1's has
  been on Ethereum since block 26,100,366; v2's isn't yet, nor either on any
  other network), the panel says so rather than showing zeros.
- **Your records are this browser's.** One-time swaps and tips are recorded
  from this version on, in this browser only; a cleared browser or another
  computer has none of them, and the app says what it leaves out rather than
  counting it as zero. Vault buys are read from the chain. A value at the
  time is blank where spDEX held no price then; "Fill in values from the
  chain" needs a network service that keeps old state. There is no average
  cost anywhere, and it isn't tax advice.
- **A card or a CSV leads to your address.** A transaction hash lets anyone
  look up everything the address that sent it has done, and the CSV lists the
  address itself. Both say so before you save them.
- **Reminders are a file and a tab.** A calendar file holds a daily or weekly
  plan as one repeating event, or an hourly one's next 48 buy times; a plan
  that buys more often than hourly gets no file. Notifications come only from
  an open spDEX tab. A paused or deleted plan's calendar event stays until you
  delete it.
- **"Final" is your network service's word** for which block is finalized.
- **No price chart, and no value of your holdings.** Not a gap: THERE IS NO
  CHART, as the SPX6900 community says.
- **A plan buys only tokens on the list.** One that names any other token —
  a config edited by hand or imported can — says so and never buys.

## License

AGPL-3.0-or-later — fork it, run it, sell it if you like, but your users get the
source too. `packages/module-sdk` is MIT so writing modules carries no
obligation.

Fonts: Orbitron, Space Mono and Bebas Neue, under the SIL Open Font License
1.1; each ships beside its `OFL.txt` in `apps/web/src/assets/fonts/`, and the
build carries the same files.

Backdrop: a picture generated locally with Krea 2 Turbo, with SPX6900's logo
composited in as the coin; how it was made is in
`apps/web/src/assets/backdrop/README.md`, beside the files. The SPX6900 logo
in it is SPX6900's mark, used as the community uses it, and is not licensed
under the AGPL; the rest of the picture is under the repository's licence.
