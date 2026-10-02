# Running a keeper

A spDEX auto-buy vault holds its owner's plan and budget and enforces the
plan itself, but a contract cannot wake itself up: somebody has to send the
transaction that makes each due buy happen. That somebody is a **keeper**. It
finds vaults whose buy is due, makes many of those buys in one transaction
through the batcher contract, and is paid each vault's **buy fee** for it.

A keeper needs nobody's permission and holds nobody's money. It chooses only
*when* a due buy happens; the vault fixes the amount, the token, the price
floor and where the tokens go, and refuses anything else. What a keeper
risks is its own: the gas it spends, and the hot key it signs with. Nothing
obliges anyone to run one, spDEX's developers included, and a buy time nobody
triggers is skipped.

This guide sets one up with Docker in five steps, then explains what it earns
and costs, how to keep it safe, and every setting.

You don't need a keeper to make a due buy now and then: an open spDEX tab can
do it from your own wallet ([From a tab, without a keeper](#from-a-tab-without-a-keeper)).
A keeper is for keeping vaults buying while nobody has spDEX open.

- [Quick start](#quick-start)
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
machine, to be paid the fees.

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
own address (a hardware wallet, say) — not the keeper's. Run step 3's command
again to see it.

**5. Start it.**

```bash
docker compose up -d --build
docker compose logs -f keeper
```

It starts, finds every vault the factory lists, and waits for due buys and a
cheap block. Every decision is a line of JSON in the log; a keeper that did
nothing says why. It restarts itself after a crash or a reboot
(`restart: unless-stopped`). Stop it with `docker compose stop`: it finishes
the tick in progress and saves its state first.

> Until a release's contracts are on mainnet, the keeper stops at step 5 with
> "there is no spDEX vault factory at … on chain 1" (and Docker keeps
> restarting it; `docker compose down` stops that). Once they are, anyone may
> deploy its batcher; if nobody has yet, the keeper says so, and
> [Deploying a batcher](#deploying-a-batcher) takes one command.

## How it earns, and what it costs

**What it is paid.** Every vault's buy fee (`keeperReward`) is written into the
vault when its owner creates it, and nobody can change it afterwards, spDEX
included. spDEX's app proposes, for each plan:

```
buy fee = 122,000 gas × 0.15 gwei (0.0000183 ETH), and a tenth more: 0.00002013 ETH
          but never more than 0.69% of the buy
```

122,000 gas is one buy's share of a batch of ten. 0.15 gwei is a fixed
reference for what keepers pay across cheap and deadline sends, so two
identical plans always pay the same fee whenever they were made. The tenth is
all the fee asks for beyond cost while spDEX is a prototype. 0.69% is the
contract's own limit (`MAX_REWARD_BPS`): the factory refuses a vault that
would pay more, so no vault it lists ever does. At ETH at $2,643.94:

| Buy | Buy fee (wei) | Fee | Share of the buy |
|---|---|---|---|
| $1 | 2,609,741,522,122 | $0.0069 | 0.69% (the ceiling) |
| $5 | 13,048,707,610,611 | $0.0345 | 0.69% (the ceiling) |
| $10 | 20,130,000,000,000 | $0.0532 | 0.54% |
| $25 | 20,130,000,000,000 | $0.0532 | 0.22% |
| $69 | 20,130,000,000,000 | $0.0532 | 0.08% |

Every buy from about $7.71 up pays the same 0.00002013 ETH. A batch pays its
fees to `rewardTo` as WETH, in the same transaction.

**What it spends.** Gas: about 106,000 a buy plus 160,000 a batch (a plan's
first buy costs 51,000 more), at whatever the network charges when it sends.
So a keeper's net on one buy is

```
buy fee − (106,000 + 160,000 / buys in the batch) × the fee per gas it paid
```

In a batch of ten:

| Fee per gas paid (gwei) | $1 | $5 | $10 | $25 | $69 | Typical mix |
|---|---|---|---|---|---|---|
| 0.083 (a cheap block) | −$0.020 | +$0.008 | +$0.026 | +$0.026 | +$0.026 | +$0.016 |
| 0.132 (a median block) | −$0.036 | −$0.008 | +$0.011 | +$0.011 | +$0.011 | $0.000 |
| 0.212 (a deadline send) | −$0.061 | −$0.034 | −$0.015 | −$0.015 | −$0.015 | −$0.025 |
| 0.524 (a dear block) | −$0.162 | −$0.135 | −$0.116 | −$0.116 | −$0.116 | −$0.126 |
| 0.604 (a deadline send in a dear block) | −$0.188 | −$0.160 | −$0.142 | −$0.142 | −$0.142 | −$0.152 |
| 1.004 (the tip cap in a dear block) | −$0.317 | −$0.289 | −$0.271 | −$0.271 | −$0.271 | −$0.281 |

Early on, batches are small. In a batch of two (186,000 gas a buy) or one
(266,000):

| Fee per gas (gwei) | Batch | $1 | $5 | $10 | $25 | $69 | Mix |
|---|---|---|---|---|---|---|---|
| 0.083 | 2 | −$0.034 | −$0.006 | +$0.012 | +$0.012 | +$0.012 | +$0.002 |
| 0.083 | 1 | −$0.051 | −$0.024 | −$0.005 | −$0.005 | −$0.005 | −$0.015 |
| 0.132 | 2 | −$0.058 | −$0.030 | −$0.012 | −$0.012 | −$0.012 | −$0.022 |
| 0.132 | 1 | −$0.086 | −$0.058 | −$0.040 | −$0.040 | −$0.040 | −$0.050 |
| 0.212 | 2 | −$0.097 | −$0.070 | −$0.051 | −$0.051 | −$0.051 | −$0.061 |
| 0.212 | 1 | −$0.142 | −$0.115 | −$0.096 | −$0.096 | −$0.096 | −$0.106 |
| 0.524 | 1 | −$0.362 | −$0.334 | −$0.315 | −$0.315 | −$0.315 | −$0.326 |
| 1.004 | 1 | −$0.699 | −$0.672 | −$0.653 | −$0.653 | −$0.653 | −$0.663 |

(The mix is 10% $1 buys, 30% $5, 30% $10, 15% $25 and 15% $69.) This fee is
close to cost on purpose, so it pays only when buys share a transaction and
the block is cheap. The full fee covers a buy's gas up to about 0.165 gwei in
a batch of ten, 0.126 in a batch of three, 0.108 in a batch of two and 0.076
alone. Everywhere else a keeper loses a few cents a buy, and nobody running
one for the money will send those. They get made when an operator chooses to
pay the difference.

**By default a keeper never plans a loss.** It prices each batch at the next
block's base fee plus 12.5% plus its tip. A buy whose fee covers its own gas
goes in. One whose fee falls short — a $1 buy's at almost any block, a $5
buy's from a median block up — rides along only when the batch's other fees
cover the difference, and only if it is at
least 0.0003 ETH, at most hourly, and pays the fee spDEX proposes for its
size: a vault that set itself a lower fee pays its own way or waits. A batch
whose fees can't cover its fixed cost waits. Losses can still happen when a
block turns out dearer than planned, so a circuit breaker stops all subsidy
and widens the margin once realised losses reach 0.002 ETH in 24 hours.

With this fee that means a default keeper waits for a cheap block and a
batch large enough to pay for itself, and a buy whose time runs out first is
skipped.

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
only those. To have it make their buys even when their fees fall short, set
`SPDEX_KEEPER_MAX_LOSS_PER_BUY_ETH` and raise the per-vault and per-owner caps
(`SPDEX_KEEPER_MAX_LOSS_PER_VAULT_PER_DAY_ETH`,
`SPDEX_KEEPER_MAX_SUBSIDY_PER_OWNER_DAY_ETH`) to what you will pay a day;
`SPDEX_KEEPER_SUBSIDY_MIN_BUY_ETH=0` and
`SPDEX_KEEPER_SUBSIDY_MIN_INTERVAL_SECONDS=0` let in buys smaller than 0.0003
ETH or more often than hourly. A buy sent on its own costs about 266,000 gas
(317,000 for a vault's first), and its buy fee comes back to `rewardTo`.

**Other costs.** A computer that stays on (the container is limited to 256 MB
of memory and uses far less), and endpoint requests: about 52,000 compute
units a day with 10 active vaults and 107,000 with 200, a few percent of a
hosted free tier. The keeper never uses `eth_getLogs`. Anyone can create
vaults, funded or not, and a keeper reads every one its factory lists; one
that cannot pay for its next buy costs only a balance read each pass, 200 to
a request, and a full read hourly.

## Keeping the key and the fees safe

- **A hot key, a cold `rewardTo`.** The key in `secrets/keeper_key` signs every
  batch, so it must be on this machine; keep only gas money there. Fees go to
  `SPDEX_KEEPER_REWARD_TO`, whose key should be anywhere else. If you leave it
  empty, fees go to the keeper itself, which then unwraps its WETH for gas
  whenever it runs below `SPDEX_KEEPER_MIN_ETH`.
- **The files.** `chmod 400 secrets/*`, owned by you; the keeper runs as your
  uid (`KEEPER_UID`, `KEEPER_GID`), so no other user and no root process is
  needed. It warns (`warn key-permissions`) if the key file is readable by
  others. The secrets are mounted read-only and never copied into the image
  or the logs.
- **What it will sign**, and nothing else — `assertKeeperMaySign` refuses any
  other transaction before the key is used:
  - `executeBatch` to a batcher listed in `packages/vault/deployments.json`, sending no ether;
  - the one-time deployment of a listed batcher, through the deterministic deployer;
  - a cancel: an empty transfer of 0 ETH to itself;
  - `WETH.withdraw`, only when `rewardTo` is the keeper itself.
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
batch's calldata with a higher tip and take its fees (yours then reverts,
costing gas), and a large batch invites a sandwich. The keeper warns
(`warn public-mempool`), sends `minRewards = 0`, and limits each public batch
to buys totalling 0.1% of a pair's WETH reserve.

A private, revert-protected endpoint avoids all of that: a transaction that
would revert is dropped instead of mined, so a lost race costs nothing, and
the keeper can ask the batcher for a minimum (`minRewards`) below which the
whole batch reverts and is dropped. Two such endpoints:

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

Anyone with spDEX open can make the buys that are due right now, once, from
their own wallet: **Help run the network**, at the foot of the page. It uses
the same batcher and the keeper's own selection (`selectBatch` from
`keeper-plan.ts`, as a private send that plans no loss, at most 20 vaults),
and the buy fees go to the wallet that sends it. It differs from a keeper in what it will do:

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
  goes to the factory's own batcher, pays nobody but the sending wallet, and
  is never signed without a test-run (with a second opinion too, when one is
  set). A batch that would hand on WETH someone sent the batcher is refused,
  and so is one whose `minRewards` doesn't cover the gas the Guard's own
  test-run of it used at the signed price.
- **Once, when pressed.** Nothing runs in the background, and nothing is read
  about the wallet until **See which buys are due** is pressed. The wallet's
  address becomes public as the one that made the buys.

A settled batch is kept in the browser's records as buy fees received (Your
activity, its CSV and statement), never as a buy.

## When it sends

A plan buys once per window (a day, for a daily plan), and the keeper does
not have to buy at the window's first second, so it waits for a cheap block:

- Early in a window only a really cheap block qualifies (the 10th percentile of
  the last day's base fees); the bar rises to the 60th percentile by the
  deadline.
- The **deadline** is a margin before the window ends: 20% of the interval,
  between 60 seconds and 2 hours — two hours for a daily plan, twelve minutes
  for an hourly one. From then on the buy is urgent and goes at whatever the
  fee, with a higher tip (0.1 gwei, rising 1.5× with each resend up to
  0.5 gwei), never above `SPDEX_KEEPER_MAX_FEE_GWEI` (3 gwei).
- Plans shorter than an hour are sent as soon as they are due.
- A batch not mined within a few blocks is rebuilt from fresh reads and
  resent at the same nonce with higher fees; a public one with nothing left
  worth buying is cancelled.

Every batch is simulated at the fee it will pay first, with an explicit gas
limit (never `eth_estimateGas`), so each vault gets its full gas cap.

## Watching it

- **The log**: `docker compose logs -f keeper`, one JSON record per line
  (`start`, `wait`, `skip`, `batch_sent`, `batch_mined`, `heartbeat`, `error`
  and so on). The same records go to daily files in the data directory,
  `/data/keeper-YYYY-MM-DD.jsonl`, which the report reads.
- **The heartbeat**: `docker compose exec keeper cat /data/heartbeat.json`,
  rewritten after every tick. `ok` says whether the last tick worked; `phase`
  is `syncing` until it has read every factory's list; `runwayDays` is how
  long its ether lasts at the last week's spend; and `attention` lists what a
  restart would not fix: `low_balance`, `stuck_pending`, `windows_missed_24h`,
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
| `vaults.csv` | vault: its terms, deposits, buys, windows missed, gaps, close, the subsidy your keeper planned for it |
| `buys.csv` | buy: its window, delay after due, execution against the floor and the oracle's fair price, fee, planned subsidy, who triggered it, which batch |
| `batches.csv` | batch: listed, tried, bought, refused; earned and swept; gas, cost and net; the keeper's own figures (expected gas, reason, resends) |
| `refusals.csv` | refusal, on chain or in a simulation, factory vaults only |
| `windows.csv` | window that ended (or was bought): bought and by whom, unfunded, closed, keeper down, keeper skipped (and why), or unknown |
| `owners.csv` | owner: vaults, buys, volume, fees, subsidy |
| `daily.csv` | UTC day: buys, volume (ETH and USD), fees, batches, net, deposits, windows missed, medians, keeper uptime |
| `keeper.csv` | UTC day, from the logs alone: heartbeats, uptime, errors, sends by reason, resends, drops, inclusion, gas against the model |
| `tips.csv` | token transfer to a tip address (with `--tip-recipient`) |
| `summary.json` | the questions below, with totals, medians and provenance |

`summary.json` answers, as `q1` to `q20`: buys, volume and active vaults;
new plans and their sizes, intervals and fees; deposits, withdrawals and
value held; fee revenue by buy, batch, day and `rewardTo`; gas per batch and
per buy; subsidy against its caps; execution against the oracle; every
window's fate; time into the window and delay after due; failures by reason,
the windows your keeper's own checks skipped included; keeper uptime, one
figure over the logs' span, and health; inclusion, resends, drops and
cancels, private against public; the fee at send against the target; who triggers; vault
lifecycles; oracle and market health; whether `MIN_ORACLE_DEPTH` (10 ETH) is
right, from the depth at every real buy; whether the data is complete; whether
the cost model is right; and token tips. Its `provenance` names the block
range and hashes, each log file's sha256, the price source and the endpoint's
host (never its URL).

What it will not claim: a figure it could not know is empty (in CSV) or
null (in JSON), never zero — a dollar value on a day the price feed was
silent, a subsidy without keeper logs. Uptime, and a window missed because
the keeper was down, count from the keeper's first record to the report's
last block, so a keeper that stopped writing before then counts as down from
then, every day of it, and never reads as healthy. Give it the keeper's
current logs, as the Docker report service does: logs copied out before the
range's end read as downtime after it. `q18` says whether the data is
complete: every vault's `buyNumber` runs without gaps, every batch's
`earned` equals the fees of the buys it made, and any block range the
endpoint would not serve is listed. Some things are deliberately
unknowable, because the app records nothing about its users: swaps made in
the app as such, forms abandoned, errors people saw, which frontend created a
vault, and who uses the app. Feedback comes through GitHub issues, when
people choose to write one.

## Deploying a batcher

Each release has a factory (where vaults are created) and a batcher bound to
it. Both are deployed through the deterministic deployer, so their addresses
follow from the source and anyone may deploy them. A batcher's deployment is
one transaction of about 600,000 gas, once, for everyone. The keeper refuses
to start while a release with vaults has no batcher. To deploy it:

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
daily plan's deadline is two hours before its window ends for the primary and
one hour for the standby; hourly, 12 and 6 minutes; five-minutely, 60 and 30
seconds.

## Upgrading

```bash
git pull
docker compose up -d --build
```

Vaults of older releases keep being served: `packages/vault/deployments.json`
lists every release that reached mainnet and never loses one, each batch goes
to its own release's batcher, and the keeper's state gains the new release. Its
state file is versioned and migrates forward; a state file from a newer
version, or for another key or chain, is refused rather than guessed at. The
report covers every release too.

## Verifying the contracts

The factory, the vault and the batcher are verified on Sourcify and Etherscan
(v1, since 2026-10-01: `docs/RELEASE.md`, step 8), built with solc 0.8.33,
the optimizer at 200 runs, EVM version `cancun`,
`bytecode_hash = "none"` and `cbor_metadata = false`
(`packages/vault/foundry.toml`). Verified, explorers and dashboards decode
their indexed events. `pnpm --filter @spdex/vault check:artifacts` rebuilds
them from source and checks that the addresses in
`packages/vault/src/artifacts.ts` and `deployments.json` are what the source
builds to.

## Trying it on the local fork

With the fork running (`pnpm anvil:fork`, [DEVELOPMENT.md](DEVELOPMENT.md))
and Docker, from the repository root:

```bash
pnpm keeper:smoke
```

builds the image, creates two due vaults with fresh keys, lets the
containerised keeper batch them, and checks the fees at `rewardTo`, the logs,
the heartbeat, the healthcheck, the report and the image's contents; then it
closes the vaults and deletes its key file and the fork profile's data
volume. It changes nothing else on the fork.
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
fork's clock moves only when a block is mined, so a later window comes due
only after some transaction ([TRY-IT.md](TRY-IT.md#watch-a-buy-with-spdex-closed)
shows how).

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
| `SPDEX_KEEPER_REWARD_TO` | the keeper | Where batch fees are paid. |
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
| `SPDEX_KEEPER_DEADLINE_SHARE` | `0.2` | The deadline's margin before a window ends, as a share of the interval… |
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

**Batches and sends**

| Variable | Default | What it does |
|---|---|---|
| `SPDEX_KEEPER_CONFIRMATIONS` | `2` | Blocks a receipt needs, its own included. |
| `SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS` | `120` | Don't send when the endpoint's newest block is older than this (`0`: off, for a fork). |
| `SPDEX_KEEPER_DEPLOY_BATCHER` | `0` | Deploy a missing listed batcher at startup. |

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
| `there is no spDEX vault factory at … on chain 1` | This release is not on mainnet yet. | Wait for it, or try the [fork](#trying-it-on-the-local-fork). |
| `the batcher for release … is not deployed on this chain` | Nobody has deployed it yet. | [Deploy it](#deploying-a-batcher); anyone may. |
| `another keeper holds /data/keeper.lock` | Another process is signing with this key's data. | Stop it; if it is truly gone, run once with `--break-lock`. |
| `…state.json (field keeper): …` | The state was written for another key, chain or release set. | Put the old key back, or `--reset-state` (the old file is kept). |
| `wait` `not-cheap` | Normal: it is waiting for a cheap block before the deadline. | Nothing. |
| `wait` `fees-above-max` | The next block costs more than `SPDEX_KEEPER_MAX_FEE_GWEI`. | Wait, or raise it. |
| `wait` `economics`, `skip` `economics` | The fees don't cover the gas. The detail says which: `not-subsidised`, a buy too small, too frequent or paying less than spDEX proposes, which nothing carries; `no-subsidy`, the other fees can't carry it and this keeper offers no subsidy; `subsidy-cap`, a cap or the day's budget is used up; `fees-below-gas`, it pays its own gas but not its share of the batch's. | Nothing, or allow a [subsidy](#how-it-earns-and-what-it-costs). |
| `skip` `public-pair-cap` | Without a private endpoint, a batch's buys on one pair are capped; the rest go in the next batch. | Set `secrets/send_url`. |
| `skip` `not-vouched` | An allowlisted address no listed factory vouches for; rechecked hourly. | Check the address. |
| `skip` `trapped` | A vault's buy reverted with no reason on chain after using at least half its gas cap; it rests a week, or until a new batcher. | `--forget 0x…` or `--reset-trapped` if you know why. |
| `skip` `unfunded`, `below-floor`, `oracle-thin`, `sim-refused` | The vault can't pay, its price floor or oracle refuses the buy now, or a simulation refused it. | Nothing: the owner's terms decide. |
| `wait` `stale-head`, `attention: stale_head` | The endpoint's newest block is more than two minutes old. | Check the endpoint; `SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS=0` only on a fork. |
| `low_balance`, `wait` `low-balance` | The keeper's ether is below `SPDEX_KEEPER_MIN_ETH`, or below one batch's worst-case cost. | Send it ether. |
| `warn` `public-mempool` | No private send endpoint. | See [Private orderflow](#private-orderflow). |
| `warn` `key-permissions` | Others can read the key file. | `chmod 400 secrets/keeper_key`. |
| `unhealthy` in `docker compose ps` | No heartbeat for three intervals: ticks are hanging. | Read the log; the watchdog will restart it. |
| The `fork` profile can't reach the fork | Docker Desktop or rootless Docker has no host networking to `127.0.0.1`. | Use `pnpm keeper` for the fork. |
