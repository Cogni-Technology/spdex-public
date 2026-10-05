# Trying spDEX in a browser

Practice swaps and auto-buys against a fork of Ethereum mainnet: real pools,
real prices, play money. Nothing here touches the real chain.

## Three terminals

```bash
# 1 — the fork (verifies its own block hash before serving)
pnpm anvil:fork

# 2 — the app
pnpm dev:web            # http://localhost:5173

# 3 — give your wallet something to trade
pnpm dev:fund 0xYourWalletAddress
```

`dev:fund` **adds** ETH to the address and wraps some of it into WETH. It works on **any**
address, including a MetaMask account the fork has never seen, because a
development node will impersonate anyone. Defaults to 100 ETH and 10 WETH;
override with `--eth 50 --weth 20`.

ETH is all you need to start: spDEX swaps native ether in and out directly,
wrapping and unwrapping inside the swap. The WETH is there for trying the
ERC-20 side — a WETH pair, or an auto-buy that pays with a token, which adds a
spending permission to each buy.

## Pointing MetaMask at the fork

The fork runs under **chain ID 690069**, so MetaMask treats it as an ordinary
custom network.

Easiest route: open the app, connect, and when it tells you the wallet is on
another network click **Add this network to my wallet**. MetaMask fills in the
details itself and saves it for next time.

By hand, if you prefer:

1. Settings → **Networks** → **Add a network manually**
2. Name: `spDEX fork` · RPC URL: `http://127.0.0.1:8545`
3. Chain ID: `690069` · Currency symbol: `ETH`
4. Save, and switch to it

Not 31337, the obvious choice and anvil's default: that id belongs to GoChain
Testnet in the public chain registry, so wallets warn about the mismatch and
can refuse to save the network. 1337 (Geth Testnet) and 8545 (Chakra Testnet)
collide the same way. 690069 is absent from the registry.

Nothing about your real Ethereum Mainnet setup changes, there is no way to
confuse the two, and MetaMask takes gas prices from the node rather than from
its mainnet service — which is what removes the fee warnings.

The forked *state* is still mainnet: same contracts, same pools, same prices.
Only the id differs, and `pnpm anvil:fork` still verifies the block hash to
prove the history is genuinely mainnet's.

spDEX adopts whatever chain the network service reports, so there is nothing to
configure, and it keeps checking: a setup saved while the fork ran as chain 1
is corrected on the next load, with a **Network updated** notice saying so. To
point spDEX somewhere else, use **Change service** in **Settings** →
**Network service**.

## Getting an account with funds

Two ways. The second is safer and needs no key.

### Import an anvil test key

```bash
pnpm dev:keys        # prints the fork's accounts and their private keys
```

Then MetaMask → account menu → **Add account or hardware wallet** → **Import
account** → paste a private key.

**These keys are public, and the accounts are already compromised.** anvil
derives them from a published mnemonic, so they are identical on every machine
running it. On real mainnet every one of them now carries an **EIP-7702
delegation** installed by a sweeper bot — check for yourself:

```bash
cast code 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
# 0xef01008a67b5020ee254ef48e3b6a04927f39baf7e408a
```

`0xef0100` is the delegation designator; the rest is the delegate. It forwards
any ether the account receives, in the same transaction. A fork inherits
mainnet state, so **this happens on your fork too**: swap SPX back to ETH from
an imported anvil account and spDEX will refuse, because the ether would leave
again before you kept any of it. That refusal is the Guard working. The app
also warns as soon as you connect such an account (**Your wallet forwards what
it receives**).

`pnpm dev:fund` on a fresh address avoids all of this, which is the other
reason to prefer it.

That is harmless on a fork and catastrophic anywhere else: anything sent to these addresses on a
real network is taken within seconds by bots that watch them. Import one if you
like, but never send it real funds, and consider using a separate browser
profile so it cannot be picked by accident later.

### Or fund your own address (no key involved)

```bash
pnpm dev:fund 0xYourMetaMaskAddress
```

This works on any address, including one the fork has never seen, because a
development node will impersonate anyone. Nothing is imported, nothing public
ends up in your wallet, and there is no account to confuse with a real one
later. Make a fresh MetaMask account for it rather than using one holding real
funds.

## MetaMask will not show your tokens

It shows ETH, and nothing else. That is expected: MetaMask only displays tokens
it has been told about, and its automatic detection does not work against a
local fork. Your balances are real either way — the app reads them straight
from the node and shows them under the amount field, so you do not need to add
anything to swap.

If you want to see them in MetaMask anyway: **Tokens → Import tokens → Custom
token**, and paste

| Token | Address | Decimals |
|---|---|---|
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | 18 |
| SPX6900 | `0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C` | **8** |

SPX has 8 decimals, not the usual 18. MetaMask reads that from the contract, so
let it fill the field in rather than typing it.

