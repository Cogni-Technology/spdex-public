# Running a keeper

A spDEX auto-buy vault enforces its owner's plan, but a contract cannot wake
itself up: somebody has to send the transaction that makes each due buy. That
is a **keeper**. It finds vaults whose buy is due, makes many of them in one
transaction through the batcher contract, and is paid each vault's **buy
fee**.

A keeper needs nobody's permission and holds nobody's money. It chooses
*when* a due buy happens and which address the vault pays its fee to
(`rewardTo`); the vault fixes the amount, the token, the price floor and
where the tokens go, and refuses anything else. A keeper risks only its own
gas and its hot key. Nothing obliges anyone to run one, spDEX's developers
included, and a buy time nobody triggers is skipped.

SPX holders have first claim. For the first minutes after a buy falls due
(its **community window**, 30 minutes by default), the vault pays its fee
only to an address that holds 690 SPX and has proven it, or to its owner;
after that, anyone can make the buy. Community keepers make other people's
buys and are paid for each one; holding 690 SPX is the entry bar.

The keeper and the report also serve the earlier test deployment (release
`v1` in `packages/vault/deployments.json`): its vaults have no community
window, pay whoever calls `execute()`, and go in batches of their own to its
own batcher.

To make a due buy now and then, an open spDEX tab will do it from your own
wallet ([From a tab, without a keeper](#from-a-tab-without-a-keeper)). A
keeper keeps vaults buying while nobody has spDEX open.

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
- [Updating](#updating)
- [Verifying the contracts](#verifying-the-contracts)
- [Trying it on the local fork](#trying-it-on-the-local-fork)
- [Without Docker](#without-docker)
- [Advanced settings](#advanced-settings)
- [Troubleshooting](#troubleshooting)

## Quick start

You need Docker 24 or later with Compose v2 (Linux, macOS, or Windows with
WSL2, since the commands are a POSIX shell's; amd64 or arm64), an Ethereum
JSON-RPC endpoint (a hosted free tier is enough), about 0.02 ETH for gas,
and an address of your own whose key is **not** on this machine, to be paid
the fees. To be paid inside community windows, that address also holds 690
SPX and is proven once a month
([Becoming a community keeper](#becoming-a-community-keeper)); without that,
the keeper leaves those buys to holders until each window closes.

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

`openssl rand -hex 32 > secrets/keeper_key` does the same as the first line.
The key never leaves this machine, and nothing prints it. The three empty
files are optional, empty for none: a private send endpoint, which you should
use ([Private orderflow](#private-orderflow)), a dead-man's switch
([Watching it](#watching-it)), and an endpoint of the report's own
([The report](#the-report)).

A node on this machine is not `127.0.0.1` inside the container: write
`http://host.docker.internal:8545`, have the node listen on an address the
container can reach, such as Docker's bridge (`172.17.0.1` on Linux), and
let the host's firewall accept the port from Docker.

**3. Fund it.**

```bash
docker compose run --rm keeper --print-address
```

The first run builds the image (a minute or two), then prints the keeper's
address and where its fees go. Send the keeper address about **0.02 ETH**:
it pays for gas and is the only money this machine holds.

**4. Say where the fees go.** In `.env`, set `SPDEX_KEEPER_REWARD_TO` to your
own address (a hardware wallet, say), not the keeper's. For a community
keeper, make it an ordinary account (not a contract or a smart wallet) kept
for the SPX, not your main wallet; the next section says why. Step 3's
command shows it.

**5. Start it.**

```bash
docker compose up -d --build
docker compose logs -f keeper
```

It finds every vault each listed release's factory lists, and waits for due
buys and a cheap block. Every decision is a line of JSON in the log; a keeper
that did nothing says why. It restarts after a crash or a reboot
(`restart: unless-stopped`). `docker compose stop` lets it finish the tick in
progress and save its state first.

## Becoming a community keeper

Inside a buy's community window the vault pays its fee only to its owner or
to an address the SPX holder registry finds eligible. A keeper whose
`rewardTo` is eligible makes those buys while other keepers, and bots, wait
for the window to close.

**The window** opens when a buy falls due and lasts the vault's
`communityWindow`, fixed at creation like every other term: 30 minutes by
default, a quarter of the interval for plans that buy more often than every
two hours (75 seconds for a five-minute plan), never under 60 seconds or over
an hour. Every slot's buy has a window of its own, the first after a missed
slot included (when a buy falls due: `docs/ARCHITECTURE.md`, "The community
window"). Inside it, eligible keepers race: the first to land the buy is
paid, and a revert-protected endpoint drops the loser's batch at no cost
([Private orderflow](#private-orderflow)).

**What makes an address eligible.** The registry
(`packages/vault/contracts/SpxHolderRegistry.sol`) answers for `rewardTo` at
each buy, yes only while all three hold:

1. It was **proven** to hold at least 690 SPX at the end of a block at most
   30 days old (`PROOF_TTL`).
2. It **holds** at least 690 SPX now.
3. It is an **ordinary account**: no code, or only an EIP-7702 delegation. A
   contract can hand what it is paid to whoever asks, so SPX in a Safe or
   another smart wallet cannot make it a community keeper.

There is no list, deposit or lock, and the SPX stays in the wallet. The
registry stores one date per proven address and nothing else; it has no
owner, and 690 SPX (`MIN_SPX`) and 30 days are constants in its code.

**Three steps.**

1. **Put 690 SPX in a wallet kept for it**: an ordinary account whose key is
   not on the keeper's machine (a hardware wallet suits), not your main
   wallet ("What proving makes public", below). This wallet is your
   `rewardTo`: it is paid every fee, and it is the address that must be
   eligible. Eligibility is judged on `rewardTo`, never on the key that
   signs, so the keeper's hot key holds only gas money. Leaving
   `SPDEX_KEEPER_REWARD_TO` empty makes the keeper its own `rewardTo`, which
   would then hold and prove the SPX on the machine that signs: don't.
2. **Prove it, once a month.** A proof is one transaction to the registry
   carrying the `finalized` block's header and two Merkle proofs from
   `eth_getProof`, which together show the wallet's SPX balance at that
   block; the registry checks the header against the block's real hash.
   Anyone may send anyone's proof, and it moves no money. Two ways:
   - In spDEX: **Help run the network** → **Community keeping**, with the
     wallet connected, **Prove my SPX**. Or, from any other wallet (a hot
     browser wallet paying the gas), **Prove another address**, so the cold
     wallet never touches a browser. When your network service refuses
     `eth_getProof`, the panel shows the requests to run against another
     service and checks the proof you paste back against your own service's
     block hash before sending it.
   - From the keeper: `SPDEX_KEEPER_PROVE=1` (off by default) proves
     `rewardTo` when it has no proof, and again once its proof has five days
     or less left. The hot key pays the gas; the SPX never leaves the cold
     wallet. The endpoint must answer `eth_getProof` for the `finalized`
     block (`docs/RPC-RUNBOOK.md`, "Proving SPX held: `eth_getProof`", says
     which services do).

   A proof costs about 655,000 to 685,000 gas, about 0.00007 ETH at 0.1 gwei,
   once every 30 days (`docs/ARCHITECTURE.md`, "The SPX holder registry",
   breaks it down). The `finalized` block is about 13 minutes old, so SPX
   that has just arrived can be proven a quarter of an hour later. A proof
   that would not move the wallet's expiry later reverts with `NotNewer`, and
   a revert-protected endpoint drops it unpaid.
3. **Run a keeper** with `SPDEX_KEEPER_REWARD_TO` set to that wallet
   ([Quick start](#quick-start)), or press **Help run the network** in an
   open tab, which pays the connected wallet
   ([From a tab, without a keeper](#from-a-tab-without-a-keeper)).

**What proving makes public.** A proof's `Proven` event says, for good, that
the address held 690 SPX, and each of your keeper's batches names `rewardTo`
beside the hot key that sent it, linking the wallet holding your SPX to your
keeper's key in public. That is why the SPX goes in a wallet kept for it.

**When a proof lapses.** A proof lasts 30 days from the proven block's time,
through its last second. The keeper logs when its `rewardTo`'s proof will
lapse, whether or not it proves, and the app shows a banner from five days
before. A lapsed or missing proof, or SPX moved out of the wallet, does not
stop the keeper: it leaves in-window buys to holders and makes them after
their windows like any other caller.

**Gas money.** With a cold `rewardTo` the hot key only spends: every batch's
gas, and each proof's. Its **runway** is the days of sends its balance covers
at its recent spend (over at most the last week; unknown in its first day).
The keeper logs it, puts it in the heartbeat and the report, and warns
(`low_runway`) below `SPDEX_KEEPER_MIN_RUNWAY_DAYS` (7 by default). Nothing
tops it up by itself: send the keeper's address ether from a wallet that
isn't on its machine. A batcher that refunded gas out of the fees would put
WETH back through the batcher (`docs/DESIGN.md`, "Considered and not
chosen").

**What the bar does and doesn't filter.** It really checks "held 690 SPX at
the end of some block in the last 30 days": SPX borrowed inside the buying
transaction, from Uniswap v4 for no fee, meets the check at each buy
(`docs/UNISWAP-V4.md`, "What the PoolManager lends", has the figures). A bot
that buys 690 SPX keeps like anyone, and inside each window the fastest
eligible keeper wins (the rest: `docs/THREAT-MODEL.md`, "The community window
and the SPX holder registry"). If one `rewardTo` wins more than half of
window buys for 30 days, sharing them out by turns among holders is formally
reconsidered ([The report](#the-report)).

## How it earns, and what it costs

**What it is paid.** Every vault's buy fee (`keeperReward`) is fixed when its
owner creates it, and nobody can change it afterwards, spDEX included. The
app proposes:

```
buy fee = 126,000 gas × 0.15 gwei (0.0000189 ETH)  +  0.25% of the buy
          but never more than 0.69% of the buy
```

126,000 gas (`BATCHED_BUY_GAS` in `packages/vault/src/fee.ts`) is one buy's
share of a batch of ten, priced at a fixed 0.15 gwei
(`FEE_NETWORK_REFERENCE`) so identical plans always pay the same fee. 0.69% is
the contract's own limit (`MAX_REWARD_BPS`), network cost included, and it
holds the fee down for buys under about 0.0043 ETH ($11.36). Why, and the fee
on buys from $1 to $690: `docs/ARCHITECTURE.md`, "The buy fee". The fee is
the same inside the community window and after it, and the vault pays it to
`rewardTo` as WETH, in the same transaction as the buy.

**What it spends.** Gas: about 110,000 a buy plus 160,000 a batch (a plan's
first buy costs 51,000 more; `BATCH_PER_BUY_GAS`, `BATCH_FIXED_GAS` and
`BATCH_FIRST_BUY_EXTRA_GAS` in `fee.ts`), at whatever the network charges.
So what a keeper keeps from one buy is

```
buy fee − (110,000 + 160,000 / buys in the batch) × the fee per gas it paid
```

A $25 buy in a batch of ten at a cheap block (0.083 gwei,
`FEE_CHEAP_REFERENCE`: a low base fee of 2026-09-24's week plus the patient
tip) earns 0.0000425 ETH ($0.112), costs 126,000 × 0.083 gwei = 0.0000105 ETH
($0.028), and leaves 0.0000321 ETH ($0.085). That fee covers the buy's gas up
to about 0.34 gwei in a batch of ten, and 0.16 gwei sent alone (270,000
gas). Under the ceiling it covers less: a $5 buy's 0.0000130 ETH pays its
batched gas only below about 0.10 gwei. These are figures at a stated fee per
gas, not a forecast; what a keeper actually made is in
[the report](#the-report).

**By default a keeper never plans a loss.** It prices each batch at the next
block's base fee plus 12.5% plus its tip. A buy whose fee covers its own gas
goes in. One whose fee falls short (a $1 buy's at almost any block, a $5
buy's from a median block up) rides along only when the batch's other fees
cover the difference, and only if it is at least 0.0003 ETH, at most hourly,
and pays at least the fee spDEX proposes for its size and release: a vault
that set itself a lower fee pays its own way or waits. A batch whose fees
can't cover its fixed cost waits. So a buy above the ceiling pays its own gas
in a batch of ten at most blocks; one below it depends on cheap blocks and
shared batches. A block dearer than planned can still cause a loss, so a
circuit breaker stops all subsidy and widens the margin once realised losses
reach 0.002 ETH in 24 hours.

**A subsidy, if you choose one.** To have buys made even when the fees fall
short (spDEX's developers may, during the prototype), set
`SPDEX_KEEPER_MAX_LOSS_PER_BUY_ETH` (`.env.example` shows one operator's
choice). The keeper pays the difference within caps: per buy, per vault per
day (0.0001 ETH), per owner per day (0.0002 ETH) and per day overall (the
breaker). Each vault is helped only within its own caps and its own share of
the gas. The same buys qualify as above, so a flood of dust vaults gets
nothing, and subsidy goes to the oldest vaults first, so new ones cannot
crowd out existing users.

**A keeper for your own vaults.** List them in `.env` as
`SPDEX_KEEPER_VAULTS`, comma-separated, and the keeper reads and triggers
only those. Set `SPDEX_KEEPER_REWARD_TO` to the address that owns them: a
vault may always pay its owner, so the keeper makes their buys inside their
windows without holding any SPX, and every fee comes back to you. To have it
make them even when their fees fall short, set
`SPDEX_KEEPER_MAX_LOSS_PER_BUY_ETH` and raise the per-vault and per-owner caps
(`SPDEX_KEEPER_MAX_LOSS_PER_VAULT_PER_DAY_ETH`,
`SPDEX_KEEPER_MAX_SUBSIDY_PER_OWNER_DAY_ETH`) to what you will pay a day;
`SPDEX_KEEPER_SUBSIDY_MIN_BUY_ETH=0` and
`SPDEX_KEEPER_SUBSIDY_MIN_INTERVAL_SECONDS=0` let in buys under 0.0003 ETH or
more often than hourly. A buy sent on its own costs about 270,000 gas
(321,000 for a vault's first).

**Other costs.** A computer that stays on (the container is limited to 256 MB
of memory and uses far less), and endpoint requests: about 52,000 compute
units a day with 10 active vaults and 107,000 with 200, a few percent of a
hosted free tier, plus two requests a tick for `rewardTo`'s standing in the
registry and, when proving, one `eth_getProof` a month. It never uses
`eth_getLogs`. Anyone can create vaults, funded or not, and a keeper reads
every one its factory lists; one that cannot pay for its next buy costs only
a balance read each pass, 200 to a request, and a full read hourly.

## Keeping the key and the fees safe

- **A hot key, a cold `rewardTo`.** The key in `secrets/keeper_key` signs
  every batch, so it must be on this machine: keep only gas money there, and
  watch its runway. Fees, and a community keeper's SPX, go to
  `SPDEX_KEEPER_REWARD_TO`, whose key is elsewhere. With it empty, fees go to
  the keeper, which unwraps its WETH for gas whenever it runs below
  `SPDEX_KEEPER_MIN_ETH`.
- **The files.** `chmod 400 secrets/*`, owned by you; the keeper runs as your
  uid (`KEEPER_UID`, `KEEPER_GID`), so no other user and no root process is
  needed. It warns (`warn key-permissions`) if others can read the key file.
  The secrets are mounted read-only and never copied into the image or the
  logs.
- **What it will sign**, and nothing else. `assertKeeperMaySign` refuses any
  other transaction before the key is used:
  - `executeBatch` to a batcher listed in `packages/vault/deployments.json`,
    paying the configured `rewardTo`, decoded with that batcher's own ABI,
    giving each vault exactly `SPDEX_KEEPER_GAS_PER_VAULT` where the batcher
    takes it, and sending no ether;
  - the one-time deployment of a listed batcher, through the deterministic
    deployer, only where its source's code lands at the listed address;
  - a cancel: an empty transfer of 0 ETH to itself;
  - `WETH.withdraw`, only when `rewardTo` is the keeper itself;
  - only with `SPDEX_KEEPER_PROVE=1`, `prove` to a listed release's SPX
    holder registry for the configured `rewardTo` and no other holder,
    sending no ether.
- **What it contacts:** your endpoint (`secrets/rpc_url`), and your private
  send endpoint and dead-man's switch if you set them. Nothing else, ever: no
  telemetry, no update check, nothing that phones home. It listens on no
  port.
- **What it logs.** Hashes, addresses and amounts are checked and written as
  they are. Free text (an error's message, a skip's detail) is scrubbed of the
  key, every configured URL and the parts of one an error might quote (host
  and path, long path and query segments), then of anything still shaped like
  a URL or a 64-digit hex string. Neither the key nor a URL is ever printed.
- **The container** runs as your uid, with a read-only filesystem, every Linux
  capability dropped, `no-new-privileges`, and a memory limit. The image is
  built from an allow-list of the repository's files (the root
  `.dockerignore`), so no `.env` file, key or report can enter it;
  `pnpm keeper:smoke` checks its files and history for them.
- **One signer per key.** A lease file in the data directory stops a second
  keeper on the same data from signing. Two machines with one key are not
  supported: they would race each other's nonces. Use a
  [standby keeper](#a-standby-keeper) with its own key instead.

## Private orderflow

In the public mempool anyone can copy a batch's calldata with their own
`rewardTo` and a higher tip and take its fees (yours then reverts, costing
gas), and a large batch invites a sandwich. Inside a community window the
copier must be eligible too, so the race is among holders; after it, it is
open to anyone. Without a private endpoint the keeper warns
(`warn public-mempool`), sends `minRewards = 0`, and limits each batch to
buys totalling 0.1% of a pair's WETH reserve.

A private, revert-protected endpoint drops a transaction that would revert
instead of mining it, so a lost race costs nothing, a race with another
community keeper included, and the keeper can ask the batcher for a minimum
(`minRewards`) below which the whole batch reverts and is dropped. Two such
endpoints:

- MEV Blocker: `https://rpc.mevblocker.io/noreverts`
- Flashbots Protect: `https://rpc.flashbots.net/fast`

Both are third parties you choose to trust with your transactions before they
are public; spDEX has no arrangement with either. Put the URL in
`secrets/send_url` (`chmod u+w` it first, and 400 again after) and restart
with `docker compose up -d --force-recreate`. It is used for sending only
(reads still go to `secrets/rpc_url`), and the keeper never falls back to the
public mempool when it fails. If your send endpoint is private but does not
drop reverting transactions, set `SPDEX_KEEPER_SEND_PRIVATE=0`. Set to `1`
with no send endpoint, it is refused: every send would go to the public one.

## From a tab, without a keeper

**Help run the network**, at the foot of spDEX's page, makes the buys due
right now, once, from the connected wallet, which it names as `rewardTo`,
through the shared batcher and the keeper's own selection (`selectBatch`, at
most 20 vaults, planning no loss). Unlike a keeper:

- **Holders first.** A buy inside its community window is offered only to an
  eligible wallet, the wallet's own vaults included (their cards' **Trigger
  now** makes those); any other is told why, with a link to
  [Becoming a community keeper](#becoming-a-community-keeper).
- **Private sending only**, with no public fallback, from a wallet that can
  sign without broadcasting (`eth_signTransaction`).
- **Only when the fees cover the cost**: `minRewards`, the test-run's gas ×
  1.1 × the price signed, goes on chain, so a batch that would earn less
  reverts.
- **Once, when pressed.** Nothing runs in the background or is read about the
  wallet until **See which buys are due** is pressed, and its address becomes
  public as the one that made the buys.

**Community keeping**, a closed fold below it, works without private
sending: the wallet's eligibility and its SPX against the 690, **Prove my
SPX**, **Prove another address** and **Paste a proof** (step 2 above), and a
reminder from five days before a proof lapses. How both work:
`docs/ARCHITECTURE.md`, "Helping run the network" and "Community keeping";
what the Guard checks: `docs/THREAT-MODEL.md`, "Helping run the network: a
batch from your own wallet".

## When it sends

A plan buys once per slot of its interval (a day, for a daily plan). The
report and the log call a slot a *window* (`windows.csv`, `window_missed`);
the **community window** is the first part of a slot, and this page always
calls it that.

**Once a buy's community window is over** (and always for the earlier test
deployment's vaults), the keeper waits for a cheap block:

- Early in a slot only a really cheap block qualifies (the 10th percentile of
  the last day's base fees); the bar rises to the 60th percentile by the
  deadline.
- The **deadline** is a margin before the slot ends: 20% of the interval,
  between 60 seconds and 2 hours (two hours for a daily plan, twelve minutes
  for an hourly one). From then on the buy is urgent and goes at whatever the
  fee, with a higher tip (0.1 gwei, rising 1.5× with each resend up to
  0.5 gwei), never above `SPDEX_KEEPER_MAX_FEE_GWEI` (3 gwei).
- Plans shorter than an hour are sent as soon as they are due.

**Inside a buy's community window**, it depends on whether `rewardTo` may be
paid there: eligible with the registry (read every tick, and counted only
while its proof is still valid a block, 12 seconds, after the read), or the
vault's owner.

- **It may:** the keeper makes the buy at once, at the patient tip
  (`SPDEX_KEEPER_TIP_GWEI`, 0.02 gwei), and does not raise it to beat
  another holder. In the window's last two minutes (the last quarter of a
  window shorter than eight minutes: 18 seconds of a five-minute plan's 75)
  it switches to the urgent tip above, because after the window anyone, bots
  included, may take the buy. Such a buy is priced by its window alone,
  whatever `SPDEX_KEEPER_DEADLINE_SHARE` says, and never rides in a batch with
  an urgent buy that would lend it the urgent tip. Holders bidding against
  each other through private relays would hand the fee's margin to block
  builders; a keeper that bids higher can still win, but the stock one
  doesn't start that auction.
- **It may not:** the keeper leaves the buy to holders (`skip holders-first`)
  and plans its next tick for the window's end, after which the rules above
  apply. A buy whose slot ends within a block is left too: it would land as
  the next slot's buy, inside that slot's window.
- A vault that refuses with `NotEligible` (the proof lapsed, or the SPX
  moved, since the last read) rests until its window ends, and the keeper
  reads its standing again. That is neither a trap nor a failure.

A batch not mined within a few blocks is rebuilt from fresh reads and resent
at the same nonce with higher fees; a public one with nothing left worth
buying is cancelled. A batch carrying a buy inside its community window is
the exception: until the window's urgent part it is rebroadcast as it was,
never bid up, and rebuilt or withdrawn only when someone else made its buys.

Every batch is first simulated at the fee it will pay, with an explicit gas
limit (never `eth_estimateGas`), so each vault gets its full gas cap.

## Watching it

- **The log**: `docker compose logs -f keeper`, one JSON record per line
  (`start`, `wait`, `skip`, `batch_sent`, `batch_mined`, `heartbeat`, `error`
  and so on), also written to daily files in the data directory,
  `/data/keeper-YYYY-MM-DD.jsonl`, which the report reads.
  - `eligibility`, at start, whenever it changes and once a day: whether
    `rewardTo` may be paid inside community windows, until when its proof
    lasts, its SPX, whether it is an account, and if not eligible, why
    (`not-proven`, `lapsed`, `contract` or `below-minimum`).
  - With proving on, `prove_sent` and `prove_mined` follow each proof.
    `prove_skipped` says, once until the reason changes, why none was sent
    (`unsupported`, `below-min-spx`, `header-mismatch`, `contract`,
    `not-newer`, `refused`, `gas`, `fees-above-max`, `low-balance`:
    [Troubleshooting](#troubleshooting)), or why one in flight was withdrawn:
    `not-newer` (another proof landed first), `off` (proving was turned off)
    or `other-holder` (`rewardTo` changed).
  - `low_runway`, once each time the runway falls below the threshold.
- **The heartbeat**: `docker compose exec keeper cat /data/heartbeat.json`,
  rewritten after every tick. `ok` says whether the last tick worked; `phase`
  is `syncing` until it has read every factory's list; `runwayDays` is the
  runway (null in its first day); `eligible`, `proofValidUntil` and
  `proofDaysLeft` are its standing in the latest release's registry; and
  `attention` lists what a restart would not fix: `low_balance`,
  `low_runway`, `proof_lapsing` (five days or less left), `not_eligible` (a
  `rewardTo` that has proven before, or that the keeper is set to prove, and
  may not be paid now), `prove_reverted` (a proof it sent reverted on chain:
  it sends none for a day by its own clock), `stuck_pending`,
  `windows_missed_24h`, `subsidy_exhausted`, `stale_head`, `rpc_errors`,
  `public_mempool`.
- **Health**: `docker compose ps` shows `healthy` while the heartbeat is
  fresh (written within three intervals, and at least three minutes). This is
  liveness only: an endpoint outage shows as `ok: false` and in `attention`,
  not as unhealthy, because restarting fixes neither.
- **Restarts**: plain Compose never restarts a container for being
  unhealthy, so the keeper exits when no tick completes for five intervals
  (at least five minutes), and `restart: unless-stopped` starts a fresh one.
- **Being told when it stops**: put the ping URL of a monitor that alerts
  when pings stop (healthchecks.io and similar services give you one) in
  `secrets/heartbeat_url` (`chmod u+w` it first, and 400 again after), then
  `docker compose up -d --force-recreate`. The keeper requests it after a
  healthy tick, at most every five minutes. Whoever has the URL can silence
  the alert, so it is a secret file, never logged.
- **Old logs** are kept until you remove them, for example those older than
  90 days: `docker compose exec keeper find /data -name 'keeper-*.jsonl' -mtime +90 -delete`.
  Docker's own copy of stdout rotates at 5 × 10 MB.

## The report

```bash
docker compose --profile tools run --rm report
```

reads the chain through your endpoint and the keeper's logs and state, and
writes tables to `docker/keeper/report/`. Without Docker, `pnpm keeper:report`
does the same from the repository root (tables in `./keeper-report/`),
reading `./.keeper/<chainId>/`. A Docker keeper's logs and state are in its
data volume: copy them out first (from `docker/keeper`,
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
rate limits. Hosted free tiers cap `eth_getLogs` ranges (some at ten blocks),
which makes a long history slow: use `--cache`, or give the report an
endpoint with wide log ranges, its URL in `secrets/report_rpc_url` (empty:
the keeper's) or `SPDEX_REPORT_RPC_URL` for `pnpm keeper:report`. Running it
again is safe, and the same range always gives the same files.

| File | One row per |
|---|---|
| `vaults.csv` | vault: its release and terms (community window included), deposits, buys, windows missed, gaps, close, the subsidy your keeper planned for it, and its count of buys made by holders inside their windows (`windowBuys`) |
| `buys.csv` | buy: its window, delay after due, execution against the floor and the oracle's fair price, fee, planned subsidy, who triggered it, which batch, the `rewardTo` it paid, when it fell due, whether it was made inside its community window, and who made it |
| `batches.csv` | batch: listed, tried, bought, refused; earned; gas, cost and net; the keeper's own figures (expected gas, reason, resends) |
| `refusals.csv` | refusal, on chain or in a simulation, factory vaults only |
| `windows.csv` | window that ended (or was bought): bought and by whom, unfunded, closed, keeper down, keeper skipped (and why), or unknown |
| `owners.csv` | owner: vaults, buys, volume, fees, subsidy |
| `daily.csv` | UTC day: buys, volume (ETH and USD), fees, batches, net, deposits, windows missed, medians, keeper uptime; buys made inside their community windows, and the top `rewardTo`'s share of them over the 30 days ending that day |
| `keeper.csv` | UTC day, from the logs alone: heartbeats, uptime, errors, sends by reason (in-window sends included), resends, drops, inclusion, gas against the model, proofs sent, runway and low-runway warnings |
| `tips.csv` | token transfer to a tip address (with `--tip-recipient`) |
| `summary.json` | the questions below, with totals, medians and provenance |

`summary.json` (shape `v: 2`) answers `q1` to `q21`: buys, volume and
active vaults; new plans; deposits, withdrawals and value held; fee revenue
by buy, batch, day and `rewardTo`; gas; subsidy against its caps; execution
against the oracle; every window's fate and timing; failures by reason (your
keeper's own skips included); keeper uptime over the logs' span, and health;
inclusion, resends, drops and cancels, private against public; the fee at
send against the target; who makes the buys; vault lifecycles; oracle and
market health; whether `MIN_ORACLE_DEPTH` (10 ETH) is right, from the depth
at every real buy; whether the data is complete (`q18`); whether the cost
model is right; token tips; and how concentrated window buys are (`q21`). Its
`provenance` names the block range and hashes, each log file's sha256, the
price source, every release's factory, batcher and registry, and the
endpoint's host (never its URL).

**Who made the buys.** Each buy's `made_by` comes from the `rewardTo` and
`dueSince` its `Bought` event records and the transaction's sender where
known: `this-keeper` (your own keeper's, first whatever else is true),
`community` (another community keeper, inside the buy's window), `owner` (the
owner's own **Trigger now**), `returned` (someone else paid the fee back to
the owner), or `open` (anyone, after the window); empty when what it depends
on is unknown. The earlier test deployment's buys are `owner` or `caller`,
and only its batcher has a `swept` figure (the shared batcher holds no WETH).

**How concentrated window buys are.** `q21` counts buys made inside their
community windows and paid to someone other than the vault's owner, by
`rewardTo`, over the 30 days ending at the report's last block: the share of
the `rewardTo` that won most (`top1`), and of the five that won most
(`top5`). When the top share is above 50%, `reopensDecision6` is true: the
decision to let holders race rather than take turns is formally reopened
(`docs/DESIGN.md`, decision 29). It is null when the range doesn't reach
back 30 days, and `daily.csv`'s rolling column shows how long the share has
stayed there. spDEX's developers' keeper counts like anyone's. With no window
buys in the range the shares are unknown, not zero, and so is every share
while a buy's window, owner or time can't be read (`unknownBuys`, and
`q18`'s `communityWindowUnknownBuys`). The figures are what happened;
nothing in the report projects what a keeper will make.

**What it will not claim.** A figure it could not know is empty (in CSV) or
null (in JSON), never zero: a dollar value on a day the price feed was
silent, a subsidy without keeper logs. Uptime, and a window missed because
the keeper was down, count from the keeper's first record to the report's
last block, so a keeper that stopped writing counts as down from then, every
day of it. Give it the keeper's current logs, as the Docker report service
does: logs copied out before the range's end read as downtime after it.
`q18` says whether the data is complete: every vault's `buyNumber` runs
without gaps, every batch's `earned` equals the fees of the buys it made,
every buy with a community window can be placed in or out of it, and any
block range the endpoint would not serve is listed. Some things are
unknowable on purpose, because the app records nothing about its users:
swaps made in the app as such, forms abandoned, errors people saw, which
frontend created a vault, and who uses the app. Feedback comes through
GitHub issues, when people choose to write one.

## Deploying a batcher

The factory, where vaults are created, and the SPX holder registry it names
(deployed first) are deployed at a release (`docs/RELEASE.md`), or on a fork
by the app's **Set up vaults on this network**. One batcher, bound to no factory and built for
WETH alone, serves every release whose vaults take `rewardTo`; a fixed one is
one more entry in `deployments.json`'s `batchers`. All are deployed through
the deterministic deployer, so their addresses follow from the source and
anyone may deploy them. A batcher's deployment is one transaction, once, for
everyone: 539,274 gas for the shared one, measured on a fork of Ethereum on
2026-10-05. The keeper refuses to start while a release with vaults has no
batcher. To deploy it:

```bash
docker compose stop keeper
docker compose run --rm keeper --deploy-batcher
docker compose up -d
```

or set `SPDEX_KEEPER_DEPLOY_BATCHER=1` in `.env` and it deploys at startup.
Stop the keeper first: the lease lets one process at a time sign with the
key. A deployment not mined within two minutes stays in flight, and the next
start follows it (its receipt, a rebroadcast, a replacement at a higher fee)
before signing anything else.

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
seconds. Give the standby the same `SPDEX_KEEPER_REWARD_TO`, so it is
eligible on the same proof; it then makes a buy inside its community window
only in the window's urgent part. One that isn't eligible waits for each
window to end, as any keeper does.

## Updating

```bash
git pull
docker compose up -d --build
```

A new contract release reaches the keeper only this way. `deployments.json`
never loses a release, so the keeper goes on serving every vault it served.
Its state file is versioned and migrates forward; one written by a newer
keeper, or for another key or chain, is refused rather than guessed at, and
`--reset-state` starts afresh.

## Verifying the contracts

The registry, the factory, the vault implementation and the batcher, and the
earlier test deployment's, are verified on Sourcify and Etherscan, so
explorers and dashboards decode their events (how: `docs/RELEASE.md`, runbook
step 9).
`pnpm --filter @spdex/vault check:artifacts` rebuilds every release from
source and checks that the addresses the keeper ships
(`packages/vault/src/artifacts.ts`, `deployments.json`) are what the source
builds to.

## Trying it on the local fork

With the fork running (`pnpm anvil:fork`, [DEVELOPMENT.md](DEVELOPMENT.md))
and Docker, from the repository root:

```bash
pnpm keeper:smoke
```

builds the image, creates two due vaults with fresh keys, started far enough
back that their community windows are over (a fresh key can't be paid inside
one), lets the containerised keeper batch them, and checks the fees at
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

Fund the printed address first: `pnpm dev:fund 0xTheAddress` from the
repository root. The profile keeps its state in a volume of its own, which
belongs to one key: with another key, add `--reset-state` once. An idle
fork's clock moves only when a block is mined, so a later buy comes due, and
a community window ends, only after some transaction
([TRY-IT.md](TRY-IT.md#watch-a-buy-with-spdex-closed) shows how).

No keeper is a community keeper on the fork: a fresh key holds no SPX, and
the fork can't prove a block it mined (its state roots are empty). To make
your own fork vaults' buys inside their windows, set `SPDEX_FORK_REWARD_TO`
to the address that owns them; otherwise the keeper waits for each window to
end.

The `fork` profile reads no `.env` into its containers and no mainnet
secret, and never proves. Its settings have names of their own
(`SPDEX_FORK_URL`, `SPDEX_FORK_VAULTS`, `SPDEX_FORK_REWARD_TO`) because
Compose fills the `${…}` in `compose.yaml` from `.env` too, and a mainnet
keeper's `SPDEX_KEEPER_*` settings must never reach it. It refuses to start
without `SPDEX_FORK_VAULTS` (unless only asked for its address): a shared
fork holds other people's vaults. It reaches the fork on the host's
`127.0.0.1` through host networking, which needs rootful Docker on Linux;
with Docker Desktop or rootless Docker, use `pnpm keeper`.

## Without Docker

From the repository root, after `pnpm install`, with Node 22.15 or later:

```bash
SPDEX_KEEPER_RPC_URL_FILE=~/keeper/rpc_url SPDEX_KEEPER_KEY_FILE=~/keeper/key pnpm keeper
```

The same variables apply ([Advanced settings](#advanced-settings)), read
from the environment, then `.env.local`, then `.env.defaults`. State, the
lease, the heartbeat and the logs go to `./.keeper/<chainId>/` unless
`SPDEX_KEEPER_DATA_DIR` says otherwise. `--dry-run` decides, simulates and
logs without signing or writing anything, so it can run beside a real
keeper; `--once` runs one tick and exits. `pnpm keeper:report` is the report.

## Advanced settings

Every setting has a default a stranger can run unchanged. In Docker, put any
of these in `.env`. A variable ending in `_URL`, and the key, can instead be
given as a file with `_FILE` (its contents trimmed); setting both forms is an
error, and an empty value counts as unset. An error names the variable,
never its value. A `SPDEX_KEEPER_…` name the keeper does not read (a typo,
or a setting it no longer reads) is named at start (`warn unknown-setting`).

Only what an operator has a reason to change is a setting. The rest of the
policy (how cheap a block must be, the urgent tip, the fee margin, batch
sizes, resend, expiry and refusal timing, how often it reads) keeps its
defaults, listed in `DEFAULT_KEEPER_POLICY` in
`packages/vault/src/keeper-plan.ts`; [When it sends](#when-it-sends)
explains the timing.

**Endpoints, key and addresses**

| Variable | Default | What it does |
|---|---|---|
| `SPDEX_KEEPER_RPC_URL` | required | The endpoint it reads from, and sends through when there is no send URL. Docker: `secrets/rpc_url`. |
| `SPDEX_KEEPER_SEND_URL` | none | A private, revert-protected endpoint for `eth_sendRawTransaction` only. Docker: `secrets/send_url`. |
| `SPDEX_KEEPER_SEND_PRIVATE` | `1` with a send URL, else `0` | Treat sends as private: `minRewards`, drop handling, no per-pair cap. `1` needs a send URL. |
| `SPDEX_KEEPER_KEY` | none: a dry run | The keeper's key, 32 bytes of hex with or without `0x`. Docker: `secrets/keeper_key`. |
| `SPDEX_KEEPER_REWARD_TO` | the keeper | The address every vault in its batches pays (`rewardTo`). To be paid inside community windows it must be an ordinary account holding 690 SPX, proven ([Becoming a community keeper](#becoming-a-community-keeper)). |
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
| `SPDEX_KEEPER_MIN_RUNWAY_DAYS` | `7` | Warn (`low_runway`) when the keeper's ether covers fewer days of sends than this at its recent spend. Whole days; `0` turns the warning off. |

**Community keeping**

| Variable | Default | What it does |
|---|---|---|
| `SPDEX_KEEPER_PROVE` | `0` | `1`: prove `rewardTo` to each listed release's SPX holder registry, against the `finalized` block, when it has no proof and again once its proof has five days or less left: only with nothing else in flight, at the patient tip, by this machine's clock (never the endpoint's), at most one try every five minutes, at most one proof sent a day, and none for a day after one of its proofs reverted on chain. The hot key pays the gas; `rewardTo` must be an account that held 690 SPX at that block, and the endpoint must answer `eth_getProof`. Off, the keeper still logs when the proof lapses, and never signs a proof. |

**Batches and sends**

| Variable | Default | What it does |
|---|---|---|
| `SPDEX_KEEPER_CONFIRMATIONS` | `2` | Blocks a receipt needs, its own included. |
| `SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS` | `120` | Don't send when the endpoint's newest block is older than this, or dated this much ahead of this machine's clock (`0`: off, for a fork). |
| `SPDEX_KEEPER_DEPLOY_BATCHER` | `0` | Deploy a missing listed batcher at startup. |
| `SPDEX_KEEPER_GAS_PER_VAULT` | `400000` | The gas each vault's `execute` is given in a batch to the shared batcher (`MIN_EXECUTE_GAS` to `MAX_EXECUTE_GAS`, 400,000 to 10,000,000), and what a vault built to burn a keeper's gas can take. Raise it only if a fork has repriced a buy past 400,000. The earlier test deployment's batcher always gives 400,000. |

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
| `there is no spDEX vault factory at … on chain 1` | The source's newest release is not on mainnet yet. Docker keeps restarting the keeper; `docker compose down` stops that. | Wait for it, run the keeper from the last release tag, or try the [fork](#trying-it-on-the-local-fork). |
| `the batcher for release … is not deployed on this chain` | Nobody has deployed it yet. | [Deploy it](#deploying-a-batcher); anyone may. |
| `another keeper holds /data/keeper.lock` | Another process is signing with this key's data. | Stop it; if it is truly gone, run once with `--break-lock`. |
| `…state.json (field keeper): …` | The state was written for another key, chain or release set. | Put the old key back, or `--reset-state` (the old file is kept). |
| `wait` `not-cheap` | Normal: it is waiting for a cheap block before the deadline. | Nothing. |
| `skip` `holders-first` | A buy is inside its community window, and `rewardTo` may not be paid there. | Nothing: the keeper makes it when the window ends. To make it inside, [become a community keeper](#becoming-a-community-keeper). |
| `skip` `other-turn` | A buy of a plan with turns is inside the first half of its window, and `rewardTo`, though eligible, is not in that slot's bucket. The app makes every plan without turns until decision 29 calls for them; anyone may make one with them. | Nothing: the keeper makes it when the turn ends. |
| `skip` `unproven` | A vault not yet proven its factory's clone: before its first batch, the keeper recomputes its address from the factory, its owner, its terms and a nonce, and batches only a match, so an endpoint that lists something else gets nothing called. At most ten a tick. | Nothing, unless it persists: then the endpoint is answering something other than the factory's own list. |
| `sim-refused` or an on-chain refusal naming `NotEligible` | `rewardTo` lost its standing since the keeper last read it: the proof lapsed, or its SPX fell below 690. | Nothing: the vault rests until its window ends. Prove again, or put the SPX back. |
| `attention: not_eligible`, `proof_lapsing` | `rewardTo` has proven before (or the keeper is set to prove it) and may not be paid now, or its proof lapses within five days. | Prove again, from the app or with `SPDEX_KEEPER_PROVE=1`, and check it still holds 690 SPX. |
| `rewardTo` holds 690 SPX and has a proof, but is never eligible (`eligibility` reason `contract`) | It is a contract (a Safe, a smart wallet): only an ordinary account can be paid inside a window. | Name an ordinary account holding 690 SPX. |
| `warn` `registry-missing` | A listed release has no SPX holder registry on this chain, so nobody is eligible inside its windows. | Nothing on mainnet once the release is deployed; on a fork, set up the release first. |
| `warn` `prove-dry-run` | `SPDEX_KEEPER_PROVE=1` in a dry run, which signs nothing. | Nothing: the proof's lapse is still logged. |
| `prove_skipped` `unsupported` | With `SPDEX_KEEPER_PROVE=1`, the endpoint refuses `eth_getProof` for the `finalized` block (or answers one that doesn't match it). It tries again every five minutes and says so once. | Use an endpoint that answers it, or prove from the app, whose **Paste a proof** works around a service that refuses. |
| `prove_skipped` `below-min-spx`, `contract` | `rewardTo` held less than 690 SPX at the `finalized` block, or is a contract. | Put the SPX back, or name an ordinary account. |
| `prove_skipped` `not-newer` | A proof as new as the one it would send is already recorded (anyone may prove anyone), or one landed while its own was in flight, which it then withdrew. | Nothing. |
| `prove_skipped` `refused`, `gas` | The proof's test-run reverted, or asked for more than 750,000 gas. | Read the detail; check the endpoint. |
| `prove_skipped` `fees-above-max`, `low-balance` | Network fees are above `SPDEX_KEEPER_MAX_FEE_GWEI`, or the keeper's ether can't pay for the proof at its highest price. | Wait, or raise the cap; send it ether. |
| `prove_skipped` `header-mismatch` | The `finalized` block's header, rebuilt from the endpoint's answer, doesn't hash to the block's hash: the endpoint answers wrongly, or a hard fork changed the header in a way this build doesn't know (a new field the endpoint names in its answer is tried, so this is a field it doesn't name, or a change other than a field added at the end). | Try another endpoint. If every endpoint gives the same answer after a hard fork, update the keeper ([Updating](#updating)): until then it can't prove, and its proof lapses on its date. |
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
