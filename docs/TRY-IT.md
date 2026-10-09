# Trying spDEX in a browser

Practise swaps and auto-buys on a fork of Ethereum mainnet: real pools, real
prices, play money. Nothing here touches the real chain.

## Three terminals

```bash
# 1 — the fork (verifies its own block hash before serving)
pnpm anvil:fork

# 2 — the app
pnpm dev:web            # http://localhost:5173

# 3 — give your wallet something to trade
pnpm dev:fund 0xYourWalletAddress
```

`dev:fund` **adds** 100 ETH and 10 WETH to any address, even one the fork has
never seen (a development node impersonates anyone); change the amounts with
`--eth 50 --weth 20`. ETH is all you need: spDEX swaps native ether in and out
directly. The WETH is for trying the ERC-20 side, such as an auto-buy that
pays with a token.

## Pointing MetaMask at the fork

The fork runs as **chain ID 690069**, so MetaMask treats it as an ordinary
custom network. Open the app, connect, and when it says the wallet is on
another network, click **Add this network to my wallet**. Or add it by hand:
Settings → **Networks** → **Add a network manually**, name `spDEX fork`, RPC
URL `http://127.0.0.1:8545`, chain ID `690069`, currency symbol `ETH`.

Not anvil's default 31337: like 1337 and 8545, it belongs to another network
in the public chain registry, and wallets warn about it. A network of its own
can't be confused with your real Ethereum Mainnet setup, and MetaMask takes
its gas prices from the node. The state is still mainnet's: same contracts,
pools and prices, and `pnpm anvil:fork` checks the block hash to prove it.

spDEX adopts whatever chain the network service reports, and keeps checking:
a setup saved while the fork ran as chain 1 is corrected on the next load,
with a **Network updated** notice. **Change service** (**Settings** →
**Network service**) points spDEX elsewhere.

## Getting an account with funds

### Fund your own address

Make a fresh MetaMask account, not one holding real funds, and run `pnpm
dev:fund` with its address. Nothing is imported, so no publicly known key ends
up in your wallet.

### Or import an anvil test key

```bash
pnpm dev:keys        # prints the fork's accounts and their private keys
```

Then MetaMask → account menu → **Add account or hardware wallet** → **Import
account** → paste a private key.

**These keys are public, and the accounts are already compromised.** anvil
derives them from a published mnemonic, identical on every machine. On real
mainnet every one of them now carries an **EIP-7702 delegation** installed by
a sweeper bot — check for yourself:

```bash
cast code 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
# 0xef01008a67b5020ee254ef48e3b6a04927f39baf7e408a
```

`0xef0100` is the delegation designator; the rest is the delegate, which
forwards any ether the account receives in the same transaction. The fork
inherits it: swap SPX back to ETH from an imported anvil account and spDEX
refuses, because the ether would leave before you kept any. That refusal is
the Guard working, and the app warns as soon as you connect such an account
(**Your wallet forwards what it receives**). Anything sent to these addresses
on a real network is taken within seconds: never send them real funds, and
consider a separate browser profile so one can't be picked by accident.

## MetaMask will not show your tokens

MetaMask shows only tokens it has been told about, and its detection doesn't
work on a fork. The app shows your balances under the amount field, so you
need nothing more to swap. To see them in MetaMask anyway: **Tokens → Import
tokens → Custom token**, and paste

| Token | Address | Decimals |
|---|---|---|
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | 18 |
| SPX6900 | `0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C` | **8** |

SPX has 8 decimals, not the usual 18; let MetaMask read that from the
contract rather than typing it. If MetaMask shows **no ETH either**, the fork
isn't the active network: switch to it (**spDEX (chain 690069)** if the app
added it for you).

## Doing a swap

1. Open <http://localhost:5173>
2. **Before you swap**, the disclaimer, comes first on a first visit and again
   whenever its text changes. Any key (Enter, say), a click outside the text
   or **Continue** closes it; the footer's **Disclaimer** link shows it again
3. **Connect to Ethereum** asks which network service to use. Under **Your own
   free key**, skip the sign-up steps, enter `http://127.0.0.1:8545` in **Your
   key's URL** and click **Use this**. If **Use a free public service** is
   offered, skip it: that is the real network, not your fork