If MetaMask shows **no ETH either**, the fork is not the active network —
switch MetaMask to the one you added for it (**spDEX (chain 690069)** if the
app added it for you).

## Doing a swap

1. Open <http://localhost:5173>
2. **Before you swap** comes first: the disclaimer, shown on a first visit and
   again whenever its text changes. Read it; any key (Enter, say), a click
   outside the text or **Continue** closes it. The footer's **Disclaimer** link
   shows it again
3. The next screen, **Connect to Ethereum**, asks which network service to use.
   Under **Use my own service**, enter `http://127.0.0.1:8545` and click **Use
   this**. If a **Use a free public service** button is offered, skip it: that
   is the real network, not your fork. (A published release skips this screen:
   at its own address it uses its built-in service, which the disclaimer names;
   see `docs/RPC-RUNBOOK.md`.)
4. The page is a column of tiles: **Welcome, new aeon** (open), **Buy SPX**,
   **Your SPX**, **Markets**, **Collective DCA** and **Settings**. Once Welcome
   is hidden, **Buy SPX** is the one open when the page loads. One opens at a
   time; click a header, or use ↑/↓ and Enter. The status panel at
   the top (a bar on a phone) says whether your network service answers, the
   latest block and the time it was read (read once, and again on ↻ under
   **Details**, never on a timer) and your wallet. **Aa Display** holds the
   colour mode, text size, motion and contrast. **Welcome, new aeon** is four
   steps for someone new to SPX6900; while it's there, the **Features** dialog
   doesn't open by itself (its **Choose features** link opens it, as does
   **Settings** → **Features**). **Hide this** puts Welcome away, and
   **Settings** → **Getting started** brings it back
5. **Connect wallet**, in **Buy SPX**. It opens on **One-time**, paying with ETH
   for SPX. The amount starts in your currency, dollars in most browsers: type
   `20`, and the line under the field says how much ETH that comes to, which
   is what is quoted and signed. To type ether instead, pick **ETH** in the
   menu at the end of the amount box and try `1`; its **Change currency** group
   switches the page to euros or another currency
6. **Get price** (or Enter) shows **You pay**, **You get**, **At least** — the
   least you can receive, after your price tolerance — and how many times your
   wallet will ask. **Route** opens the detail: which markets it used and what
   share of the swap each took
7. The banner should read **Checked**, with a small `verified` tag — spDEX
   test-ran this exact transaction against current chain state and proved the
   outcome before anything is signed (**What was checked** says what). Asked
   before connecting, it reads **Price preview** instead: the price is real, but
   the test needs to know which wallet would sign
8. **Swap**. Paying with ETH is one confirmation; paying with a token first asks
   for a spending permission, unless an earlier one still covers the amount

Worth trying:

- **Inspect transaction** — the exact approvals and calldata you are about to sign
- **Expert** view (**Settings** → **View**; **Simple** is the default) —
  every setting, and under **Which markets may be used** every market found for
  the pair, with what it holds, its fee and its share of the pair while **Pool
  statistics** is on. Click **Pin only this** on one and **Get price** again: the
  route uses that market and nothing else
- **A large amount** — say 50 ETH. Watch whether the route splits across markets
  and compare the v2 pair against the v3 tiers. **Route**
  says either way, including when a split was considered and not worth its
  extra network fees
- **The other direction** — SPX → ETH, native ether out, unwrapped inside the
  swap. From a fresh funded address, not an imported anvil key (see above)
- **Extra isolation** (Features), or **Run every module in the sandbox** under
  Settings → **Safety** — the same swap, with the venue running inside QuickJS
  rather than natively. Same answer, same verdict; **Venue runtime** reads
  `quickjs (sandboxed)`
- **Export TOML** (Settings → **Settings file**) — everything spDEX remembers about
  your setup as a file you own, auto-buy plans included, but never what they
  bought or any key
- **Aa Display** — **NEON** or **PASTEL**, the two colour modes spx6900.com
  has, and text size (A+ to start), motion and contrast. It opens under the
  masthead, or sits pinned bottom-left in a window at least 1440 px wide,
  where changing the text size resizes it but never moves it. The choices are
  remembered in this browser, not in your settings, so they never turn up in an
  export or a shared link

## Tipping two people in one transaction

A tip goes out after the swap, from what it delivered: one ordinary transfer
for one person, and for two or more a single transaction through Uniswap's
Permit2, after one signature. On the fork the **Tip** row's **Listed in
spDEX** offers spDEX's donation vault, the one real entry, and three test
entries named "Placeholder", anvil accounts #1 to #3
(`modules/tiplist-dev-fixtures`). The test entries' keys are public, so they
are offered only on a local test network; the real list holds only the
donation vault until its maintainer adds people.

