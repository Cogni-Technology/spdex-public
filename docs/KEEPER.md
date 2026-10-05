# Running a keeper

A spDEX auto-buy vault holds its owner's plan and budget and enforces the
plan itself, but a contract cannot wake itself up: somebody has to send the
transaction that makes each due buy happen. That somebody is a **keeper**. It
finds vaults whose buy is due, makes many of those buys in one transaction
through the batcher contract, and is paid each vault's **buy fee** for it.

A keeper needs nobody's permission and holds nobody's money. It chooses
*when* a due buy happens and, for a v2 vault, which address the vault pays
its fee to (`rewardTo`); the vault fixes the amount, the token, the price
floor and where the tokens go, and refuses anything else. What a keeper
risks is its own: the gas it spends, and the hot key it signs with. Nothing
obliges anyone to run one, spDEX's developers included, and a buy time nobody
triggers is skipped.

Vaults come in two releases, and a keeper serves both. A **v1** vault (the
first release, live since 2026-10-01 and unchanged for good) pays whoever
makes its buy, at any time the buy is due. A **v2** vault gives SPX holders
first claim: for the first minutes after each buy falls due (its **community
window**, 30 minutes by default), its fee can be paid only to an address that
holds 690 SPX and has proven it, or back to the vault's owner; after that,
anyone can make the buy, exactly as in v1. Community keepers make other
people's buys and are paid for each one; holding 690 SPX is the entry bar.

This guide sets one up with Docker in five steps, then explains how to become
a community keeper, what a buy pays and costs, how to keep it safe, and every
setting.