4. The page is a column of tiles, one open at a time: **Welcome, new aeon**,
   **Buy SPX**, **Your SPX**, **Markets**, **Collective DCA** and
   **Settings**. Click a header, or use ↑/↓ and Enter. **Welcome, new aeon**
   is three steps for someone new to SPX6900: a wallet, ETH on Ethereum and a
   first buy. While it's there, the **Features** dialog doesn't open by itself
   (**Settings** → **Features** opens it). **Hide this** puts Welcome away,
   and **Buy SPX** is then the tile open on load; **Settings** → **Getting
   started** brings it back. The status panel at the top says whether your
   network service answers; its **Details** show the latest block, read on
   load and on ↻, never on a timer
5. **Connect wallet**, in **Buy SPX**. It opens on **One-time**, paying with
   ETH for SPX. The amount starts in your currency, dollars in most browsers:
   type `20`, and the line under the field says how much ETH that comes to,
   which is what is quoted and signed. To type ether instead, pick **ETH** in
   the menu at the end of the amount box and try `1`; its **Change currency**
   group switches the page to euros or another currency
6. **Get price** (or Enter) shows **You pay**, **You get** and the network
   fee, and how many times your wallet will ask when it's more than once.
   While the tab is visible, the price refreshes itself every 30 seconds, for
   five minutes. **Refresh price** appears only after that, or after a swap
   you cancelled or that failed