To tip someone of your own, choose **+ Add an address or ENS name** in the
picker, or add them in **Settings → Tips → My tip list**. The address is
checked before it is saved (a wrong checksum, a token contract or a lookalike
of an address you already have is caught), an ENS name is read through your
network service, and the first tip to the address waits until you check it
and press **Tip this address**. The list stays in this browser; **Export or
import** keeps a copy.

Swap from a `pnpm dev:fund` address to see the batch. From an imported anvil
key it can't work: Permit2 asks an account that has code to vouch for its own
signature, and the sweeper's delegation (above) doesn't answer. spDEX's check
sees the transaction would fail before anything is sent, and the tips go as
two separate transfers, with the reason in the status line. And if that
account is one of the placeholders, pick the other two: spDEX refuses a tip to
yourself.

1. Keep **ETH → SPX**. Tips are sent in the token you receive, and not in ETH
2. In the **Tip** row pick **0.5%**, then add two people, one at a time
3. **Get price**. The line under the row, and **Then, for tips** in the
   summary, say what the tips will ask of your wallet after the swap, in the
   order it asks: **1 signature, a standing Permit2 permission** the first
   time, **then 1 confirmation**
4. **Swap**, and confirm it. Then, for the tips:
   - **A signature request**, not a transaction: no fee, nothing sent. It
     names SPX, one amount per person, **you** as the spender, and a deadline
     20 minutes out. spDEX has checked it before MetaMask shows it. MetaMask
     may warn that a site wants to move your tokens, which is the right
     reflex for any Permit2 signature: the spender should be your own address.
     It comes first because it costs nothing and shows your wallet can sign
     one before any permission is asked for
   - **The first time only, a permission** for Permit2
     (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) to spend your SPX, with no
     limit. The status line, under the Swap button, says what it is while
     MetaMask asks. Unlimited is Permit2's convention. It stays until you
     revoke it (step 5), and while it does, Permit2 moves your SPX on a
     signature or a Permit2 approval you give, from any site: spDEX checks
     only the ones it asks for
   - **One transaction to Permit2** that pays both

   The status ends **Tipped … to 2 people in one transaction**, and names
   who it pays while MetaMask asks
5. Settings → **Tips** → **Permit2 permission** lists SPX as **unlimited**.
   **Revoke** sends `approve(Permit2, 0)`, checked like everything else. The
   next batched tip asks again. Revoking doesn't erase approvals other sites
   set up inside Permit2; those work again if you give the permission again

Worth trying: **Reject** the signature, and no tips are sent, and no
permission is asked for. **Reject** the permission, and the tips go as two
separate transfers, which the status says; the signature you gave goes unused
and expires within 20 minutes, and only a transaction you send could spend
it. A wallet that can't sign typed data at all sends the tips as transfers
too, without being asked for the permission. One person is always one plain
transfer, with no Permit2 at all.

## Setting up an auto-buy

An auto-buy buys a fixed amount on a schedule — dollar-cost averaging — for as
many buys as you set, so every plan ends and its total is known before it
starts. You set one up in the **Recurring** tab of the **Buy SPX** tile. Auto-buy
starts switched off in **Features**; starting a plan switches it on.

The form is the same for both ways of running a plan:

1. **Buy SPX** → **Recurring**
2. **Pay with** ETH and **Buy** SPX are filled in. Enter **Amount each time**
   — `0.01` ETH, say, after tapping **ETH** beside it, or dollars, which the
   plan saves as the ETH they come to today
3. Set **How often** and **How many buys** (up to 1,000). The box below states
   the plan, its total, and the network fees over the whole plan at today's
   fees. When those could be a large share of the plan, a warning says so, and
   gives what a vault would cost instead when that is less, the
   vault's creation included
4. **How each buy is made** — **Confirm each buy myself**, below, or
   **Set and forget** (a vault, no tab needed), which has a section of
   its own further down ("An auto-buy vault"). When paying with ETH, each
   choice's **Cost** line gives what one buy costs that way — a network fee at
   today's fees, or the vault's buy fee — in your currency when spDEX knows a
   price, in ETH, and as a share of the buy, so the two can be compared

The limits are on the form rather than in a help page, under the choices and in
**How auto-buy works**. In Expert, **What will be saved** shows the
plan exactly as it will be written into your settings.

### Confirm each buy myself

1. Keep **Confirm each buy myself**, the default, and click **Start auto-buy —
   first buy now**. The first buy is made straight away: your wallet asks once,
   or twice when paying with a token — a permission, then the buy
2. The plan appears in the **Auto-buys** tile, just below **Buy SPX** (the form
   stays open, and **See it in Auto-buys** goes there): its
   progress, **Next buy**, **Bought**, **Average rate**, and **History** with
   every buy and its transaction. On the fork a transaction shows as a short
   hash with **Copy**; spDEX links to Etherscan only on Ethereum itself
