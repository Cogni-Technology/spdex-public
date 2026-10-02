# Mainnet smoke tests

`pnpm verify` proves spDEX against a fork pinned to one block, where every
transaction is mined at once and nothing is real. That is what makes it a
gate, and it is also what it can't see: the build people actually load, an
endpoint's real rate limits and fee quotes, a mempool that takes its time,
a private relay, a keeper on the live chain.

`pnpm mainnet:smoke` is the other half. It loads the published app in a real
browser and drives it with three **agent wallets**: keys made for this and
holding a little ether. It swaps, makes a vault and closes it, runs one keeper
tick, runs a five-minute vault to its end with the keeper, and sends one batch
for **Help run the network**, and checks every step
against the chain. It is never a `pnpm verify` stage. Prices move and blocks
come when they come, so a red here is something to read, not proof of a
regression. And a mainnet run spends real ether.

- [What a run does, and costs](#what-a-run-does-and-costs)
- [What it can't tell you](#what-it-cant-tell-you)
- [Setting up](#setting-up)
- [Running it](#running-it)
- [Rehearsing on a fork](#rehearsing-on-a-fork)
- [Giving the ether back](#giving-the-ether-back)
- [What keeps it safe](#what-keeps-it-safe)

## What a run does, and costs

Six tests, in this order, each read back from the chain as well as the page
(`e2e-mainnet/`):

| Spec | What happens | Transactions (gas measured on a fork of block 26,099,800) |
|---|---|---|
| `1-swap` | The owner buys SPX with `SPDEX_SMOKE_SWAP_ETH` of ETH, then sells exactly that SPX back. Checks the Guard's "verified", the ether and SPX that moved, the after-swap line, the finality badge's "included", and the row in Your activity | buy 149–159k; approval 47k (once per wallet: it stands for later runs); sell 140k |
| `2-vault` | **Recurring** → **Set and forget**: a vault of two `SPDEX_SMOKE_BUY_ETH` buys, created and funded in one confirmation, its first buy made with **Trigger now**, then **Close and withdraw**, which returns the second buy's ether | create 215–232k; trigger 302k; close 52–70k |
| `3-keeper` | A vault of one buy, due now, made outside the page; then one tick of the keeper's own code (what `pnpm keeper` runs) makes its buy through the batcher and pays the buy fee to the helper as `rewardTo` | create 198k; batch 304–321k |
| `4-help-run` | The helper's page makes the owner's due vault buy with **Help run the network**, sent privately, and is paid exactly its buy fee | create 198k; batch 287k |
| `5-every-5-minutes` | **Set and forget** in the Expert view, every 5 minutes (**Custom…**), three buys. The keeper makes all three as each falls due, about ten minutes in all, and nobody clicks Trigger now. Checks each buy's window and spacing, the fees paid to the helper, and the card ending at 3 of 3, Done | create ~215k; three batches ~300k each |

A whole run is about **2.8 million gas**: about 0.0006 ETH of network fees at
0.2 gwei, 0.0028 ETH at 1 gwei and 0.0056 ETH at 2 gwei. Without Help run it
is 2.34 million (13 transactions on Ethereum on 2026-10-02, 0.0022 ETH of fees
at 0.5–1.25 gwei). In the week to 2026-10-02 the base fee's hourly median was
0.09–0.15 gwei from 22:00 to 12:00 UTC and 0.35–1.2 gwei from 13:00 to 20:00.

Besides gas, a run turns some ether into SPX, which stays in the owner's
wallet: the vault's buy, the keeper's buy, and the Help run buy. The swap's
round trip costs Uniswap's 0.3% twice. The keeper's buy is a small loss to the
keeper (`SPDEX_SMOKE_KEEPER_SUBSIDY_ETH` at most), because the app's default
fee on a small buy rarely covers a batch.

**Help run the network is skipped when gas is dear.** The panel offers a
batch only when its buy fees cover its network fee, and a fee is at most
0.69% of a buy. So the spec makes the smallest vault whose 0.69% covers a
one-vault batch at the price the page will sign it at, with half again for the
price to move. That vault buys about 0.015 ETH of SPX at a 0.15 gwei base fee
and about 0.08 ETH at 1 gwei. Above `SPDEX_SMOKE_HELP_RUN_MAX_BUY_ETH` (0.02 by default) the spec is
skipped, and it prints the figure. On mainnet it also needs a private relay.

## What it can't tell you

- **A real wallet extension.** The page's wallet is the repo's headless one
  (`packages/testing/src/wallet.ts`), signing with the agent's key in the
  test process. MetaMask's own pop-ups, fee choices and refusals still need a
  person.
- **"Final".** The finality badge is checked to reach "included"; final is
  64 blocks later, which no spec waits for.
- **Everything not listed above**: tips, the second opinion, amounts typed in
  money, Collective DCA, the walkaway kit. A tip through Permit2 is refused on
  purpose: the wallet won't sign typed data (see below).

## Setting up

Once, on the machine that will run it.

**1. Make the wallets.**

```bash
pnpm mainnet:smoke:wallets
```

This makes three cast keystores (`spdex-smoke-owner`, `-helper`, `-keeper`) in
`~/.config/spdex-agents/keystores` (`SPDEX_SMOKE_HOME` moves it), and a random
password in `~/.config/spdex-agents/password`, readable by your user alone.
It prints the three addresses, and only those. Run it again and it makes
nothing new: it prints the same addresses. cast opens the keystores too, by
hand: `cast wallet address --keystore … --password-file …`.

**2. Fund them** from your own wallet. Enough for one run with Help run at a
quiet hour, and a margin:

| Agent | Send | Spends |
|---|---|---|
| owner | 0.035 ETH | the swap, the three vaults' funding, Help run's vault, their gas |
| helper | 0.003 ETH | the Help run batch's gas (its buy fee comes back as WETH) |
| keeper | 0.003 ETH | four batches' gas: one for `3-keeper`, three for `5-every-5-minutes` |

**3. Settings**, in `.env.local` (never committed) or the environment:

```bash
SPDEX_SMOKE_RPC_URL=https://…        # your Ethereum endpoint: the page and the harness both use it
SPDEX_SMOKE_BASE_URL=https://…       # the published app: a gateway address of the release's CID
SPDEX_SMOKE_MAINNET=yes              # without it, a run that isn't on a fork is refused
SPDEX_SMOKE_RELAY_URL=https://rpc.flashbots.net/fast   # for Help run the network; unset skips that spec
```

And the limits, each with a default:

| Setting | Default | What it holds |
|---|---|---|
| `SPDEX_SMOKE_MAX_RUN_ETH` | 0.03 | The most one run may send out of the agent wallets, network fees included |
| `SPDEX_SMOKE_MAX_DAY_ETH` | 0.1 | The same over any 24 hours, from the ledger |
| `SPDEX_SMOKE_MAX_BASE_FEE_GWEI` | 2 | No run starts, and nothing is signed, above this base fee |
| `SPDEX_SMOKE_TIP_GWEI` | 0.05 | The priority fee the harness bids at least |
| `SPDEX_SMOKE_SWAP_ETH` | 0.001 | The swap's size |
| `SPDEX_SMOKE_BUY_ETH` | 0.001 | Each vault buy's size |
| `SPDEX_SMOKE_HELP_RUN_MAX_BUY_ETH` | 0.02 | Help run's vault buy, at most |
| `SPDEX_SMOKE_KEEPER_SUBSIDY_ETH` | 0.001 | What the keeper's tick may lose on its buy |

Set `SPDEX_CHROMIUM_PATH` on NixOS, as for the e2e stage (`docs/DEVELOPMENT.md`).

## Running it

```bash
pnpm mainnet:smoke
```

It starts by saying what kind of run this is, the base fee, the budget left
and each agent's balance. It ends with every transaction it sent: which step,
which wallet, its gas and what it cost, and each agent's balance before and
after. The same goes to `.mainnet-smoke/runs/<run>.summary.json`. A failed
test leaves a screenshot and a trace in `.mainnet-smoke/results/`. Traces hold
the endpoint's address and every request, which is why `.mainnet-smoke/` is
gitignored.

Each transaction is also appended to `~/.config/spdex-agents/ledger.jsonl` as
it is signed, and settled with its real cost once mined: that is what the
daily limit reads. One test runs at a time, and nothing is retried: a retry
would send real transactions again.

A vault a failed test left funded is closed by the spec's own clean-up, from
its owner's key. If the run stopped too hard for that, the summary lists it
under STILL OPEN, and the next run's clean-up closes it: it closes any vault
an agent owns that still holds something, not only that run's. The sweep
closes it too.

## Rehearsing on a fork

Do this first, and after any change to the suite. Nothing real is at stake:

```bash
pnpm mainnet:smoke:fork                               # terminal 1: a fork of today's chain on :8547
pnpm build:release && pnpm --filter @spdex/web exec vite preview --port 5198 --strictPort   # terminal 2
SPDEX_SMOKE_RPC_URL=http://127.0.0.1:8547 SPDEX_SMOKE_BASE_URL=http://127.0.0.1:5198 pnpm mainnet:smoke
```

The global setup knows a fork by `web3_clientVersion` (anvil), and then makes
three fresh keys and funds them on the fork, deploys the factory and batcher
if the fork lacks them, and uses the fork itself as the private relay. It
never opens the keystores on a fork.

This fork is today's chain, not the pinned one the gate uses (`pnpm
anvil:fork`, :8545), and it is yours: to rehearse a quiet hour, lower its
base fee before a run with `cast rpc anvil_setNextBlockBaseFeePerGas
100000000 --rpc-url http://127.0.0.1:8547` and `cast rpc evm_mine …`. anvil
quotes `eth_gasPrice` as the base fee plus 1 gwei, so Help run's vault comes
out at about 0.075 ETH there: raise `SPDEX_SMOKE_HELP_RUN_MAX_BUY_ETH` for
the rehearsal, it's the fork's ether.

## Giving the ether back

```bash
pnpm mainnet:smoke:sweep 0xYourAddress          # says what it would do
pnpm mainnet:smoke:sweep 0xYourAddress --send   # does it
```

It closes any vault an agent owns that still holds something, sends each
agent's SPX and WETH to the address, then its ether, all of it but the last
transfer's exact network fee. It refuses a fork (`--fork` rehearses it with a
`SPDEX_SMOKE_HOME` of throwaway keystores), and refuses an agent's own address.

## What keeps it safe

**Before anything runs**, the global setup refuses a run whose endpoint is not
chain 1. It also refuses:

- a run that is not on a fork, unless `SPDEX_SMOKE_MAINNET=yes`;
- a fork run with a relay other than the fork. A chain-1 transaction signed
  on a fork is valid on Ethereum, and a real relay would try it there;
- a base fee above its limit;
- a mainnet run without the factory and the batcher deployed;
- agents with no ether;
- a day whose budget is spent.

**Every transaction the harness signs** (`e2e-mainnet/wallet.ts`), for the
page or for a spec, is checked before the key is used:

- **Where it goes.** A Uniswap router or the factory. A vault the factory
  vouches for, and only one an agent owns. The batcher, with only this run's
  own vaults and an agent as `rewardTo`. An agent wallet. Or SPX or WETH, for
  an approval to a router, a transfer to an agent or a wrap. Anything else is
  refused, so a build that tried to send elsewhere fails the run instead.
- **What it bids.** Never above twice `SPDEX_SMOKE_MAX_BASE_FEE_GWEI` plus
  the tip per gas. A send from the page is signed at the fees the page
  suggested, as a wallet's "site suggested" setting would, so a run tests
  spDEX's own fee choice. Where the harness prices a transaction itself, the
  tip is at least `SPDEX_SMOKE_TIP_GWEI`, because an endpoint may quote 1 wei
  (Alchemy's `eth_maxPriorityFeePerGas` does).
- **What it may cost.** Its value, plus its gas limit at that price, must fit
  the run's and the day's limits. Ether that comes back later is not
  credited, so the figure is never below what really left.

**On the page's side:**

- A raw transaction the page posts, to the endpoint or to its relay, leaves
  only if the harness signed and checked it.
- Typed data is refused, so nothing asks for a Permit2 signature.
- A private transaction is signed at the price the page asked for. That price
  is the app's own choice, and part of what is being tested.

**The keeper signs for itself**, so the keeper specs bound each tick from
outside (`e2e-mainnet/keeper.ts`):

- room in the budget for one batch at the highest price its policy allows;
- a send hook that lets one transaction out a tick, and as many in the run as
  the spec expects buys (one, or three), and refuses any other. It reads what
  the transaction may cost from its signed bytes and records it in the
  budget before it leaves;
- the keeper's own rule (`assertKeeperMaySign`).

A connection lost for longer than the harness's retries (about 30 seconds)
costs the keeper a tick, not the run: the next tick picks up what the last
one sent, as `pnpm keeper` does. Anywhere else it fails the test.

**The keys** are cast keystores. Their password reaches cast through its
environment, never a command line, and a key only ever passes over a pipe into
the test process's memory. Nothing prints, logs or stores one. Whatever can
read the password file can spend from these wallets. That is the whole of
their protection, so they hold small amounts.

**Agents running it.** A mainnet run spends real ether, so an agent runs one
only within limits the wallets' owner has written down: these settings, set
by them, and a record of what they allowed. The ledger is what anyone can
check afterwards.