7. **Advanced** (open by itself in Expert) has **At least** — the least you
   can receive, after your price tolerance — the rate, the route (which
   markets it used, and each one's share of the swap) and **Inspect
   transaction**, the exact approvals and calldata you would sign. Its header
   ends in **checked** when spDEX test-ran this exact transaction against
   current chain state and proved the outcome: inside, the banner reads
   **Checked**, with a small `verified` tag, and **What was checked** says
   what. A warning or a refusal is never folded away; it shows above **Swap**.
   Asked before connecting, the quote offers **Connect wallet to swap**, and
   the banner under **Advanced** reads **Price preview**: the price is real,
   but the test needs to know which wallet would sign
8. **Swap**. Paying with ETH is one confirmation; paying with a token first
   asks for a spending permission, unless an earlier one still covers the
   amount

Worth trying:

- **Expert** view (**Settings** → **View**; **Simple** is the default): every
  setting. **Settings** → **Markets used** lists every market found for the
  pair, with what it holds, its fee and its share of the pair while **Pool
  statistics** is on. Click **Pin only this** on one and **Get price** again:
  the route uses that market and nothing else
- **A large amount**, say 50 ETH: see whether the route splits across markets,
  and compare the Uniswap v2 pair with the v3 tiers. The route says either
  way, including when a split was considered and not worth its extra network
  fees. Set up vaults first if you mean to try them ("Set up vaults on the
  fork", below)
- **The other direction**, SPX → ETH, with native ether out. From a funded
  address of your own, not an imported anvil key (above)
- **Extra isolation** (Features), or **Run every module in the sandbox**
  (Settings → **Safety**, in Expert): the same swap, with the venue running
  inside QuickJS rather than natively. Same answer, same verdict; **Venue
  runtime** reads `quickjs (sandboxed)`
- **Export TOML** (Settings → **Settings file**, in Expert): everything spDEX
  remembers about your setup, auto-buy plans included, as a file you own.
  Never a wallet key or what the plans bought, but your network service's
  full address, any API key in it included
- **Aa Display**: **NEON** or **PASTEL**, spx6900.com's two colour modes, and
  text size, motion and contrast, remembered in this browser and never in your
  settings

## Tipping two people in one transaction

A tip goes out after the swap, from what it delivered: one ordinary transfer
for one person, and for two or more one transaction through Uniswap's Permit2,
after one signature. On the fork, the **Tip** row's **Listed in spDEX** offers
spDEX's donation vault and three test entries named "Placeholder", anvil
accounts #1 to #3 (`modules/tiplist-dev-fixtures`). Their keys are public, so
they are offered only on a local test network.

To tip someone of your own, choose **+ Add an address or ENS name** in the
picker, or add them in **Settings → Tips → My tip list**. The address is
checked before it is saved (a wrong checksum, a token contract, or a
lookalike of an address you already have), an ENS name is read through your
network service, and the first tip to the address waits until you check it
and press **Tip this address**. The list stays in this browser; **Export or
import** keeps a copy.

Swap from a `pnpm dev:fund` address to see the batch. From an imported anvil
key it can't work: Permit2 asks an account that has code to vouch for its own
signature, and the sweeper's delegation (above) doesn't answer. spDEX's check
sees the batch would fail before anything is sent, and the tips go as
separate transfers, with the reason in the status line. spDEX also refuses a
tip to yourself, so if your account is one of the placeholders, pick the other
two.

1. Keep **ETH → SPX**. Tips are sent in the token you receive, never in ETH
2. In the **Tip** row pick **0.5%**, then add two people, one at a time
3. **Get price**. The line under the row, and **Then, for tips** in the
   summary, say what the tips will ask of your wallet after the swap, in
   order: **1 signature, a standing Permit2 permission** the first time,
   **then 1 confirmation**
4. **Swap**, and confirm it. Then, for the tips:
   - **A signature request**, not a transaction: no fee, nothing sent. It
     names SPX, one amount per person, **you** as the spender and a deadline
     20 minutes out, and spDEX has checked it before MetaMask shows it.
     MetaMask may warn that a site wants to move your tokens, the right reflex
     for any Permit2 signature: the spender should be your own address. It
     comes first because it costs nothing and proves your wallet can sign one
     before any permission is asked for
   - **The first time only, a permission** for Permit2
     (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) to spend your SPX, with no
     limit, which is Permit2's convention. The status line under **Swap** says
     what it is while MetaMask asks. Until you revoke it (step 5), Permit2
     moves your SPX on a signature or a Permit2 approval you give, from any
     site; spDEX checks only the ones it asks for
   - **One transaction to Permit2** that pays both

   The status ends **Tipped … to 2 people in one transaction**
5. **Settings** → **Tips** → **Permit2 permission** lists SPX as
   **unlimited**. **Revoke** sends `approve(Permit2, 0)`, checked like
   everything else, and the next batched tip asks again. Revoking doesn't
   erase approvals other sites set up inside Permit2; those work again if you
   give the permission again

**Reject** the signature, and no tips are sent and no permission is asked for.
**Reject** the permission, and the tips go as separate transfers, which the
status says; the signature you gave goes unused, expires within 20 minutes,
and only a transaction you send could spend it. A wallet that can't sign typed
data sends the tips as transfers too, without being asked for the permission.

## Setting up an auto-buy

An auto-buy buys a fixed amount on a schedule, for as many buys as you set, so
every plan ends and its total is known before it starts. It lives in the
**Recurring** tab of **Buy SPX**. Auto-buy starts switched off in
**Features**; starting a plan switches it on.

1. **Buy SPX** → **Recurring**
2. **Pay with** ETH and **Buy** SPX are filled in. Enter **Amount each time**:
   `0.01` ETH, say, after tapping **ETH** beside it, or dollars, which the plan
   saves as the ETH they come to today
3. Set **How often** and **How many buys** (up to 1,000). The box below states
   the plan, its total and the network fees over the whole plan at today's
   fees. When those could be a large share of the plan, a warning says so,
   with what a vault would cost instead when that is less, its creation
   included
4. **How each buy is made**: **Confirm each buy myself**, below, or **Set and
   forget**, a vault ("An auto-buy vault", further down). When paying with
   ETH, each choice's **Cost** line says what one buy costs that way, so the
   two can be compared

The limits are under the choices and in **How auto-buy works**. In Expert,
**What will be saved** shows the plan exactly as it will be written into your
settings.

### Confirm each buy myself

1. Keep **Confirm each buy myself**, the default, and click **Start auto-buy —
   first buy now**. The first buy is made straight away: your wallet asks
   once, or twice when paying with a token (a permission, then the buy)
2. The plan appears in the **Auto-buys** tile, below **Buy SPX** (**See it in
   Auto-buys** goes there): its progress, **Next buy**, **Bought**, **Average
   rate**, and **History** with every buy and its transaction. On the fork a
   transaction shows as a short hash with **Copy**; spDEX links to Etherscan
   only on Ethereum itself
3. When the next buy falls due, the card shows **Buy 2 is due** with **Confirm
   buy** and **Skip this buy**, the status panel's **Plans** row and the
   **Auto-buys** header read **Buy due**, and the tab's title starts with
   **● Buy due**. No tile opens by itself, and your wallet never does.
   **Confirm buy** gets a fresh price and runs the safety check, and only then
   asks your wallet. If the fresh price is far from the 10-minute average
   price, it stops, says how far, and the button becomes **Buy anyway**
4. A buy not confirmed before its buy time ends is skipped, and History
   records it as not confirmed in time

**Pause** stops a plan. **Resume** shows its terms in plain words first, and
the plan spends again only once you confirm there; **Keep paused** leaves it
as it was.

### Watching a second buy

Buy times follow your computer's clock, so the second buy comes one interval
after the first, and **Every hour** is the shortest choice in Simple. For a
quicker look, switch **View** to **Expert** before starting: **How often**
gains **Custom…**, and **Every … minutes** takes anything from 5 up. Expert
also adds **First buy** (**Now** or **At a time I choose**) and **Name
(optional)**.

With a five-minute plan, keep the tab open and in front. Within about fifteen
seconds of the buy time, the plan shows **Buy 2 is due**. **Last checked**, in
the **Auto-buys** tile, is when the buying tab last looked; if it stops
moving, nothing is buying.

Moving the fork's clock (`evm_increaseTime`, `anvil_setTime`) doesn't help.
Buy times follow your computer's clock, not the chain's, and chain time pushed
past it makes every swap's deadline expire on chain until you restart the
fork.

### What it will not do

A vault is different; see the next section.

- **Buy while spDEX is closed.** There is no server. Buys happen only while
  spDEX is open and awake in a tab, and phones pause background tabs almost at
  once. A missed buy time is skipped, never made up later, and the plan ends
  later
- **Buy from two tabs.** With spDEX open in several tabs, one buys and the
  others say **Running in another tab**
- **Buy unchecked.** Every buy is priced and safety-checked right before it is
  signed, on one market, with your price tolerance capped at 3%. A buy the
  check can't run on is skipped. The fork can run it; on a network service
  that can't, the form says **This service can't safety-check**
- **Carry its record to another browser.** Plans are part of your settings,
  so an export or a share link carries them, and they arrive paused, but the
  record of what each has bought stays in this browser. Elsewhere the same
  plan counts from zero
- **Buy without you.** Your wallet never opens by itself; for buys while you
  are away, use a vault
- **Tip.** Auto-buys never send tips

## An auto-buy vault

**Set and forget** is a vault: a small contract you create for the plan. It
holds the budget and makes each buy when someone triggers it, with or without
spDEX open, and pays whoever makes a due buy (or the address they name) its
**buy fee**. For the first minutes after each buy falls due, its **community
window**, the fee can go only to an SPX holder who makes the buy, or back to
you; after that, anyone can make it. It buys SPX only, paid with ETH. It is
**unaudited**, and the form refuses a plan whose buys and fees come to more
than 0.5 ETH. On the fork that is play money; the steps are the same on
Ethereum.

### Set up vaults on the fork

Every vault is a copy made by one shared factory, which asks one shared SPX
holder registry who may be paid inside a community window. Both deploy to
fixed addresses, the same on Ethereum and on the fork: the registry to
`0x2c7f732a453fe0a4a65f36ac564ff16007b5610d` and the factory to
`0xbf40f0fb41e5ee1194173545749d80c4651bac32`. Both have been on Ethereum since
6 October 2026, but the fork copies the pinned block, from before then, so a
freshly started fork has neither. The first time:

1. **Buy SPX** → **Recurring**, and under **How each buy is made** choose
   **Set and forget**
2. A banner reads **Vaults aren't set up on this network yet**, with the
   factory's address and what deploying it costs. Click **Set up vaults on
   this network** and confirm in your wallet. The registry goes first when it
   isn't there yet (two transactions), since the factory can't be deployed
   without it

Nobody owns the registry or the factory, and each lands at the same address
whoever sends it, so all you pay for is gas. Before your wallet opens, spDEX
checks that the deployment would pass the factory's own checks on SPX's
markets. One is that SPX's Uniswap v3 pool and Uniswap v2 pair agree on the
price within 2%, and on a fork nothing brings them back together after a
large trade: set up vaults before trying the 50 ETH swap, or restart the fork
first. If a check fails, spDEX shows **Vaults aren't available right now**
and which check failed. A large trade after setup can leave a vault's buys
waiting on their price floor while the fork's prices stay pushed; the card
says so.

### Create one

1. With the vault chosen, **Pay with** is ETH and **Buy** is SPX, and neither
   can be changed
2. Enter **Amount each time** (`0.01`, with **ETH** tapped beside it) and
   **How many buys** (`3`). For a buy every five minutes, switch **View** to
   **Expert** first and choose **How often** → **Custom…**, **Every 5
   minutes**. In Simple the shortest is **Every hour**
3. Pick a **Price allowance**: 1%, 2% (the default) or 3%. Each buy is refused
   if it would get more than that below the 10-minute average price, or below
   the price now if that is better for you
4. **How auto-buy works** says how long SPX holders have first claim on each
   buy: 30 minutes, or a quarter of the interval when that is shorter (75
   seconds for a five-minute plan). In Expert, **Community window** offers 1,
   5, 15, 30 or 60 minutes, or a quarter of the interval, with any choice
   longer than a quarter of the interval greyed out. Shorter, your buy happens
   sooner when no holder is online; longer, holders have more time to earn
   your fee
5. Read the **Cost** line: what creating the vault costs at today's fees, then
   the buy fee for each buy, in your currency when spDEX knows a price, and as
   a share of the buy, never rounded down. `0.01` ETH a buy pays 0.0000439
   ETH, shown as 0.44%. The summary box says what goes in: every buy plus every
   buy's fee
6. Click **Create and fund vault**. Your wallet asks once: that one
   transaction creates the vault and sends the whole budget into it

The allowance, the community window and the buy fee are fixed once the vault
exists. The fee depends only on the amount, never on today's network fees:
0.0000189 ETH for one batched buy's network cost, plus 0.25% of the buy, at
most 0.69% (`packages/vault/src/fee.ts`). Try a few amounts and watch the
notes under the choice:

- under about 0.0015 ETH a buy, **Buys this small may be skipped**: the fee is
  less than a buy costs a keeper even when network fees are low
- under about 0.0027 ETH, **Small buys depend on low network fees**: held at
  0.69%, the fee covers a keeper's cost only while fees stay low
- up to about 0.0043 ETH the fee is 0.69% of the buy; above that, a smaller
  share the larger the buy
- when network fees are very low, a note says confirming each buy yourself
  costs less
- under 0.000001 ETH the plan is refused

Keep each buy at 0.001 ETH or more on the fork, and your own keeper (below)
makes every buy.

### The vault's card

The plan appears in the **Auto-buys** tile, marked **Unaudited**:

- **Buys made**, **Next buy**, **Bought** and **Average rate**, read from the
  vault itself, not from this browser, so a reload shows the same figures
- **Vault** (its address, with **Copy**), **Holds** (what it has left, and how
  many buys that covers), **Buy fee** and **Price allowance**
- **History**, read from the vault's own logs when you open it. Each buy says
  who made it — you, a community keeper inside its window, or whoever made it
  after the window — and who was paid what ("triggered by a community keeper,
  paid 0x… its … WETH buy fee"). Inside the window anyone may make a buy that
  pays its fee back to the owner, and History says so
- **Close and withdraw**, **Delete**, and a line saying why there is no pause.
  A vault holding less than every buy it has left, with their fees, also
  offers a top-up: **Fund … ETH** when it can't cover its next buy, **Add …
  ETH** otherwise
- A plan whose vault was never made (the wallet declined, or the plan came
  from a link) offers **Create and fund vault** instead, with the **Price
  allowance** chips, the **Buy fee** it would be created with and exactly what
  the confirmation sends. With no allowance kept from the form, pick one: the
  card doesn't choose it for you

When a buy falls due, the card says it is waiting for a keeper, and until when
holders have first claim: **Community window until 14:32, then open to
anyone.** **Trigger now** works inside the window too: it makes the buy naming
you as the one paid (`execute` with your own address), so your wallet pays the
network fee and the buy fee comes back to you as WETH. The banner gives both
figures. When the network fee is more than the buy fee, it says so, and
**Trigger now** is no longer the main button: a keeper making the buy costs
you less.

### Watch a buy with spDEX closed

This is what a vault is for. On Ethereum an SPX holder's keeper may make each
buy inside its community window, and anyone's after it, many vaults at a time
through the batcher. On your fork nobody else is watching, so run a keeper
yourself. It needs Node 22.15 or later; `docs/KEEPER.md` has everything it can
do.

A keeper on the fork is never a community keeper: its fresh key holds no SPX,
and the fork can't prove a block it mined. So below it names you, the vault's
owner, as the one paid, which a vault always allows: it makes your buys inside
their windows, and the fees come back to you.

1. Give the keeper a key of its own, with ether for gas. Not an anvil test
   key: those accounts pass on any ether they receive (above)

   ```bash
   cast wallet new                  # prints an address and a private key
   pnpm dev:fund 0xKeeperAddress    # ether for its gas
   ```

2. Deploy the batcher, once per fork. Anyone may, and it lands at
   `0xd1f8327aa8398997bd88165f420412c703ebfed0`, its address on Ethereum too,
   whoever sends it. It is bound to no factory, so it needs nothing deployed
   before it:

   ```bash
   SPDEX_KEEPER_RPC_URL=http://127.0.0.1:8545 SPDEX_KEEPER_KEY=0xTheKeeperKey pnpm keeper --deploy-batcher
   ```

   It ends `every listed batcher whose factory is on this chain is deployed`,
   whether it deployed the batcher or found it there

3. Create a vault with a five-minute interval, as above, and close the spDEX
   tab. Its first buy falls due about 105 seconds after you create it, not at
   once: a plan whose community window is under three minutes starts that
   much later, so that a creation slow to sign and land still leaves its first
   buy a minute of first claim. Wait that long, and let a block come after it
   (step 6 shows how)
4. Run one tick of the keeper, limited to your vault and paying your wallet:

   ```bash
   SPDEX_KEEPER_SEND_WHEN=now SPDEX_KEEPER_RPC_URL=http://127.0.0.1:8545 \
   SPDEX_KEEPER_CONFIRMATIONS=1 SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS=0 \
   SPDEX_KEEPER_VAULTS=0xYourVault SPDEX_KEEPER_REWARD_TO=0xYourWallet \
   SPDEX_KEEPER_KEY=0xTheKeeperKey pnpm keeper --once
   ```

   `SEND_WHEN=now` sends as soon as a buy is due instead of waiting for a
   cheap block; one confirmation, because the fork makes a block only when a
   transaction arrives; no head-lag check, because the idle fork's latest
   block is days behind your clock. It prints one JSON line per record:
   `start`, `vault_found`, `batch_sent`, then `batch_mined` with the
   transaction's `hash`, its `gasUsed` and `earnedWei`, the buy fee your vault
   paid your wallet. The same lines go to a daily file in `.keeper/690069/`,
   beside its state. Add `--dry-run` to see what it would do without signing.

   Leave `SPDEX_KEEPER_REWARD_TO` out and the keeper is its own `rewardTo`,
   which the vault pays only once the window is over: inside it, the keeper
   logs `skip` `holders-first` and leaves the buy until the window ends, which
   on the fork also takes a block after its end (step 6)
5. Open spDEX again. **Buys made** reads 1 of 3, and **History** shows the
   buy, made through the batcher inside its window, with its fee paid back to
   you
6. For the second buy, run the same command without `--once` and leave it
   running. **The fork makes a block only when a transaction arrives**, and a
   vault judges "due" by the latest block's time, so on an idle fork the next
   buy isn't due until some block comes after its buy time (on Ethereum, one
   comes every 12 seconds). Once the five minutes are up, make one:

   ```bash
   cast rpc evm_mine --rpc-url http://127.0.0.1:8545
   ```

   That mines one empty block at the fork's current time, without moving its
   clock; any transaction, a swap or `pnpm dev:fund`, does the same. The
   keeper's next tick makes the buy. A community window ends the same way:
   only once some block's time is past it

The fork's clock started at the pinned block's time, days behind your
computer's, and runs at normal speed from there. The keeper's records carry
chain time; the card converts it to yours, so **Next buy** counts down
correctly either way.

To run the same in the keeper's Docker image, or have `pnpm keeper:smoke` run
the whole round trip with fresh keys and check it, see `docs/KEEPER.md`,
"Trying it on the local fork".

### Help run the network, and community keeping

Community keepers make other people's buys and are paid for each one; holding
690 SPX is the entry bar. **Help run the network**, in the **Collective DCA**
tile while a wallet is connected, is the way to do it from a tab: once, when
pressed, it makes the due buys of anyone's vaults from your own wallet, and
they pay your wallet.

It sends only privately, so with MetaMask on the fork it asks you to turn
private sending on (see "What you will not be able to test"). With a wallet
that can sign privately, **See which buys are due** lists them. A buy still
inside its community window, your own vaults' included, is offered only to an
eligible wallet, and your fork wallet isn't one. For that buy it shows when
holders' first claim ends ("SPX holders have first claim until 14:32"), how
far the wallet is from the bar ("You hold 0 of the 690 SPX.") and, when the
build says where its source is, a link to "Becoming a community keeper", with
no button to make the buy (**Trigger now** on a card makes your own). Once the
window is over, and on the fork a block has come after it, the buy is offered
to you as to anyone.

At its foot, **Community keeping** works without private sending, and reads
nothing until you open it. Open it with your wallet connected:

1. It says whether the wallet is eligible, until when, and how much SPX it
   holds against the 690. Swap ETH for 690 SPX or more (above) and look again:
   it holds enough now, and still isn't eligible. Holding is checked at the
   moment of each buy; proving that the wallet held the SPX when a block
   closed is a separate step, once every 30 days
2. **Prove my SPX** proves the `finalized` block, 64 blocks behind the head.
   On the fork that is either a mainnet block, at which your fresh wallet held
   no SPX, or a block the fork mined, which nothing can be proven against, so
   your own proof can't be made here. Before a wallet's first proof, the panel
   says what proving makes public: worth reading before doing it on Ethereum
3. **Prove another address** and **Paste a proof** are folds below it. The
   first proves any address from this wallet, so a holder's cold wallet never
   needs a browser; the second is for a network service that refuses
   `eth_getProof`

`docs/KEEPER.md`, "Becoming a community keeper", has the rest: the steps on
Ethereum, what proving costs and publishes, and what the 690-SPX bar does and
doesn't filter.

### Close it

**Close and withdraw** asks **Close this vault?** and says what comes back.
Confirm with **Close and withdraw**, then in your wallet, and everything the
vault holds comes back to your wallet as ETH. A closed vault can't be
reopened, so to buy again, start a new plan. **Delete** then removes the plan
from the list.

### Find a vault spDEX lost track of

A vault doesn't need spDEX to remember it. Delete its card, reset or replace
your settings, or open spDEX in another browser, and the vault still holds its
budget and buys whenever triggered. With your wallet connected, spDEX finds it
again from the chain: it asks spDEX's vault factories how many vaults you have
created and reads their logs for them.

1. Create a vault as above, then **Delete** its card. The card warns that the
   vault still holds WETH; click **Delete anyway**
2. The card is gone, and in the **Auto-buys** tile a section appears, **Vaults
   on chain not in your plans**, with the vault, what it holds and how far it
   has got. Reload the page and connect again: it is still there, found from
   the chain alone
3. **Close and withdraw** there works as on a card: confirm, then in your
   wallet, and everything it held comes back as ETH. Once you've read the
   result, a closed, empty vault moves to a collapsed **Closed vaults (1)**
4. Or click **Add back to my plans**: the vault gets its card again, with a
   plan made from the vault's own terms, and the page takes you to it.
   Nothing is sent

spDEX looks once when your wallet connects, and again when you click **Look
again**, which also rereads every vault it knows. On the fork one query finds
everything; when your plans already hold every vault you've created, it reads
no logs at all. Hosted network services often cap how many blocks one query
may cover, so spDEX narrows its queries, stops after 40, and then reads the
factories' own lists instead (every listed vault's owner). Only if that fails
too does it say how many of your vaults **aren't shown here**, rather than
pretending there are no more. A service that serves older records (your own
node does) or a block explorer can find the rest; the note gives the factory
addresses to look for.

### What a vault will not do

- **Buy without a keeper.** Nobody promises to trigger a buy. A buy time
  nobody triggers is skipped, never made up later, and the plan ends later
- **Hurry its community window.** When no SPX holder's keeper is about, a due
  buy waits out its window (at most an hour, and at most a quarter of the
  interval), then anyone can make it; **Trigger now** makes it at any time,
  paid back to you
- **Pause or change.** The amount, the timing, the allowance, the community
  window and the buy fee are fixed when the vault is created. **Close and
  withdraw** is the only stop, and it is final; to change a plan, close it and
  start a new one
- **Buy anything but SPX, or pay with anything but ETH.** The factory's list
  of markets is fixed, and on Ethereum it has one entry
- **Stop when you delete the plan.** **Delete** only forgets the plan in this
  browser. The vault stays on chain and goes on buying whenever triggered, and
  the card warns if it still holds money. Close it first, or find it again
  (above)

## MetaMask alerts on the fee, or on HTTP

MetaMask may replace **Confirm** with a red **Review alert**, often with the
network fee highlighted. Click it, read the detail, and continue: the
transaction is fine. Two artifacts of running a fork provoke it:

- **The fee estimate doesn't match the chain.** The fork was added as Ethereum
  Mainnet's RPC rather than as a network of its own, so MetaMask prices gas
  from its mainnet service while anvil's nearly empty blocks keep the base fee
  under about 1,000 wei. Add the fork as its own network (above) and the alert
  goes away
- **The app is served over HTTP.** `localhost:5173` has no TLS, which MetaMask
  flags on principle

Neither affects execution.

## Resetting

The fork accumulates your trades. To start over, stop `pnpm anvil:fork` and
start it again: it re-seeds from the pinned block, so prices return to exactly
where they were.

A restarted fork forgets every transaction, `dev:fund` included, and with them
the SPX holder registry, the vault factory, the batcher and every vault, with
what they held and bought. spDEX's own state lives in the browser and stays:
your settings, auto-buy plans and the record of what they bought. Delete them,
or clear this site's data, to start from nothing. A vault plan's card then
says there is no vault at its address; delete the plan. The first vault on the
new fork needs **Set up vaults on this network** again, and a keeper needs
`pnpm keeper --deploy-batcher` again. A keeper's state in `.keeper/690069/`
belongs to the old fork (its nonce and its latest block are ahead of the new
one's), so run the keeper once with `--reset-state` added, which moves the
state file aside and starts fresh.

**Reset to recommended** (**Settings** → **Settings file**, in Expert)
restores the preset without losing your network service. If you have
auto-buys it asks first (**Remove auto-buys?**); a vault plan whose vault may
still hold money or buy stays, and the question says so.

## What you will not be able to test

- **Private sending** needs a wallet that signs without broadcasting
  (`eth_signTransaction`). MetaMask refuses, so spDEX asks before broadcasting
  publicly (**Can't send privately**) rather than doing it quietly. Auto-buys
  never take that way out: a buy that can't be sent privately is skipped. The
  relays are on the real network and know nothing of your fork, so leave
  Private sending off while trying auto-buy
- **The built-in network service** is allowlisted to the published release's
  address, so locally you always supply your own (`docs/RPC-RUNBOOK.md`)
- **Strangers' keepers.** Nobody else watches your fork, so a vault's buys
  happen only when you press **Trigger now** or run `pnpm keeper`
- **Being a community keeper.** The fork can't prove a block it mined, and
  your fresh wallet held no SPX at any block before them. So no wallet of
  yours is eligible on the fork, Help run the network offers you a buy only
  once its window is over, and a keeper you run makes buys inside their
  windows only by paying their owner (above). The repository's tests reach the
  eligible paths with proofs recorded from mainnet instead
  (`docs/DEVELOPMENT.md`, "Proofs, and how long a fork stays useful for them")