3. When the next buy falls due, the card shows **Buy 2 is due** with **Confirm
   buy** and **Skip this buy**, the status panel's **Plans** row and the
   **Auto-buys** header read **Buy due**, and the tab's title starts with
   **● Buy due**. No tile opens by itself. Your
   wallet never opens by itself. **Confirm buy** gets a fresh price and runs the
   safety check, and only then asks your wallet. If the fresh price turns out
   far from the 10-minute average price, it stops, says how far, and the button
   becomes **Buy anyway**
4. A buy not confirmed before its buy time ends is skipped, and History records
   it as not confirmed in time

**Pause** stops a plan. **Resume** shows its terms in plain words first, and
the plan spends again only once you confirm there; **Keep paused** leaves it as
it was.

### Watching a second buy

Buy times follow the page's clock, which on a fork is still your computer's
real one, so the second buy comes one interval after the first. **Every hour**
is the shortest choice in Simple. For a quicker look, switch the **View** to
**Expert** before starting: **How often** gains **Custom…**, and **Every …
minutes** takes anything from 5 up. Expert also adds **First buy** (**Now** or
**At a time I choose**) and **Name (optional)**.

With a five-minute plan, keep the tab open and in front. Within about fifteen
seconds of the buy time, the plan shows **Buy 2 is due**. **Last checked**,
in the **Auto-buys** tile, is when the buying tab last looked; if it stops
moving, nothing is buying.

Moving the fork's clock (`evm_increaseTime`, `anvil_setTime`) does not help.
Buy times follow your computer's clock, not the chain's, and chain time pushed
past it makes every swap's deadline expire on chain until you restart the fork.

### What it will not do

These are about a plan you confirm yourself. A vault is different; see the
next section.

- **Buy while spDEX is closed.** There is no server. Buys happen only while
  spDEX is open and awake in a tab; browsers slow background tabs, and phones
  pause them almost at once. A buy time missed is skipped, never made up in a
  burst later, and the plan simply ends later
- **Buy from two tabs.** With spDEX open in several tabs one of them buys, and
  the others say **Running in another tab**
- **Buy unchecked.** Every buy is priced and safety-checked right before it is
  signed, on a single market, with your price tolerance capped at 3%. A buy the
  check can't run on is skipped. The fork can run it; a network service that
  can't blocks Start with **Auto-buy can't run on this network service**
- **Carry its record to another browser.** Plans are part of your settings, so
  an export or a share link carries them — and they arrive paused — but the
  record of what each has bought stays in this browser. Elsewhere the same plan
  counts from zero
- **Buy without you.** Your wallet never opens by itself. For buys made while
  you are away, use a vault
- **Tip.** Auto-buys never send tips

## An auto-buy vault

**Set and forget** is a vault: a small contract you create for the plan, which
holds the plan's budget and makes each buy when someone triggers it, with or
without spDEX open. Whoever makes a due buy names who is paid its **buy fee**,
fixed when you create the vault: a fixed amount for network fees plus 0.25% of
the buy, never more than 0.69% of the buy. For the first minutes after each
buy falls due (its **community window**, 30 minutes by default), the fee can
go only to an SPX holder who makes the buy, or back to you; after that,
anyone can make it. It buys SPX only, paid with ETH. It is **unaudited**, and
you can put at most 0.5 ETH into one. On the fork that is play money; the
steps are the same on Ethereum.

This build makes v2 vaults, the release with the community window. v1
vaults, the first release's, have no window, pay whoever makes their buy,
and go on working as they always have.

### Coming from an earlier build

This build's factory is at a new address, and it creates every new vault
there. It still vouches for vaults made by the factory of any release listed
in `packages/vault/deployments.json`, v1's included, so if your fork holds
vaults an earlier build made on v1's factory
(`0xe4a1410a9ee0833d41e7514306e65ad729b7199e`), their cards stay, with **Close
and withdraw**, **Trigger now** and top-ups. Only a vault from a factory no
release lists, an in-between development build's, loses them: close it with
that build before switching, or restart the fork (`pnpm anvil:fork`), which
forgets every vault along with everything else. On a fork it is play money
either way.

### Set up vaults on the fork

Every vault is a copy made by one shared factory contract, which asks one
shared SPX holder registry who may be paid inside a community window. This
source deploys both to fixed addresses, the same on Ethereum and on the fork:
the registry to `0x2c7f732a453fe0a4a65f36ac564ff16007b5610d` and the factory
to `0x164080e374f3a924245c3a99fbadbd2c98ed48eb`. Neither is on Ethereum until
v2's release (`docs/RELEASE.md`), and a freshly started fork has neither, so
the first time:

1. **Buy SPX** → **Recurring**, and under **How each buy is made** choose
   **Set and forget**
2. A banner reads **Vaults aren't set up on this network yet**. It shows the
   factory's address and what deploying it costs. Click **Set up vaults on
   this network** and confirm in your wallet. The registry goes first when it
   isn't there yet, since the factory refuses to be deployed without it