You don't need a keeper to make a due buy now and then: an open spDEX tab can
do it from your own wallet ([From a tab, without a keeper](#from-a-tab-without-a-keeper)).
A keeper is for keeping vaults buying while nobody has spDEX open.

- [Quick start](#quick-start)
- [Becoming a community keeper](#becoming-a-community-keeper)
- [How it earns, and what it costs](#how-it-earns-and-what-it-costs)
- [Keeping the key and the fees safe](#keeping-the-key-and-the-fees-safe)
- [Private orderflow](#private-orderflow)
- [From a tab, without a keeper](#from-a-tab-without-a-keeper)
- [When it sends](#when-it-sends)
- [Watching it](#watching-it)
- [The report](#the-report)
- [Deploying a batcher](#deploying-a-batcher)
- [A standby keeper](#a-standby-keeper)
- [Upgrading](#upgrading)
- [Verifying the contracts](#verifying-the-contracts)
- [Trying it on the local fork](#trying-it-on-the-local-fork)
- [Without Docker](#without-docker)
- [Advanced settings](#advanced-settings)
- [Troubleshooting](#troubleshooting)

## Quick start

You need Docker 24 or later with Compose v2 (Linux, macOS, or Windows with
WSL2, since the commands are a POSIX shell's; amd64 or arm64), an Ethereum
JSON-RPC endpoint (a hosted free tier is enough), about
0.02 ETH for gas, and an address of your own whose key is **not** on this
machine, to be paid the fees. To make v2 buys inside their community windows,
that address also holds 690 SPX and is proven once a month
([Becoming a community keeper](#becoming-a-community-keeper)); without that,
the keeper still runs, and leaves those buys to holders until each window
closes.

**1. Get the code, and make your settings file.**

```bash
git clone https://github.com/Cogni-Technology/spdex-public.git spdex
cd spdex/docker/keeper
sed "s/^KEEPER_UID=.*/KEEPER_UID=$(id -u)/; s/^KEEPER_GID=.*/KEEPER_GID=$(id -g)/" .env.example > .env
```

The keeper runs as your own user, so it can read the files you are about to
make without root.

**2. Make the keeper's key, and tell it your endpoint.**

```bash
docker run --rm node:22.23.2-bookworm-slim node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > secrets/keeper_key
echo 'https://your-endpoint.example/your-api-key' > secrets/rpc_url
touch secrets/send_url secrets/heartbeat_url secrets/report_rpc_url
chmod 400 secrets/*
```

`openssl rand -hex 32 > secrets/keeper_key` does the same as the first line,
where `openssl` is installed. The key never leaves this machine, and nothing
prints it. The three empty files are optional settings, empty for none: a
private send endpoint ([Private orderflow](#private-orderflow)) — which you
should use — a dead-man's switch ([Watching it](#watching-it)), and an
endpoint of the report's own ([The report](#the-report)).

An endpoint on this machine (a node of your own) is not `127.0.0.1` inside
the container, which is the container's own: write
`http://host.docker.internal:8545`, have the node listen on an address the
container can reach, such as Docker's bridge (`172.17.0.1` on Linux), not
only on `127.0.0.1`, and let the host's firewall accept the port from Docker.

**3. Fund it.**

```bash
docker compose run --rm keeper --print-address
```

The first run builds the image (a minute or two), then prints the keeper's
address and where its fees go. Send the keeper address about **0.02 ETH**: it
pays for gas and is the only money this machine holds.

**4. Say where the fees go.** In `.env`, set `SPDEX_KEEPER_REWARD_TO` to your
own address (a hardware wallet, say) — not the keeper's. To be a community
keeper, make it a wallet kept for the SPX rather than your main one, and an
ordinary account, not a contract or a smart wallet: the next section says why.
Run step 3's command again to see it.

**5. Start it.**

```bash
docker compose up -d --build
docker compose logs -f keeper
```

It starts, finds every vault each listed release's factory lists, and waits
for due buys and a cheap block. Every decision is a line of JSON in the log; a keeper that did
nothing says why. It restarts itself after a crash or a reboot
(`restart: unless-stopped`). Stop it with `docker compose stop`: it finishes
the tick in progress and saves its state first.

> Until a release's contracts are on mainnet, the keeper stops at step 5 with
> "there is no spDEX vault factory at … on chain 1" (and Docker keeps
> restarting it; `docker compose down` stops that). v2's SPX holder registry,
> factory and batcher have addresses this source deploys to, but are not on
> mainnet until its release (`docs/RELEASE.md`); until then, run the keeper
> from v1's release tag (`git checkout v1-prototype`), which serves v1's
> vaults. Once a release is on mainnet, anyone may deploy its
> batcher; if nobody has yet, the keeper says so, and
> [Deploying a batcher](#deploying-a-batcher) takes one command.

## Becoming a community keeper

Community keepers make other people's buys and are paid for each one;
holding 690 SPX is the entry bar. Inside a v2 buy's community window the vault
pays its fee only to its owner or to an address the SPX holder registry finds
eligible, so a keeper whose `rewardTo` is eligible makes those buys while
other keepers, and outside bots, wait for the window to close. v1 vaults have
no window, and a keeper needs none of this to serve them.

**The window.** It opens when a buy falls due and lasts the vault's
`communityWindow`, fixed when the vault was made like every other term: 30
minutes by default, a quarter of the interval for plans that buy more often
than every two hours, never less than 60 seconds or more than an hour
(`MIN_COMMUNITY_WINDOW` and `MAX_COMMUNITY_WINDOW` in
`packages/vault/contracts/VaultLimits.sol`). A five-minute plan's is 75
seconds. A buy falls due at the start of its slot, or half an interval after
the last buy if that is later, so every slot's buy has a window of its own,
the first one after a missed slot included (`test/forge/Window.t.sol`).
Within the window, eligible keepers race: the first to land the buy is paid,
and a revert-protected endpoint drops the loser's batch at no cost
([Private orderflow](#private-orderflow)). After it, anyone can make the buy,
a bot included.

**What makes an address eligible.** The registry
(`packages/vault/contracts/SpxHolderRegistry.sol`) answers for `rewardTo` at
the moment of each buy, and says yes only while three things are true:

1. It was **proven** to hold at least 690 SPX at the end of a block, and that
   block's time is at most 30 days ago (`PROOF_TTL`).
2. It **holds** at least 690 SPX now.
3. It is an **ordinary account**: no code, or only an EIP-7702 delegation. A
   contract is never eligible, because a contract can hand what it is paid to
   whoever asks: Uniswap v2's SPX pair, which held 13 million SPX at the
   pinned block, would hand a fee paid to it to any caller
   (`test_aProvenContractThatHandsOutWhatItIsPaidIsNeverEligible`). So SPX
   in a Safe or another smart wallet cannot make that wallet a community
   keeper: name an ordinary account that holds 690 SPX of its own.

There is no list, no deposit and no lock. The SPX stays in the wallet, and
the registry stores one date per address that has proven, and nothing else.
Nobody can change it: 690 SPX (`MIN_SPX`) and 30 days are constants in its
code, and it has no owner.

**Three steps.**

1. **Put 690 SPX in a wallet kept for it**: an ordinary account whose key is
   not on the keeper's machine (a hardware wallet suits), kept apart from
   your main wallet for the reason under "What proving makes public" below.
   This wallet is your `rewardTo`: it is paid every fee, and it is the
   address that must be eligible.
2. **Prove it, once a month.** A proof is one transaction to the registry. It
   carries the `finalized` block's header and two Merkle proofs read with
   `eth_getProof`, which together show the wallet's SPX balance at that
   block; the registry checks the header against the block's real hash
   before believing any of it. Anyone may send anyone's proof, and it moves
   no money. Two ways:
   - In spDEX: **Help run the network** → **Community keeping**, with the
     wallet connected, **Prove my SPX**. Or, from any other wallet (a hot
     browser wallet paying the gas), **Prove another address**, so the cold
     wallet never touches a browser. When your network service refuses
     `eth_getProof`, the panel shows the requests to run against another
     service and checks the proof you paste back against your own service's
     block hash before sending it.
   - From the keeper: `SPDEX_KEEPER_PROVE=1` (off by default) has it prove
     `rewardTo` when it has no proof, and again once its proof has five days
     or less left. The hot key pays the gas; the SPX never leaves the cold
     wallet. Its endpoint
     must answer `eth_getProof` for the `finalized` block
     (`docs/RPC-RUNBOOK.md`, "Proving SPX held: `eth_getProof`", says which
     services do).

   A proof costs about 655,000 to 685,000 gas as a transaction, 520,000 to
   550,000 of it the registry following the two proofs
   (`test/forge/Registry.t.sol`): about 0.00007 ETH at 0.1 gwei, once every
   30 days. The `finalized` block is about 13 minutes old, so SPX that has
   just arrived can be proven a quarter of an hour later. A proof that would
   not move the wallet's expiry later reverts with `NotNewer`, and a
   revert-protected endpoint drops it unpaid.
3. **Run a keeper** with `SPDEX_KEEPER_REWARD_TO` set to that wallet
   ([Quick start](#quick-start)), or press **Help run the network** in an
   open tab, which pays the connected wallet
   ([From a tab, without a keeper](#from-a-tab-without-a-keeper)).

**The SPX stays in the wallet kept for it.** Eligibility is judged on
`rewardTo`, the address paid, never on the key that signs. So `rewardTo` is
cold: it holds the SPX and receives every fee. The keeper's hot key holds
only gas money, and nothing on its machine can move the SPX. Leaving
`SPDEX_KEEPER_REWARD_TO` empty makes the keeper its own `rewardTo`, which
would then have to hold and prove the 690 SPX on the machine that signs:
don't.

**What proving makes public.** A proof emits `Proven`, which says, for good,
that the address held at least 690 SPX at that block. Since anyone may prove
any address, that alone says nothing about who keeps. Your keeper's buys do:
each batch names `rewardTo` in its calldata beside the hot key that sent it,
so once the keeper sends buys, the wallet holding your SPX and your keeper's
key are linked in public. That is why the SPX goes in a wallet kept for it,
not your main one. The app says so before a wallet's first proof.

**When a proof lapses.** A proof lasts 30 days from the proven block's time,
through its last second. The keeper logs when its `rewardTo`'s proof will
lapse, whether or not it proves, and the app's panel shows a banner from five
days before. A lapsed or missing proof, or SPX moved out of the wallet, does
not stop the keeper: it leaves in-window buys to holders, and makes them after
their windows like any other caller.

**Gas money, and topping it up.** With a cold `rewardTo` the hot key spends
and never earns anything back: every batch's gas, and each proof's when it
proves, come out of its balance. The keeper works out its runway, the days of
sends its balance covers at its recent spend, measured over the time that
spend covers, at most the last week, and unknown in its first day
(`runwayDays` in the heartbeat, [Watching it](#watching-it)). It logs it,
puts it in the report, and warns (`low_runway`) when it falls below
`SPDEX_KEEPER_MIN_RUNWAY_DAYS` (7 days by default). Top it up
by hand: send the keeper's address ether from a wallet that isn't on its
machine. Nothing tops it up by itself. A batcher that refunded its caller's
gas out of the fees would put WETH back through the batcher, which v2 took
out (`docs/V2_UPGRADE.md`, "Considered and not chosen").

**What the bar does and doesn't filter.** A proof reads a block's final
state, so SPX borrowed and repaid inside one transaction never appears in
one: to prove, an address must really have held 690 SPX when a block closed.
The check at the moment of a buy is different: SPX borrowed inside the buying
transaction meets it. Uniswap v4's `PoolManager` lends within a transaction
for no fee, and one borrow can wrap a whole batch. On a fork of the pinned
block, a 690-SPX borrow around five in-window buys made all of them for a
proven address that held no SPX, for 42,648 gas more and no fee
(`test/forge/FlashBorrow.t.sol`; the `PoolManager` held 119,766 SPX there).
So what the bar really checks is "held 690 SPX at the end of some block in
the last 30 days", and nothing stops a bot that buys 690 SPX from keeping like
anyone; inside each window the fastest eligible keeper wins.
`docs/THREAT-MODEL.md`, "The community window and the SPX holder registry",
has the rest of what the window does and doesn't stop. The report publishes how concentrated window buys are
([The report](#the-report)): if one `rewardTo` wins more than half of them
for 30 days, sharing them out by turns among holders is formally reconsidered
(decision 29 there), and spDEX's developers' keeper counts like anyone's.

## How it earns, and what it costs

**What it is paid.** Every vault's buy fee (`keeperReward`) is written into the
vault when its owner creates it, and nobody can change it afterwards, spDEX
included. For a v2 vault, spDEX's app proposes:

```
buy fee = 126,000 gas × 0.15 gwei (0.0000189 ETH)  +  0.25% of the buy
          but never more than 0.69% of the buy
```

126,000 gas (`BATCHED_BUY_GAS` in `packages/vault/src/fee.ts`) is one buy's
share of a batch of ten, measured with the community window's check
(`test/forge/BatchGas.t.sol`). 0.15 gwei (`FEE_NETWORK_REFERENCE`) is a fixed
reference for what keepers pay across cheap and deadline sends, so two
identical plans always pay the same fee whenever they were made. The 0.25% is
what the work is paid beyond its gas. 0.69% is the contract's own limit
(`MAX_REWARD_BPS`), the network cost included: the factory refuses a vault
that would pay more, so no vault it lists ever does. At ETH at $2,643.94, with
shares rounded up as the app shows them:

| Buy | Buy fee (wei) | Fee | Share of the buy |
|---|---|---|---|
| $1 | 2,609,741,522,122 | $0.0069 | 0.69% (the ceiling) |
| $5 | 13,048,707,610,611 | $0.0345 | 0.69% (the ceiling) |
| $10 | 26,097,415,221,222 | $0.0690 | 0.69% (the ceiling) |
| $25 | 42,538,963,062,702 | $0.1125 | 0.45% |
| $69 | 84,143,538,053,058 | $0.2225 | 0.33% |
| $250 | 255,289,630,627,019 | $0.6750 | 0.27% |

The ceiling holds the fee down for buys under about 0.0043 ETH ($11.36);
above that the fee grows with the buy, a smaller share the larger it is. The
fee is the same inside the community window and after it.

v1 vaults keep the fee they were made with, for good. The v1 app proposed one
batched buy's network cost at 122,000 gas, and a tenth more: 0.00002013 ETH,
or 0.69% of the buy where that is less (every v1 buy from about $7.71 up pays
the same 0.00002013 ETH).

A v2 vault pays its fee straight to `rewardTo` as WETH, in the same
transaction as the buy. A v1 vault pays its caller, v1's batcher, which passes
the fees on to `rewardTo` before the batch ends.

**What it spends.** Gas: about 110,000 a buy (106,000 for a v1 buy, which
asks no registry) plus 160,000 a batch (a plan's first buy costs 51,000
more; `BATCH_PER_BUY_GAS`, `BATCH_FIXED_GAS` and
`BATCH_FIRST_BUY_EXTRA_GAS` in `fee.ts`), at whatever the network charges when
it sends. So what a keeper keeps from one buy is

```
buy fee − (110,000 + 160,000 / buys in the batch) × the fee per gas it paid
```

For example, a $25 buy in a batch of ten, sent at a cheap block (0.083 gwei,
`FEE_CHEAP_REFERENCE`: a low base fee of 2026-09-24's week plus the patient
tip): its fee is 0.0000425 ETH ($0.112), its share of the batch's gas costs
126,000 × 0.083 gwei = 0.0000105 ETH ($0.028), and the keeper keeps
0.0000321 ETH ($0.085) for making it. The
same fee covers that buy's gas up to about 0.34 gwei in a batch of ten, and
0.16 gwei sent alone (270,000 gas). Under the ceiling it covers less: a $5
buy's 0.0000130 ETH pays its batched gas only below about 0.10 gwei. This is
what one buy pays and costs at a stated fee per gas, not a forecast: what a
keeper actually made is in [the report](#the-report), after the fact.

**By default a keeper never plans a loss.** It prices each batch at the next
block's base fee plus 12.5% plus its tip. A buy whose fee covers its own gas
goes in. One whose fee falls short — a $1 buy's at almost any block, a $5
buy's from a median block up — rides along only when the batch's other fees
cover the difference, and only if it is at
least 0.0003 ETH, at most hourly, and pays the fee spDEX proposes for its
size and its release: a vault that set itself a lower fee pays its own way or
waits. A batch whose fees can't cover its fixed cost waits. Losses can still
happen when a block turns out dearer than planned, so a circuit breaker stops
all subsidy and widens the margin once realised losses reach 0.002 ETH in 24
hours.

v1's fee is close to cost on purpose, so a default keeper makes a v1 buy only
at a cheap block in a batch large enough to pay for itself, and a v1 buy
whose time runs out first is skipped. A v2 buy above the ceiling pays its own
gas in a batch of ten at most blocks a keeper sends in; one below it, like a
v1 buy, depends on cheap blocks and shared batches.

**A subsidy, if you choose one.** Some operators want buys made even when the
fees fall short — spDEX's developers may, during the prototype. Set
`SPDEX_KEEPER_MAX_LOSS_PER_BUY_ETH` (the `.env` file shows one operator's
choice) and the keeper will pay the difference, within caps: per buy, per
vault per day (0.0001 ETH), per owner per day (0.0002 ETH) and per day
overall (the breaker). Each vault is helped only within its own caps and its
own share of the gas, never on another vault's allowance. The same buys
qualify as above, so a flood of dust vaults gets nothing, and subsidy goes to
the oldest vaults first, so new ones cannot crowd out existing users.

**A keeper for your own vaults.** Put your vaults' addresses in `.env` as
`SPDEX_KEEPER_VAULTS`, comma-separated, and the keeper reads and triggers
only those. Set `SPDEX_KEEPER_REWARD_TO` to the address that owns them: a v2
vault may always pay its own owner, inside its window or after it, so the
keeper makes their buys inside their windows, as an eligible keeper does,
without holding any SPX, and every fee comes back to you. To have it make their buys even when their
fees fall short, set
`SPDEX_KEEPER_MAX_LOSS_PER_BUY_ETH` and raise the per-vault and per-owner caps
(`SPDEX_KEEPER_MAX_LOSS_PER_VAULT_PER_DAY_ETH`,
`SPDEX_KEEPER_MAX_SUBSIDY_PER_OWNER_DAY_ETH`) to what you will pay a day;
`SPDEX_KEEPER_SUBSIDY_MIN_BUY_ETH=0` and
`SPDEX_KEEPER_SUBSIDY_MIN_INTERVAL_SECONDS=0` let in buys smaller than 0.0003
ETH or more often than hourly. A buy sent on its own costs about 270,000 gas
(321,000 for a vault's first), and its buy fee comes back to `rewardTo`.

**Other costs.** A computer that stays on (the container is limited to 256 MB
of memory and uses far less), and endpoint requests: about 52,000 compute
units a day with 10 active vaults and 107,000 with 200, a few percent of a
hosted free tier (measured before v2; a v2 keeper also reads its `rewardTo`'s
standing with the registry every tick, two more requests, and, proving, one
`eth_getProof` a month). The
keeper never uses `eth_getLogs`. Anyone can create
vaults, funded or not, and a keeper reads every one its factory lists; one
that cannot pay for its next buy costs only a balance read each pass, 200 to
a request, and a full read hourly.

## Keeping the key and the fees safe

- **A hot key, a cold `rewardTo`.** The key in `secrets/keeper_key` signs every
  batch, so it must be on this machine; keep only gas money there. Fees go to
  `SPDEX_KEEPER_REWARD_TO`, whose key should be anywhere else, and a community
  keeper's 690 SPX stay there too
  ([Becoming a community keeper](#becoming-a-community-keeper)). The hot key
  then earns nothing back, so watch its runway and top it up by hand. If you
  leave `SPDEX_KEEPER_REWARD_TO` empty, fees go to the keeper itself, which
  then unwraps its WETH for gas whenever it runs below `SPDEX_KEEPER_MIN_ETH`;
  it could then make v2 buys inside their windows only by holding and proving
  690 SPX on this machine.
- **The files.** `chmod 400 secrets/*`, owned by you; the keeper runs as your
  uid (`KEEPER_UID`, `KEEPER_GID`), so no other user and no root process is
  needed. It warns (`warn key-permissions`) if the key file is readable by
  others. The secrets are mounted read-only and never copied into the image
  or the logs.
- **What it will sign**, and nothing else — `assertKeeperMaySign` refuses any
  other transaction before the key is used:
  - `executeBatch` to a batcher listed in `packages/vault/deployments.json`,
    paying the configured `rewardTo`, decoded with that batcher's own ABI, and
    from v2 on giving each vault exactly `SPDEX_KEEPER_GAS_PER_VAULT`, sending
    no ether;
  - the one-time deployment of a listed batcher, through the deterministic
    deployer, only where its source's code lands at the listed address;
  - a cancel: an empty transfer of 0 ETH to itself;
  - `WETH.withdraw`, only when `rewardTo` is the keeper itself;
  - only with `SPDEX_KEEPER_PROVE=1`, `prove` to a listed release's SPX holder
    registry for the configured `rewardTo` and no other holder, sending no
    ether.
- **What it contacts:** your endpoint (`secrets/rpc_url`), your private send
  endpoint if you set one, and your dead-man's switch if you set one. Nothing
  else, ever: no telemetry, no update check, nothing that phones home. It
  listens on no port.
- **What it logs.** Hashes, addresses and amounts are checked and written as
  they are. Free text (an error's message, a skip's detail) is scrubbed of the
  key, every configured URL and the parts of one an error might quote (host
  and path, long path and query segments), then of anything still shaped like
  a URL or a 64-digit hex string. Neither the key nor a URL is ever printed.
- **The container** runs as your uid, with a read-only filesystem, every Linux
  capability dropped, `no-new-privileges`, and a memory limit. The image is
  built from an allow-list of the repository's files (the root
  `.dockerignore`), so no `.env` file, key or report can enter it; `pnpm
  keeper:smoke` checks its files and history for them.
- **One signer per key.** A lease file in the data directory stops a second
  keeper on the same data from signing. Two machines with one key are not
  supported: they would race each other's nonces. Use a
  [standby keeper](#a-standby-keeper) with its own key instead.

## Private orderflow

Without one, batches go to the public mempool, where anyone can copy a
batch's calldata with their own `rewardTo` and a higher tip and take its fees
(yours then reverts, costing gas), and a large batch invites a sandwich.
Inside a v2 buy's window the copier's `rewardTo` must be eligible too, so
there the race is among holders; after it, and for v1 buys, it is open to
anyone. The keeper warns (`warn public-mempool`), sends `minRewards = 0`, and
limits each public batch to buys totalling 0.1% of a pair's WETH reserve.

A private, revert-protected endpoint avoids all of that: a transaction that
would revert is dropped instead of mined, so a lost race costs nothing, a race
with another community keeper inside a window included, and the keeper can
ask the batcher for a minimum (`minRewards`) below which the whole batch
reverts and is dropped. Two such endpoints:

- MEV Blocker: `https://rpc.mevblocker.io/noreverts`
- Flashbots Protect: `https://rpc.flashbots.net/fast`

Both are third parties you choose to trust with your transactions before they
are public; spDEX has no arrangement with either. Put the URL in
`secrets/send_url` (`chmod u+w` it first, and 400 again after) and restart
the keeper with `docker compose up -d --force-recreate`. It is used for
sending only — reads still go to `secrets/rpc_url` — and the keeper never
falls back to the public mempool when it fails. If your send endpoint is
private but does not drop reverting transactions, set
`SPDEX_KEEPER_SEND_PRIVATE=0`. (Set to `1` with no send endpoint, it is
refused: every send would go to the public one.)

## From a tab, without a keeper

Anyone with spDEX open can make the v2 buys that are due right now, once, from
their own wallet: **Help run the network**, at the foot of the page. It uses
the shared batcher and the keeper's own selection (`selectBatch` from
`keeper-plan.ts`, as a private send that plans no loss, at most 20 vaults),
and names the connected wallet as `rewardTo`, so the buy fees go to the wallet
that sends it. v1 buys are left to keepers and outside callers. It differs
from a keeper in what it will do:

- **Holders first, inside a window.** A buy still inside its community window
  is offered only to a wallet the registry finds eligible, with its proof
  still valid a block later; a wallet's own vaults are no exception (their
  cards' **Trigger now** makes those). Any other wallet sees when holders'
  first claim ends ("SPX holders have first claim until 14:32."), why it
  isn't a community keeper (a contract; how far it is from the bar, "You
  hold 120 of the 690 SPX."; a proof never made or lapsed) and a link to this
  page's [Becoming a community keeper](#becoming-a-community-keeper) when the
  build says where its source is, with no button to make the buy. A buy past
  its window is offered to anyone.
- **Private sending only.** It is offered only when the app sends privately
  (Settings → Sending), to a relay such as the two above, and it never falls
  back to the public mempool: there, a batch worth making is exactly the kind
  bots copy. The wallet has to be able to sign without broadcasting
  (`eth_signTransaction`); one that can't is told so, and nothing is sent.
- **Only when the fees cover the cost.** The gas price is read once and is
  the price signed. The batch is test-run from the wallet at the gas limit it
  will be signed with, and offered only when the fees it earns there reach
  `minRewards` = the test-run's gas × 1.1 × that price. `minRewards` goes on
  chain, so if someone makes the buys first, or they earn less, the batch
  reverts instead of paying less; a revert-protected relay then drops it for
  nothing, and one that isn't charges its network fee. The panel says which,
  going by the relay's address alone: only `rpc.flashbots.net` (or its
  `/fast` form) and `rpc.mevblocker.io/noreverts`, with no query, count as
  dropping failing transactions.
- **Checked by the Guard, like every transaction the app sends.** The batch
  goes to the factory's own batcher, pays nobody but the sending wallet (a
  batch naming any other `rewardTo` is refused), and is never signed without
  a test-run (with a second opinion too, when one is set). No WETH passes
  through v2's batcher: each vault pays the wallet directly. A batch whose
  `minRewards` doesn't cover the gas the Guard's own test-run of it used at
  the signed price is refused.
- **Once, when pressed.** Nothing runs in the background, and nothing is read
  about the wallet until **See which buys are due** is pressed. The wallet's
  address becomes public as the one that made the buys.

A settled batch is kept in the browser's records as buy fees received (Your
activity, its CSV and statement), never as a buy.

**Community keeping**, a closed fold at the foot of Help run the network,
reads nothing until it is opened, and works without private sending. It
shows whether the connected wallet is eligible, until when, and how much SPX
it holds against the 690. **Prove my SPX** is offered to an ordinary account
holding 690 SPX whose proof is missing or has five days or less left. It
builds the proof in the browser from your network service's `eth_getProof`
and its `finalized` block, refuses to send unless the rebuilt header hashes
to that block's real hash, and sends one transaction, checked by the Guard
like any other: it may go to the release's registry only, with no ether.
With private sending on and a wallet that can't sign for it, the panel asks
before sending a proof publicly; it never does so by itself. **Prove another
address** does the same for any address you type, and **Paste a proof**
takes the answers of another service when yours refuses `eth_getProof`; both
are refused in words for a contract, or for an address holding less than 690
SPX now. Unless a wallet is known to have proven before, the panel first says
what proving makes public. From five days before a proof lapses it shows a
banner and, while spDEX is open and you have ticked its box, a browser
notification of its own, which, like a due buy's, fetches nothing.

## When it sends

A plan buys once per slot of its interval (a day, for a daily plan). The
report and the log call a slot a *window* (`windows.csv`, `window_missed`),
a name from before v2; a v2 vault's **community window** is the first part
of a slot, and this page always calls it that.

**For a v1 buy, and for a v2 buy once its community window is over,** the
keeper does not have to buy at the slot's first second, so it waits for a
cheap block:

- Early in a slot only a really cheap block qualifies (the 10th percentile of
  the last day's base fees); the bar rises to the 60th percentile by the
  deadline.
- The **deadline** is a margin before the slot ends: 20% of the interval,
  between 60 seconds and 2 hours — two hours for a daily plan, twelve minutes
  for an hourly one. From then on the buy is urgent and goes at whatever the
  fee, with a higher tip (0.1 gwei, rising 1.5× with each resend up to
  0.5 gwei), never above `SPDEX_KEEPER_MAX_FEE_GWEI` (3 gwei).
- Plans shorter than an hour are sent as soon as they are due.

**Inside a v2 buy's community window**, what it does depends on whether its
`rewardTo` may be paid there: eligible with the registry, read every tick and
counted only while its proof is still valid a block (12 seconds) after the
read, or the vault's own owner.

- **Eligible**, it makes the buy inside the window at once, without waiting
  for a cheap block, sending with the patient tip (`SPDEX_KEEPER_TIP_GWEI`,
  0.02 gwei), and does not raise it to beat another holder to the buy. In the
  window's last two minutes (the last quarter of a window shorter than eight
  minutes: 18 seconds of a five-minute plan's 75) it switches to the urgent
  tip above, because once the window ends anyone, bots included, may take the
  buy. A buy inside its window is priced by the window alone, whatever
  `SPDEX_KEEPER_DEADLINE_SHARE` says, and never rides in a batch with an
  urgent buy that would lend it the urgent tip. Holders bidding against each
  other through private relays would hand the fee's margin to block builders;
  a keeper that bids higher can still win, but the stock one doesn't start
  that auction.
- **Not eligible**, it leaves the buy to holders (`skip holders-first`) and
  plans its next tick for the window's end. From then on the buy is open to
  anyone, and the rules above apply. A buy whose slot ends within a block is
  left too: it would land as the next slot's buy, inside that slot's window.
- A vault that refuses with `NotEligible` (the proof lapsed, or the SPX
  moved, since the keeper last read the registry) rests until its window
  ends, and the keeper reads its standing again. That is neither a trap nor a
  failure.

Whatever the release:

- v1 and v2 vaults never share a batch: each batch goes to its own release's
  batcher.
- A batch not mined within a few blocks is rebuilt from fresh reads and
  resent at the same nonce with higher fees; a public one with nothing left
  worth buying is cancelled. A batch carrying a buy inside its community
  window is the exception: until the window's urgent part begins it is
  rebroadcast as it was, never bid up, and rebuilt or withdrawn only when its
  buys were made by someone else first.

Every batch is simulated at the fee it will pay first, with an explicit gas
limit (never `eth_estimateGas`), so each vault gets its full gas cap.

## Watching it

- **The log**: `docker compose logs -f keeper`, one JSON record per line
  (`start`, `wait`, `skip`, `batch_sent`, `batch_mined`, `heartbeat`, `error`
  and so on). The same records go to daily files in the data directory,
  `/data/keeper-YYYY-MM-DD.jsonl`, which the report reads. An `eligibility`
  record says, at start, whenever it changes and once a day besides, whether
  `rewardTo` may be paid inside v2 windows, until when its proof lasts, how
  much SPX it holds, whether it is an account, and if not eligible, why
  (`not-proven`, `lapsed`, `contract` or `below-minimum`). With proving on,
  `prove_sent` and `prove_mined` follow each proof, and `prove_skipped` says,
  once until the reason changes, why a proof was not sent: `unsupported` (the
  endpoint won't answer `eth_getProof` for the `finalized` block),
  `below-min-spx`, `header-mismatch`, `contract`, `not-newer` (a proof as new
  is already recorded), `refused` (its test-run reverted), `gas` (it asked for
  more than 750,000), `fees-above-max`, `low-balance`; or why one in flight
  was withdrawn: `not-newer` (another proof landed first), `off` (proving was
  turned off) or `other-holder` (`rewardTo` changed). `low_runway` is logged
  once each time the runway falls below the threshold.
- **The heartbeat**: `docker compose exec keeper cat /data/heartbeat.json`,
  rewritten after every tick. `ok` says whether the last tick worked; `phase`
  is `syncing` until it has read every factory's list; `runwayDays` is how
  long its ether lasts at its spend over the time that spend covers, at most
  the last week (null in its first day), which matters most with a cold
  `rewardTo`, since nothing the keeper earns comes back to it; `eligible`,
  `proofValidUntil` and `proofDaysLeft` are its standing in the latest
  release's registry; and `attention` lists what a restart would not fix:
  `low_balance`, `low_runway` (fewer than `SPDEX_KEEPER_MIN_RUNWAY_DAYS` days
  left), `proof_lapsing` (five days or less left), `not_eligible` (a
  `rewardTo` that has proven before, or that the keeper is set to prove, and
  may not be paid now), `prove_reverted` (a proof it sent reverted on chain:
  it sends none for a day by its own clock), `stuck_pending`, `windows_missed_24h`,
  `subsidy_exhausted`, `stale_head`, `rpc_errors`, `public_mempool`.
- **Health**: `docker compose ps` shows `healthy` while the heartbeat is fresh
  (written within three intervals, and at least three minutes). This is
  liveness only: an endpoint outage shows as `ok: false` and in `attention`,
  not as unhealthy, because restarting fixes neither.
- **Restarts**: plain Compose never restarts a container for being unhealthy.
  Instead the keeper exits when no tick completes for five intervals (at
  least five minutes), and `restart: unless-stopped` starts a fresh one.
- **Being told when it stops**: put the ping URL of a monitor of your choice
  that alerts when pings stop (the kind services such as healthchecks.io give
  you) in `secrets/heartbeat_url` (`chmod u+w` it first, and 400 again
  after), then `docker compose up -d --force-recreate`. The keeper requests it
  after a healthy tick, at most every five minutes. It is a secret — whoever
  has it can ping and silence the alert — so it is a file, never logged.
- **Old logs** are kept until you remove them, for example those older than
  90 days: `docker compose exec keeper find /data -name 'keeper-*.jsonl' -mtime +90 -delete`.
  Docker's own copy of stdout rotates at 5 × 10 MB.

## The report

```bash
docker compose --profile tools run --rm report
```

reads the chain through your endpoint and the keeper's logs and state, and
writes tables to `docker/keeper/report/`. Without Docker, `pnpm keeper:report`
does the same from the repository root (its tables go to `./keeper-report/`),
reading `./.keeper/<chainId>/`. A Docker keeper's logs and state are in its
data volume instead; copy them out first (from `docker/keeper`,
`docker compose cp keeper:/data/. ./data`; with `KEEPER_DATA=./data` they are
there already), then pass them:
`pnpm keeper:report --keeper-log 'docker/keeper/data/keeper-*.jsonl' --keeper-state docker/keeper/data/state.json`.
Options go after the command:

| Option | What it does |
|---|---|
| `--from-block N` | Start here. Default: the first listed factory's block, or the first block any spDEX factory can be in. |
| `--to-block N\|latest\|finalized` | End here. Default `finalized`, so nothing reported can be reorganised away (`latest` on the fork, or where the endpoint lacks the tag). |
| `--vault 0x…` | Only these vaults, in every table (repeatable). |
| `--reward-to 0x…` | Your reward addresses, besides the one your logs name (repeatable). |
| `--tip-recipient 0x…` | Also list ERC-20 transfers to these addresses (repeatable). |
| `--keeper-log GLOB`, `--keeper-state PATH` | Other keeper logs and state. Default: the data directory's. |
| `--out DIR`, `--format csv\|json\|both` | Where, and as what. Default both. |
| `--eth-usd PRICE` | A fixed price instead of Chainlink's ETH/USD feed. |
| `--cache` | Keep finalized block ranges on disk, so the next run asks for almost nothing. |

It asks at most `SPDEX_REPORT_MAX_RPS` requests a second (default 5), halves
a log range the endpoint refuses and widens it again later, and waits out
rate limits. Hosted free tiers cap `eth_getLogs` ranges (some at ten
blocks), which makes a long history slow: use `--cache`, or give the report
an endpoint with wide log ranges of its own — its URL in
`secrets/report_rpc_url` (empty: the keeper's), or `SPDEX_REPORT_RPC_URL`
for `pnpm keeper:report`. Running it again is safe, and the same range
always gives the same files.

| File | One row per |
|---|---|
| `vaults.csv` | vault: its release and terms (a v2 vault's community window included), deposits, buys, windows missed, gaps, close, the subsidy your keeper planned for it, and for v2 its own count of buys made by holders inside their windows (`windowBuys`) |
| `buys.csv` | buy: its window, delay after due, execution against the floor and the oracle's fair price, fee, planned subsidy, who triggered it, which batch; for a v2 buy also the `rewardTo` it paid, when it fell due, whether it was made inside its community window, and who made it |
| `batches.csv` | batch: listed, tried, bought, refused; earned, and swept for v1's batcher (v2's holds nothing to sweep); gas, cost and net; the keeper's own figures (expected gas, reason, resends) |
| `refusals.csv` | refusal, on chain or in a simulation, factory vaults only |
| `windows.csv` | window that ended (or was bought): bought and by whom (for a v2 buy, who made it as `buys.csv` says), unfunded, closed, keeper down, keeper skipped (and why), or unknown |
| `owners.csv` | owner: vaults, buys, volume, fees, subsidy |
| `daily.csv` | UTC day: buys, volume (ETH and USD), fees, batches, net, deposits, windows missed, medians, keeper uptime; v2 buys made inside their community windows, and the top `rewardTo`'s share of them over the 30 days ending that day |
| `keeper.csv` | UTC day, from the logs alone: heartbeats, uptime, errors, sends by reason (in-window sends included), resends, drops, inclusion, gas against the model, proofs sent, runway and low-runway warnings |
| `tips.csv` | token transfer to a tip address (with `--tip-recipient`) |
| `summary.json` | the questions below, with totals, medians and provenance |

`summary.json` answers, as `q1` to `q21`: buys, volume and active vaults;
new plans and their sizes, intervals and fees; deposits, withdrawals and
value held; fee revenue by buy, batch, day and `rewardTo`; gas per batch and
per buy; subsidy against its caps; execution against the oracle; every
window's fate; time into the window and delay after due; failures by reason,
the windows your keeper's own checks skipped included; keeper uptime, one
figure over the logs' span, and health; inclusion, resends, drops and
cancels, private against public; the fee at send against the target; who
makes the buys; vault lifecycles; oracle and market health; whether
`MIN_ORACLE_DEPTH` (10 ETH) is right, from the depth at every real buy;
whether the data is complete; whether the cost model is right; token tips;
and how concentrated community window buys are. The summary's shape is
version 2 (`v: 2`) since v2 added `made_by`, `q21`, and a `swept` left empty
for v2's batches. Its `provenance` names the block range and hashes, each log
file's sha256, the price source, every release's factory, batcher and
registry, and the endpoint's host (never its URL).

**Who made the buys.** Every buy's `made_by`, from the `rewardTo` and
`dueSince` each v2 `Bought` event records and the sender of the transaction
where it is known: `this-keeper` (your own keeper's, first whatever else is
true), `community` (another community keeper, inside the buy's window),
`owner` (the owner's own **Trigger now**), `returned` (someone else paid the
fee back to the owner), `open` (anyone, after the window), or, for a v1 buy,
`owner` or `caller`. Empty when what it depends on is unknown.

**How concentrated window buys are.** `q21` counts v2 buys made inside their
windows and paid to someone other than the vault's owner, by `rewardTo`, over
the 30 days ending at the report's last block: the share the single
`rewardTo` that won most took (`top1`), and the five that won most (`top5`).
When the top one's share is above 50%, `reopensDecision6` is true: the
decision to let holders race rather than take turns is formally reopened
(`docs/V2_UPGRADE.md`, decision 29). It is null when the range doesn't reach
back 30 days, and `daily.csv`'s rolling column shows how long the share has
stayed there. spDEX's developers' keeper counts like anyone's. With no window
buys in the range the shares are unknown, not zero, and so is every share
while a v2 buy's window, owner or time can't be read (`unknownBuys`, and
`q18`'s `communityWindowUnknownBuys`). The figures are what happened, after
the fact; nothing in the report projects what a keeper will make.

What it will not claim: a figure it could not know is empty (in CSV) or
null (in JSON), never zero — a dollar value on a day the price feed was
silent, a subsidy without keeper logs. Uptime, and a window missed because
the keeper was down, count from the keeper's first record to the report's
last block, so a keeper that stopped writing before then counts as down from
then, every day of it, and never reads as healthy. Give it the keeper's
current logs, as the Docker report service does: logs copied out before the
range's end read as downtime after it. `q18` says whether the data is
complete: every vault's `buyNumber` runs without gaps, every batch's
`earned` equals the fees of the buys it made, every v2 buy can be placed in
or out of its community window, and any block range the endpoint would not
serve is listed. Some things are deliberately
unknowable, because the app records nothing about its users: swaps made in
the app as such, forms abandoned, errors people saw, which frontend created a
vault, and who uses the app. Feedback comes through GitHub issues, when
people choose to write one.

## Deploying a batcher

Each release has a factory (where vaults are created) and, from v2, an SPX
holder registry, which the factory names and which has to be on chain before
it. v1 has a batcher bound to its factory; from v2 one batcher, bound to no
factory and built for WETH alone, serves every release, and a fixed one is
listed beside it (`packages/vault/deployments.json`'s `batchers`). All are
deployed through the deterministic deployer, so their addresses follow from
the source and anyone may deploy them; the registry and the factory are
deployed at a release (`docs/RELEASE.md`), or on a fork by the app's **Set
up vaults on this network**. A batcher's deployment is one transaction, once,
for everyone: 601,283 gas for v1's, measured on a fork of the pinned block,
and 539,274 for the shared one, on a fork of Ethereum on 2026-10-05. The keeper refuses to start while a
release with vaults has no batcher. To deploy it:

```bash
docker compose stop keeper
docker compose run --rm keeper --deploy-batcher
docker compose up -d
```

or set `SPDEX_KEEPER_DEPLOY_BATCHER=1` in `.env` and it deploys at startup.
The keeper must be stopped first: the lease lets only one process sign with
the key at a time. A deployment not mined within two minutes stays in flight,
and the next start follows it — its receipt, a rebroadcast, a replacement at
a higher fee — before signing anything else.

## A standby keeper

For buys that must not be missed, run a second keeper on another machine,
with **its own key**, that only acts at deadlines:

```
SPDEX_KEEPER_SEND_WHEN=deadline
SPDEX_KEEPER_DEADLINE_SHARE=0.1
SPDEX_KEEPER_DEADLINE_MAX_SECONDS=3600
SPDEX_KEEPER_DEADLINE_MIN_SECONDS=30
```

The primary's margin must be at least twice the standby's, so the standby
steps in only when the primary has had its chance: with the defaults, a
daily plan's deadline is two hours before its slot ends for the primary and
one hour for the standby; hourly, 12 and 6 minutes; five-minutely, 60 and 30
seconds. Give the standby the same `SPDEX_KEEPER_REWARD_TO` as the primary,
so that it is eligible inside v2 windows on the same proof; it then makes a
buy inside its window only in the window's urgent part, when the primary has
had its chance there too. One that isn't eligible waits for each window to
end, as any keeper does.

## Upgrading

```bash
git pull
docker compose up -d --build
```

Vaults of older releases keep being served: `packages/vault/deployments.json`
lists every release that reached mainnet and never loses one, each batch goes
to its release's batcher (v1's own, or the newest shared one), and the
keeper's state gains the new release. Its
state file is versioned and migrates forward; a state file from a newer
version, or for another key or chain, is refused rather than guessed at, so
going back to an older keeper after an upgrade needs `--reset-state`. The
report covers every release too.

From v1 to v2: the keeper serves v1's vaults as before and v2's beside them.
`SPDEX_KEEPER_REWARD_TO` now decides more than where fees go: to make v2 buys
inside their windows, that address must hold 690 SPX and be proven
([Becoming a community keeper](#becoming-a-community-keeper)). Two settings
are new, `SPDEX_KEEPER_PROVE` and `SPDEX_KEEPER_MIN_RUNWAY_DAYS`
([Advanced settings](#advanced-settings)); neither needs setting to run. Its
state file moves from version 1 to version 2 at the first start, keeping
everything it had and adding each release's registry, each vault's community
window, the last read of `rewardTo`'s standing, and the runway's and
proving's bookkeeping; a v1 keeper refuses a version 2 file, so going back
needs `--reset-state`.

## Verifying the contracts

v1's factory, vault and batcher are verified on Sourcify and Etherscan
(since 2026-10-01: `docs/RELEASE.md`, step 9), built with solc 0.8.33, the
optimizer at 200 runs, EVM version `cancun`, `bytecode_hash = "none"` and
`cbor_metadata = false` (`packages/vault/foundry.toml`). v2's four, the SPX
holder registry (with the Merkle proof verifier vendored from Optimism inside
it), the factory, the vault and the batcher, are verified the same way once
they are deployed. Verified, explorers and dashboards decode their indexed
events. `pnpm --filter @spdex/vault check:artifacts` rebuilds both releases
from source, v1 from its frozen copy in `packages/vault/releases/v1`, and
checks that the addresses in `packages/vault/src/artifacts.ts` and
`deployments.json` are what the source builds to.

## Trying it on the local fork

With the fork running (`pnpm anvil:fork`, [DEVELOPMENT.md](DEVELOPMENT.md))
and Docker, from the repository root:

```bash
pnpm keeper:smoke
```

builds the image, creates two due v2 vaults with fresh keys, started far
enough back that their community windows are over (a fresh key can't be paid
inside one), lets the containerised keeper batch them, and checks the fees at
`rewardTo`, the logs, the heartbeat, the healthcheck, the report and the
image's contents; then it closes the vaults and deletes its key file and the
fork profile's data volume. It changes nothing else on the fork.
`SPDEX_FORK_URL=http://127.0.0.1:8546` points it at another fork.

By hand, with your own fork vaults and a key of your own in
`docker/keeper/secrets/fork_key` (`chmod 400` it):

```bash
cd docker/keeper
docker compose --profile fork run --rm keeper-fork --print-address
SPDEX_FORK_VAULTS=0xYourVault docker compose --profile fork run --rm keeper-fork --once
docker compose --profile fork run --rm report-fork --to-block latest --vault 0xYourVault
```

Give the printed keeper address some ether first: `pnpm dev:fund 0xTheAddress`
from the repository root. The profile keeps its state in a volume of its own,
which belongs to one key: with another key, add `--reset-state` once. An idle
fork's clock moves only when a block is mined, so a later buy comes due, and
a community window ends, only after some transaction
([TRY-IT.md](TRY-IT.md#watch-a-buy-with-spdex-closed) shows how).

No keeper is a community keeper on the fork: a fresh key holds no SPX, and
the fork can't prove a block it mined (its blocks' state roots are empty).
To make your own fork vaults' buys inside their windows, set
`SPDEX_FORK_REWARD_TO` to the address that owns them, which a v2 vault may
always pay; otherwise the keeper waits for each window to end.

The `fork` profile reads no `.env` into its containers and no mainnet
secret, and its settings have names of their own (`SPDEX_FORK_URL`,
`SPDEX_FORK_VAULTS`, `SPDEX_FORK_REWARD_TO`), because Compose fills the
`${…}` in `compose.yaml` from `.env` as well as from the shell: a mainnet
keeper's `SPDEX_KEEPER_*` settings never reach it. It refuses to start
without `SPDEX_FORK_VAULTS` (unless only asked for its address), since a
shared fork holds other people's vaults. It reaches the fork on the host's
`127.0.0.1` through host networking, which needs rootful Docker on Linux;
Docker Desktop and rootless Docker cannot reach it, and there `pnpm keeper`
works instead.

## Without Docker

From the repository root, after `pnpm install`, with Node 22.15 or later:

```bash
SPDEX_KEEPER_RPC_URL_FILE=~/keeper/rpc_url SPDEX_KEEPER_KEY_FILE=~/keeper/key pnpm keeper
```

The same variables apply ([Advanced settings](#advanced-settings)); they are
read from the environment, then `.env.local`, then `.env.defaults`. State,
the lease, the heartbeat and the logs go to `./.keeper/<chainId>/` unless
`SPDEX_KEEPER_DATA_DIR` says otherwise. `--dry-run` decides, simulates and
logs without signing or writing anything, so it can run beside a real
keeper; `--once` runs one tick and exits. `pnpm keeper:report` is the report.

## Advanced settings

Every setting has a default that a stranger can run unchanged. In Docker, put
any of these in `.env`. A variable ending in `_URL`, and the key, can instead
be given as a file with `_FILE` (whose contents are trimmed); setting both
forms is an error, and an empty value counts as unset. An error names the
variable, never its value. A `SPDEX_KEEPER_…` name the keeper does not read —
a typo, or a setting from an older version — is named at start
(`warn unknown-setting`) rather than ignored in silence.

Only what an operator has a reason to change is a setting. The rest of the
policy — how cheap a block must be, the urgent tip, the fee margin, batch
sizes, resend, expiry and refusal timing, how often it reads — keeps its
defaults: `DEFAULT_KEEPER_POLICY` in `packages/vault/src/keeper-plan.ts` lists
them, and [When it sends](#when-it-sends) explains the timing.

**Endpoints, key and addresses**

| Variable | Default | What it does |
|---|---|---|
| `SPDEX_KEEPER_RPC_URL` | required | The endpoint it reads from, and sends through when there is no send URL. Docker: `secrets/rpc_url`. |
| `SPDEX_KEEPER_SEND_URL` | none | A private, revert-protected endpoint for `eth_sendRawTransaction` only. Docker: `secrets/send_url`. |
| `SPDEX_KEEPER_SEND_PRIVATE` | `1` with a send URL, else `0` | Treat sends as private: `minRewards`, drop handling, no per-pair cap. `1` needs a send URL. |
| `SPDEX_KEEPER_KEY` | none: a dry run | The keeper's key, 32 bytes of hex with or without `0x`. Docker: `secrets/keeper_key`. |
| `SPDEX_KEEPER_REWARD_TO` | the keeper | The address every vault in its batches pays (`rewardTo`). To make v2 buys inside their community windows it must be eligible: an ordinary account holding 690 SPX, proven ([Becoming a community keeper](#becoming-a-community-keeper)). |
| `SPDEX_KEEPER_VAULTS` | every listed vault | A comma-separated allowlist. |

**Files and logs**

| Variable | Default | What it does |
|---|---|---|
| `SPDEX_KEEPER_DATA_DIR` | `./.keeper/<chainId>` (Docker: `/data`) | `state.json`, `keeper.lock`, `heartbeat.json` and the daily JSONL files. |
| `SPDEX_KEEPER_LOG_FILE` | daily files in the data directory | One file instead; `-` for stdout only. Records always go to stdout too. |
| `SPDEX_KEEPER_LOG_LEVEL` | `info` | `debug` adds a `tick` record every tick. |
| `SPDEX_KEEPER_HEARTBEAT_FILE` | `heartbeat.json` in the data directory | Where the heartbeat is written. |
| `SPDEX_KEEPER_HEARTBEAT_LOG_SECONDS` | `300` | How often a `heartbeat` record is logged (the report's uptime comes from them). |
| `SPDEX_KEEPER_HEARTBEAT_URL` | none | A dead-man's switch, requested after a healthy tick at that pace. Docker: `secrets/heartbeat_url`. |
| `SPDEX_KEEPER_GIT_SHA` | none | Written into the `start` record (and, in Docker, the image's label). |

**Timing**

| Variable | Default | What it does |
|---|---|---|
| `SPDEX_KEEPER_INTERVAL_SECONDS` | `60` | The longest sleep between ticks (the shortest is 12 s). |
| `SPDEX_KEEPER_SEND_WHEN` | `cheap` | `cheap`, `deadline` (a standby) or `now`. |
| `SPDEX_KEEPER_DEADLINE_SHARE` | `0.2` | The deadline's margin before a slot ends, as a share of the interval… |
| `SPDEX_KEEPER_DEADLINE_MIN_SECONDS` | `60` | …but at least this… |
| `SPDEX_KEEPER_DEADLINE_MAX_SECONDS` | `7200` | …and at most this. |

**Fees**

| Variable | Default | What it does |
|---|---|---|
| `SPDEX_KEEPER_TIP_GWEI` | `0.02` | The tip of a normal send. |
| `SPDEX_KEEPER_MAX_FEE_GWEI` | `3` | Never bid more per gas. |

**Money**

| Variable | Default | What it does |
|---|---|---|
| `SPDEX_KEEPER_MAX_LOSS_PER_BUY_ETH` | `0` | The subsidy per buy (0: none). |
| `SPDEX_KEEPER_MAX_LOSS_PER_DAY_ETH` | `0.002` | The circuit breaker on realised losses over 24 hours. |
| `SPDEX_KEEPER_MAX_LOSS_PER_VAULT_PER_DAY_ETH` | `0.0001` | Subsidy per vault per day. |
| `SPDEX_KEEPER_MAX_SUBSIDY_PER_OWNER_DAY_ETH` | `0.0002` | Subsidy per owner per day. |
| `SPDEX_KEEPER_SUBSIDY_MIN_BUY_ETH` | `0.0003` | Smaller buys are never subsidised, nor carried by other buys' fees. |
| `SPDEX_KEEPER_SUBSIDY_MIN_INTERVAL_SECONDS` | `3600` | Nor are plans that buy more often than this. |
| `SPDEX_KEEPER_MIN_ETH` | `0.01` | Warn below this much ether (and unwrap fees, when `rewardTo` is the keeper). |
| `SPDEX_KEEPER_MIN_RUNWAY_DAYS` | `7` | Warn (`low_runway`) when the keeper's ether covers fewer days of sends than this at its recent spend. Whole days; `0` turns the warning off. With a cold `rewardTo` nothing refills it: top it up by hand. |

**Community keeping**

| Variable | Default | What it does |
|---|---|---|
| `SPDEX_KEEPER_PROVE` | `0` | `1`: prove `rewardTo` to each listed release's SPX holder registry, against the `finalized` block, when it has no proof and again once its proof has five days or less left: only with nothing else in flight, at the patient tip, and by this machine's clock, never the endpoint's, at most one try every five minutes, at most one proof sent a day, and none for a day after one of its proofs reverted on chain. The hot key pays the gas (about 0.00007 ETH at 0.1 gwei, once a month); `rewardTo` must be an account that held 690 SPX at that block, and the endpoint must answer `eth_getProof`. Off, the keeper still logs when the proof lapses, and never signs a proof. |

**Batches and sends**

| Variable | Default | What it does |
|---|---|---|
| `SPDEX_KEEPER_CONFIRMATIONS` | `2` | Blocks a receipt needs, its own included. |
| `SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS` | `120` | Don't send when the endpoint's newest block is older than this, or dated this much ahead of this machine's clock (`0`: off, for a fork). |
| `SPDEX_KEEPER_DEPLOY_BATCHER` | `0` | Deploy a missing listed batcher at startup. |
| `SPDEX_KEEPER_GAS_PER_VAULT` | `400000` | The gas each vault's `execute` is given in a batch to a batcher from v2 on (`MIN_EXECUTE_GAS` to `MAX_EXECUTE_GAS`, 400,000 to 10,000,000), and what a vault built to burn a keeper's gas can take. Raise it only if a fork has repriced a buy past 400,000; v1's batcher always gives 400,000. |

**Docker only** (in `.env`): `KEEPER_UID` and `KEEPER_GID`, the user the
containers run as (1000); `KEEPER_DATA`, the data volume or a directory of
yours, made beforehand (`keeper-data`; `./data` is ignored by git). For the
`fork` profile, from the shell: `SPDEX_FORK_URL` (`http://127.0.0.1:8545`),
`SPDEX_FORK_VAULTS` (required) and `SPDEX_FORK_REWARD_TO`.

**The report**: `SPDEX_REPORT_RPC_URL` (or `_FILE`; Docker:
`secrets/report_rpc_url`), else the keeper's endpoint; `SPDEX_REPORT_MAX_RPS`
(5).

**Flags**

| Flag | What it does |
|---|---|
| `--once` | One tick, waiting up to 120 s for a receipt, then exit. |
| `--dry-run` | Decide, simulate and log; never sign, and write no file. |
| `--now` | The same as `SPDEX_KEEPER_SEND_WHEN=now`. |
| `--deploy-batcher` | Deploy every missing listed batcher whose factory is on this chain, then exit. |
| `--print-address` | Print the keeper's address and `rewardTo` (never the key), then exit. |
| `--reset-state` | Move `state.json` aside (to `state.json.<time>.bak`) and start afresh. |
| `--reset-trapped` | Forget every trapped vault. |
| `--forget 0x…` | Forget one vault's cached state, rests and trap. |
| `--break-lock` | Remove a lease left by a keeper that is gone. |

In Docker, flags go after the service. For a one-off, stop the running keeper
(the lease allows one signer) and run a single tick with the flag:

```bash
docker compose stop keeper
docker compose run --rm keeper --once --reset-trapped
docker compose up -d
```

## Troubleshooting

| You see | It means | Do |
|---|---|---|
| `env file …/.env not found` | Step 1 was skipped. | Make `.env` from `.env.example`. |
| `bind source path does not exist: …/secrets/send_url` (or another secret) | A secret file is missing. | Create it; the optional ones may be empty: `touch secrets/send_url secrets/heartbeat_url secrets/report_rpc_url`. |
| `the file SPDEX_KEEPER_RPC_URL_FILE names could not be read` (or another `…_FILE`) | The container's user cannot read the secret files. | Set `KEEPER_UID` and `KEEPER_GID` in `.env` to `id -u` and `id -g`; `chmod 400 secrets/*`. |
| `the endpoint did not answer eth_chainId: fetch failed: connect ECONNREFUSED 127.0.0.1:…` | `secrets/rpc_url` names a node on this machine as `127.0.0.1`, which inside the container is the container. | Use `http://host.docker.internal:PORT`, with the node listening on Docker's bridge (`172.17.0.1` on Linux). A connect timeout there instead is the host's firewall. |
| `SPDEX_KEEPER_SEND_PRIVATE is 1, but there is no SPDEX_KEEPER_SEND_URL…` | Private sending is on with no private endpoint. | Put the endpoint in `secrets/send_url`, or drop the setting. |
| `warn` `unknown-setting` | `.env` sets a `SPDEX_KEEPER_…` name the keeper does not read. | Fix its spelling against [Advanced settings](#advanced-settings), or remove it. |
| `a transaction from the last run is still in flight` | A transaction the keeper sent before it stopped (a batcher's deployment, say) is not mined yet. | Nothing: it was sent again, and each start follows it until it settles. |
| `set SPDEX_KEEPER_RPC_URL or SPDEX_KEEPER_RPC_URL_FILE, not both` | `.env` sets what a secret file already does. | Remove it from `.env`. |
| `there is no spDEX vault factory at … on chain 1` | This release is not on mainnet yet. | Wait for it, run the last release's tag, or try the [fork](#trying-it-on-the-local-fork). |
| `the batcher for release … is not deployed on this chain` | Nobody has deployed it yet. | [Deploy it](#deploying-a-batcher); anyone may. |
| `another keeper holds /data/keeper.lock` | Another process is signing with this key's data. | Stop it; if it is truly gone, run once with `--break-lock`. |
| `…state.json (field keeper): …` | The state was written for another key, chain or release set. | Put the old key back, or `--reset-state` (the old file is kept). |
| `wait` `not-cheap` | Normal: it is waiting for a cheap block before the deadline. | Nothing. |
| `skip` `holders-first` | A v2 buy is inside its community window, and `rewardTo` may not be paid there. | Nothing: the keeper makes it when the window ends. To make it inside, [become a community keeper](#becoming-a-community-keeper). |
| `skip` `other-turn` | A buy of a plan with turns is inside the first half of its window, and `rewardTo`, though eligible, is not in that slot's bucket. Every plan the app makes has no turns until decision 29 calls for them; anyone may make one with them. | Nothing: the keeper makes it when the turn ends, at the next tick it plans for that moment. |
| `skip` `unproven` | A vault not yet proven its factory's clone: before its first batch, the keeper recomputes its address from the factory, its owner, its terms and a nonce, and batches only a match, so an endpoint that lists something else gets nothing called. At most ten a tick. | Nothing, unless it persists: then the endpoint is answering something other than the factory's own list. |
| `sim-refused` or an on-chain refusal naming `NotEligible` | `rewardTo` lost its standing since the keeper last read it: the proof lapsed, or its SPX fell below 690. | Nothing: the vault rests until its window ends. Prove again, or put the SPX back. |
| `attention: not_eligible`, `proof_lapsing` | `rewardTo` has proven before (or the keeper is set to prove it) and may not be paid now, or its proof lapses within five days. | Prove again, from the app or with `SPDEX_KEEPER_PROVE=1`, and check it still holds 690 SPX. |
| `rewardTo` holds 690 SPX and has a proof, but is never eligible (`eligibility` reason `contract`) | It is a contract (a Safe, a smart wallet): only an ordinary account can be paid inside a window. | Name an ordinary account holding 690 SPX. |
| `warn` `registry-missing` | A listed release has no SPX holder registry on this chain, so nobody is eligible inside its windows. | Nothing on mainnet once the release is deployed; on a fork, set up the release first. |
| `warn` `prove-dry-run` | `SPDEX_KEEPER_PROVE=1` in a dry run, which signs nothing. | Nothing: the proof's lapse is still logged. |
| `prove_skipped` `unsupported` | With `SPDEX_KEEPER_PROVE=1`, the endpoint refuses `eth_getProof` for the `finalized` block (or answers one that doesn't match it), so the keeper can't build a proof. It tries again every five minutes and says so once. | Use an endpoint that answers it, or prove from the app, whose **Paste a proof** works around a service that refuses. |
| `prove_skipped` `below-min-spx`, `contract` | `rewardTo` held less than 690 SPX at the `finalized` block, or is a contract. | Put the SPX back, or name an ordinary account. |
| `prove_skipped` `not-newer` | A proof as new as the one it would send is already recorded (anyone may prove anyone), or one landed while its own was in flight, which it then withdrew. | Nothing. |
| `prove_skipped` `refused`, `gas` | The proof's test-run reverted, or asked for more than 750,000 gas. | Read the detail; check the endpoint. |
| `prove_skipped` `header-mismatch` | The `finalized` block's header, rebuilt from the endpoint's answer, doesn't hash to the block's hash. Either the endpoint answers wrongly, or a hard fork changed the header in a way this build doesn't know. A new field that the endpoint names in its answer is tried, so this is a field it doesn't name, or a change other than a field added at the end. | Try another endpoint. If every endpoint gives the same answer after a hard fork, update the keeper's image: until then it can't prove, and its proof lapses on its date. |
| `attention: prove_reverted` | A proof it sent reverted on chain: it sends none for a day by this machine's clock, whatever a test-run says. | Check the endpoint: an honest proof doesn't revert. |
| `low_runway`, `attention: low_runway` | The keeper's ether covers fewer than `SPDEX_KEEPER_MIN_RUNWAY_DAYS` days of sends at its recent spend. | Send it ether. |
| `wait` `fees-above-max` | The next block costs more than `SPDEX_KEEPER_MAX_FEE_GWEI`. | Wait, or raise it. |
| `wait` `economics`, `skip` `economics` | The fees don't cover the gas. The detail says which: `not-subsidised`, a buy too small, too frequent or paying less than spDEX proposes, which nothing carries; `no-subsidy`, the other fees can't carry it and this keeper offers no subsidy; `subsidy-cap`, a cap or the day's budget is used up; `fees-below-gas`, it pays its own gas but not its share of the batch's. | Nothing, or allow a [subsidy](#how-it-earns-and-what-it-costs). |
| `skip` `public-pair-cap` | Without a private endpoint, a batch's buys on one pair are capped; the rest go in the next batch. | Set `secrets/send_url`. |
| `skip` `not-vouched` | An allowlisted address no listed factory vouches for; rechecked hourly. | Check the address. |
| `skip` `trapped` | A vault's buy reverted with no reason on chain after using at least half its gas cap; it rests a week, or until a new batcher. | `--forget 0x…` or `--reset-trapped` if you know why. |
| `skip` `unfunded`, `below-floor`, `oracle-thin`, `sim-refused` | The vault can't pay, its price floor or oracle refuses the buy now, or a simulation refused it. | Nothing: the owner's terms decide. |
| `wait` `stale-head`, `attention: stale_head` | The endpoint's newest block is more than two minutes old, or dated more than two minutes ahead of this machine's clock. | Check the endpoint and this machine's clock; `SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS=0` only on a fork. |
| `low_balance`, `wait` `low-balance` | The keeper's ether is below `SPDEX_KEEPER_MIN_ETH`, or below one batch's worst-case cost. | Send it ether. |
| `warn` `public-mempool` | No private send endpoint. | See [Private orderflow](#private-orderflow). |
| `warn` `key-permissions` | Others can read the key file. | `chmod 400 secrets/keeper_key`. |
| `unhealthy` in `docker compose ps` | No heartbeat for three intervals: ticks are hanging. | Read the log; the watchdog will restart it. |
| The `fork` profile can't reach the fork | Docker Desktop or rootless Docker has no host networking to `127.0.0.1`. | Use `pnpm keeper` for the fork. |