Nobody owns the registry or the factory, and each lands at the same address
whoever sends it, so all you are paying for is gas. Before your wallet opens,
spDEX checks that the deployment would pass the factory's own checks on SPX's
markets right now. One of those checks is that SPX's v3 pool and v2 pair agree on the price
within 2%, and on a fork nothing brings them back together after a large
trade. So set up vaults before trying the 50 ETH swap above, or restart the
fork first. If a check fails, spDEX doesn't offer the deployment; it shows
**Vaults aren't available right now** and says which check failed. A large
trade made after setup can also leave a vault's buys waiting on their price
floor for as long as the fork's prices stay pushed, and the card says so.

### Create one

1. With the vault chosen, **Pay with** is ETH and **Buy** is SPX, and
   neither can be changed
2. Enter **Amount each time** (`0.01`, with **ETH** tapped beside it) and
   **How many buys** (`3`). For a buy every five minutes, switch the **View**
   to **Expert** first and choose **How often** → **Custom…**, **Every 5
   minutes**. In Simple the shortest is **Every hour**
3. Pick a **Price allowance**: 1%, 2% (the default) or 3%. Each buy is refused
   if it would get more than that below the 10-minute average price, or below
   the price now if that is better for you. The allowance is fixed once the
   vault exists
4. Read the line about who may earn the plan's fee: SPX holders can earn it
   for the first minutes after each buy falls due, then anyone can. The
   window is 30 minutes, or a quarter of the interval when that is shorter:
   75 seconds for a five-minute plan. In Expert you can choose it: 1, 5, 15,
   30 or 60 minutes, or a quarter of the interval, with any choice longer
   than a quarter of the interval greyed out. Shorter, your buy happens sooner
   when no holder is online; longer, holders have more time to earn your fee.
   Like the allowance, it is fixed once the vault exists
5. Read the **Cost** line. It gives the network fee for the one confirmation,
   then the **Buy fee**: in your currency when spDEX knows a price, in ETH, and
   as a share of the buy, never rounded down — `0.01` ETH a buy pays 0.0000439
   ETH, shown as 0.44% — with the rule that set it. The summary box says what
   goes in: every buy plus every buy's fee
6. Click **Create and fund vault**. Your wallet asks once: that one transaction
   creates the vault and sends the whole budget into it

The buy fee depends only on the amount, never on today's network fees, so two
identical plans pay the same: 0.0000189 ETH for one batched buy's network
cost, plus 0.25% of the buy, at most 0.69% (`packages/vault/src/fee.ts`). Try
a few amounts and watch the notes under the choice:

- under about 0.0015 ETH a buy, **Buys this small may be skipped**: the fee,
  0.69% of the buy, is less than a buy costs in network fees even when fees
  are low, so a keeper makes it only if it chooses to pay the difference
- under about 0.0027 ETH, **Small buys depend on low network fees**: the
  fee, held at 0.69%, is less than the network cost it is meant to cover, so
  it covers a keeper's cost only while fees stay low
- up to about 0.0043 ETH the fee is still 0.69% of the buy, less than the
  network cost and 0.25% that larger buys pay; from there up it is exactly
  that, growing with the buy, a smaller share the larger it is
- at any size, when network fees are very low, the form says that confirming
  each buy yourself costs less than the fee
- under 0.000001 ETH it refuses the plan

Keep each buy at 0.001 ETH or more on the fork, and your own keeper (below)
makes every buy.

### The vault's card

The plan appears in the **Auto-buys** tile, marked **Unaudited**:

- **Buys made**, **Next buy**, **Bought** and **Average rate**. These are read
  from the vault itself, not from this browser, so a reload shows the same
  figures
- **Vault** (its address, with **Copy**), **Holds** (what it has left, and how
  many buys that covers), **Buy fee** and **Price allowance**
- **History**, read from the vault's own logs when you open it. Each buy says
  who made it — you, a community keeper inside its window, or whoever made
  it after the window — and who was paid what ("triggered by a community
  keeper, paid 0x… its … WETH buy fee"). A buy someone else made with its fee
  paid back to you says so: inside the window anyone may make a buy that
  pays its owner. A v1 vault's history reads as it always has
- **Close and withdraw**, **Delete**, and a line saying why there is no pause.
  A vault holding less than every buy it has left, with their fees, also
  offers to top it up: **Fund … ETH** when it can't cover its next buy, **Add
  … ETH** otherwise
- A plan whose vault was never made (the wallet was declined, or the plan came
  from a link) offers **Create and fund vault** instead, with the **Price
  allowance** chips and the **Buy fee** it would be created with, and
  exactly what the confirmation sends. With no allowance this browser kept from
  the form, pick one: the card doesn't choose it for you

When a buy falls due, the card says it is waiting for a keeper, and for how
long holders have first claim: **Community window until 14:32, then open to
anyone.** Until then only an SPX holder's keeper can be paid for the buy;
after it, anyone can. **Trigger now** works inside the window too: it makes
the buy naming you as the one paid (`execute` with your own address), so your
wallet pays the network fee and the buy fee comes back to you as WETH. The
banner gives both figures. When the network fee is more than the buy fee, it
says so, and **Trigger now** is no longer the main button: a keeper making
the buy costs you less.

A v1 vault's card, from an earlier build, is as it was: no window, and
**Trigger now** pays whoever sends it, which is you.

### Watch a buy with spDEX closed

This is what a vault is for. On Ethereum an SPX holder's keeper may make each
buy inside its community window, and anyone's after it, many vaults at a time
through the batcher. On your fork nobody else is watching, so run a keeper
yourself. It needs Node 22.15 or later. `docs/KEEPER.md` has everything it can
do.

A keeper you start on the fork is never a community keeper: its fresh key
holds no SPX, and the fork can't prove a block it mined. So below it names
you, the vault's owner, as the one paid, which a v2 vault always allows:
it makes your buys inside their windows, and the fees come back to you.

1. Give the keeper a key of its own, with ether for gas. Don't use an anvil
   test key: those accounts pass on any ether they receive (see above)

   ```bash
   cast wallet new                  # prints an address and a private key
   pnpm dev:fund 0xKeeperAddress    # ether for its gas
   ```

2. Deploy the batcher, once per fork. Anyone may, and it lands at
   `0xd1f8327aa8398997bd88165f420412c703ebfed0` whoever sends it (the batcher
   every release from v2 on shares, at the address this source deploys to).
   It is bound to no factory, so it needs nothing deployed before it:

   ```bash
   SPDEX_KEEPER_RPC_URL=http://127.0.0.1:8545 SPDEX_KEEPER_KEY=0xTheKeeperKey pnpm keeper --deploy-batcher
   ```

   When it is done it says `every listed batcher whose factory is on this
   chain is deployed`, whether it deployed the batcher or found it there

3. Create a vault with a five-minute interval, as above, and close the spDEX
   tab. Its first buy falls due about 105 seconds after you create it, not at
   once: spDEX starts a plan whose community window is under three minutes
   that much later, so that a creation slow to sign and land still leaves its
   first buy a minute of first claim. Wait that long, and on the fork let a
   block come after it (step 6 shows how), before the next step
4. Run one tick of the keeper, limited to your vault and paying your wallet:

   ```bash
   SPDEX_KEEPER_SEND_WHEN=now SPDEX_KEEPER_RPC_URL=http://127.0.0.1:8545 \
   SPDEX_KEEPER_CONFIRMATIONS=1 SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS=0 \
   SPDEX_KEEPER_VAULTS=0xYourVault SPDEX_KEEPER_REWARD_TO=0xYourWallet \
   SPDEX_KEEPER_KEY=0xTheKeeperKey pnpm keeper --once
   ```

   `SEND_WHEN=now` sends as soon as a buy is due, rather than waiting for a
   cheap block; one confirmation, because the fork makes a block only when a
   transaction arrives; and no head-lag check, because the idle fork's latest
   block is days behind your clock. It prints one JSON line per record:
   `start`, `vault_found` with your vault's terms, `batch_sent`, then
   `batch_mined` with the transaction's `hash`, its `gasUsed`, and `earnedWei`,
   your vault's buy fee, paid by the vault to your wallet. The same lines go to
   a daily file in `.keeper/690069/`, beside its state. Add `--dry-run` to see
   what it would do without signing.

   Leave `SPDEX_KEEPER_REWARD_TO` out and the keeper is its own `rewardTo`,
   which the vault pays only once the window is over: inside it, the keeper
   logs `skip` `holders-first` and leaves the buy for when the window ends,
   which on the fork also takes a block after its end (step 6)
5. Open spDEX again. **Buys made** reads 1 of 3, and **History** shows the buy,
   made through the batcher inside its window, with its fee paid back to you
6. For the second buy, run the same command without `--once` and leave it
   running. **The fork makes a block only when a transaction arrives**, and a
   vault judges "due" by the latest block's time, so on an idle fork the next
   buy does not become due until some block comes after its buy time. On
   Ethereum a block comes every 12 seconds. Here, once the five minutes are
   up, make one:

   ```bash
   cast rpc evm_mine --rpc-url http://127.0.0.1:8545
   ```

   That mines one empty block at the fork's current time, without moving its
   clock. Any transaction does the same, a swap or `pnpm dev:fund` for
   instance. The keeper's next tick makes the buy. A community window ends
   the same way: only once some block's time is past it

The fork's clock started at the pinned block's time, days behind your
computer's, and runs at normal speed from there. The keeper's records carry
chain time. The card converts it to your time, so **Next buy** counts down
correctly either way.

With Docker, the same runs in the keeper's image, reaching the fork through
host networking (rootful Docker on Linux). Put the keeper's key in
`docker/keeper/secrets/fork_key` (`chmod 400` it), then from `docker/keeper`:

```bash
SPDEX_FORK_VAULTS=0xYourVault SPDEX_FORK_REWARD_TO=0xYourWallet docker compose --profile fork run --rm keeper-fork --once
```

The `fork` profile refuses to start without that allowlist, sends as soon as a
buy is due, deploys the batcher itself if it is missing, and uses no mainnet
setting; `SPDEX_FORK_REWARD_TO` is its name for `SPDEX_KEEPER_REWARD_TO`.
`docs/KEEPER.md` ("Trying it on the local fork") has the rest.
`pnpm keeper:smoke`, from the repository root, runs the whole round trip with
fresh keys and checks it.

### Help run the network, and community keeping

Community keepers make other people's buys and are paid for each one;
holding 690 SPX is the entry bar. **Help run the network**, at the foot of
the page, is the way to do it from a tab: once, when pressed, it makes the due
v2 buys of anyone's vaults from your own wallet, and they pay your wallet.

It sends only privately, so with MetaMask on the fork it asks you to turn
private sending on (see "What you will not be able to test"). With a wallet
that can sign privately, **See which buys are due** lists them. A buy still
inside its community window is offered only to an eligible wallet, and your
fork wallet isn't one, so for that buy it shows when holders' first claim
ends ("SPX holders have first claim until 14:32"), how far the wallet is from
the bar ("You hold 0 of the 690 SPX."), what community keepers are, and a
link to "Becoming a community keeper" when the build says where its source
is, with no button to make the buy. That holds for your own vaults' buys too:
**Trigger now** on their cards makes those. Once the window is over, and on the fork a
block has come after it, the same buy is offered to you as to anyone.

At its foot, **Community keeping** works without private sending, and reads
nothing until you open it. Open it with your wallet connected:

1. It says whether the wallet is eligible, until when, and how much SPX it
   holds against the 690. Swap ETH for 690 SPX or more (above) and look
   again: it holds enough now, and still isn't eligible. Holding is checked at
   the moment of each buy; proving that the wallet held the SPX when a block
   closed is a separate step, once a month.
2. **Prove my SPX** proves the `finalized` block, which on the fork is 64
   blocks behind the head: while fewer than 64 blocks have been mined since
   the fork started, a real mainnet block, at which your fresh wallet held no
   SPX; after that, a block the fork mined, which nothing can be proven
   against. So on the fork your own proof can't be made. Before a wallet's
   first proof, the panel says what proving makes public: worth reading
   before doing it on Ethereum.
3. **Prove another address** and **Paste a proof** are folds below it: the
   first proves any address from this wallet, so a holder's cold wallet never
   needs a browser; the second is for a network service that refuses
   `eth_getProof`.

`docs/KEEPER.md`, "Becoming a community keeper", is the rest: the three
steps on Ethereum, what proving costs and publishes, and what the 690-SPX bar
does and doesn't filter.

### Close it

**Close and withdraw** asks **Close this vault?** and says what comes back.
Confirm with **Close and withdraw**, then in your wallet, and everything the
vault holds comes back to your wallet as ETH. A closed vault can't be reopened,
so to buy again, start a new plan. **Delete** then removes the plan from the
list.

### Find a vault spDEX lost track of

A vault doesn't need spDEX to remember it. Delete its card, reset or replace
your settings, or open spDEX in another browser, and the vault still holds its
budget and buys whenever triggered. spDEX finds it again from the chain: with
your wallet connected, it asks each listed release's vault factory, v1's and
v2's, how many vaults you have created there and reads that factory's logs
for them.

1. Create a vault as above, then **Delete** its card. The card warns that the
   vault still holds WETH; click **Delete anyway**.
2. The card is gone, and in the **Auto-buys** tile a section appears: **Vaults
   on chain not in your plans**, with the vault, what it holds and how far it
   has got. Reload the page and connect again: it is still there, found from
   the chain alone.
3. **Close and withdraw** there works as on a card: confirm, then in your
   wallet, and everything it held comes back as ETH. Once you've read the
   result, a closed, empty vault moves to a collapsed **Closed vaults (1)**.
4. Or click **Add back to my plans**: the vault gets its card again, with a
   plan made from the vault's own terms, and the page takes you to it. Nothing
   is sent.

spDEX looks once when your wallet connects, and again when you click **Look
again**, which also reads every vault it knows again. On the fork it finds
everything in one query, and says when it last checked. A vault in your plans
counts as found; when your plans already hold every vault you've created, it
reads no logs at all. Hosted network services often cap how many blocks one
query may cover, so spDEX narrows its queries, stops after 40, and then says
**k of your N vaults aren't shown here** rather than pretending there are no
more: the factory's count says how many exist. A network service that serves
older records (your own node does) or a block explorer can find the rest; the
note gives every release's vault factory address to look for, v2's first.

### What a vault will not do

- **Buy without a keeper.** Nobody promises to trigger a buy. A buy time
  nobody triggers is skipped, never made up later, and the plan ends later
- **Hurry its community window.** When no SPX holder's keeper is about, a due
  buy waits out its window (at most an hour, at most a quarter of the
  interval), then anyone can make it; **Trigger now** makes it at any time,
  paid back to you
- **Pause.** Its terms are fixed in its code. **Close and withdraw** is the
  only stop, and it is final
- **Change.** The amount, the timing, the allowance, the community window and
  the buy fee are all fixed when the vault is created. A later release's fee
  reaches only vaults created after it, and there is no moving a v1 vault to
  v2: close it and start a new plan
- **Take more than 0.5 ETH.** The form refuses a plan whose buys and their
  buy fees add up to more
- **Buy anything but SPX, or pay with anything but ETH.** The factory's list of
  markets is fixed, and on Ethereum it has one entry
- **Stop when you delete the plan.** **Delete** only forgets the plan in this
  browser. The vault stays on chain and goes on buying whenever triggered, and
  the card warns if it still holds money. Close it first, or find it again
  (below)

## MetaMask alerts on the fee, or on HTTP

MetaMask may replace **Confirm** with a red **Review alert**, often with the
network fee highlighted. Click it, read the detail, and continue — the
transaction is fine. Two things provoke it, both artifacts of running a fork:

**The fee estimate does not match the chain.** This one comes from the fork's
URL having been added to MetaMask as Ethereum Mainnet's RPC rather than as a
network of its own. anvil's blocks are nearly empty, so EIP-1559 drives the
base fee to almost nothing — typically under 1000 wei against mainnet's
billions — while MetaMask, believing it is on Ethereum Mainnet, prices gas from
its own mainnet gas service rather than from the node. The two disagree wildly,
and it says so. Adding the fork as its own network, as above, makes MetaMask
take gas data from the node, and the alert goes away.

**The dapp is served over HTTP.** `localhost:5173` has no TLS, which MetaMask
flags on principle. Correct in general, irrelevant here.

Neither affects execution.

## Resetting

The fork accumulates your trades. To start over, stop `pnpm anvil:fork` and
start it again — it re-seeds from the pinned block, so prices return to exactly
where they were.

spDEX's own state lives in the browser, not the fork: your settings, auto-buy
plans and the record of what they bought, in local storage. A restarted fork
forgets every transaction — your trades and `dev:fund` included — but the
browser still remembers the plans. Delete them, or clear this site's data, to
start from nothing.

A restarted fork also forgets the SPX holder registry, the vault factory, the
batcher and every vault on it, along with what they held and bought. A vault plan's card then says
there is no vault at its address; delete the plan. The first vault on the new
fork needs **Set up vaults on this network** again, and a keeper needs `pnpm
keeper --deploy-batcher` again. A keeper's state in `.keeper/690069/` belongs
to the old fork — its nonce and its latest block are ahead of the new one's —
so run the keeper once with `--reset-state` added, which moves the state file
aside and starts fresh.

**Reset to recommended** (Settings → **Settings file**) restores the preset
without losing your network service. If you have auto-buys it asks first
(**Remove auto-buys?**). A vault plan whose vault may still hold money or buy
stays, and the question says so.

## What you will not be able to test

- **Private sending** needs a wallet that signs without broadcasting
  (`eth_signTransaction`). MetaMask refuses, so spDEX asks before broadcasting
  publicly (**Can't send privately**) rather than doing it quietly — which is
  itself worth seeing. Auto-buys never take that way out: a wallet-mode buy
  that can't be sent privately is skipped instead. And the relays are services
  on the real network that know nothing of your fork, so leave Private sending
  off while trying auto-buy
- **The built-in network service** is allowlisted to the production origin, so
  locally you always supply your own. See `docs/RPC-RUNBOOK.md`
- **Strangers' keepers.** Nobody else watches your fork, so a vault's buys
  happen only when you press **Trigger now** or run `pnpm keeper`
- **Being a community keeper.** Proving needs a block whose state the fork
  can show truly, and the fork can't prove a block it mined; your fresh
  wallet held no SPX at any block before them. So no wallet of yours is
  eligible on the fork, Help run the network offers you a v2 buy only once
  its window is over, and a keeper you run makes buys inside their windows
  only by paying their owner (above). The repository's tests reach the
  eligible paths with proofs recorded from mainnet instead
  (`docs/DEVELOPMENT.md`, "Proofs, and how long a fork stays useful for
  them")
