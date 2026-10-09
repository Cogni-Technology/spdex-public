# Mainnet smoke tests

`pnpm verify` proves spDEX against a fork pinned to one block, where every
transaction is mined at once and nothing is real. That makes it a gate, and
leaves out the build people load, an endpoint's real rate limits and fee
quotes, a mempool that takes its time, a private relay, and a keeper on the
live chain.

`pnpm mainnet:smoke` covers those. It loads the published app in a real
browser and drives it with three **agent wallets**: keys made for this,
holding a little ether. One, the **holder agent**, also holds 690 SPX for
good, so it can be paid inside a vault's community window. The suite swaps,
makes a vault and closes it, proves the holder agent's SPX (once), runs one
keeper tick, sends one batch for **Help run the network**, and runs a
five-minute vault to its end with the keeper, checking every step against the
chain. It is never a `pnpm verify` stage: prices move and blocks come when
they come, so a red here is something to read, not proof of a regression. A
mainnet run spends real ether.

## What a run does, and costs

Seven tests on mainnet, in this order, each read back from the chain as well
as the page (`e2e-mainnet/`); a fork run adds an eighth, `3-prove`'s rehearsal
([Rehearsing on a fork](#rehearsing-on-a-fork)). Every vault is made on the
current factory; the helper is the holder agent.

| Spec | What happens | Transactions (gas measured on forks of blocks 26,110,744 and 26,110,886) |
|---|---|---|
| `1-swap` | The owner buys SPX with `SPDEX_SMOKE_SWAP_ETH` of ETH, then sells exactly that SPX back. Checks the Guard's "verified", the ether and SPX that moved, the after-swap line, the finality badge's "included", and the row in Your activity | buy 150–159k; approval 47k (once per wallet: it stands for later runs); sell 140–154k |
| `2-vault` | **Recurring** → **Set and forget**: a vault of two `SPDEX_SMOKE_BUY_ETH` buys, created and funded in one confirmation, with the default 30-minute community window. Its first buy is made with **Trigger now**, which names the owner as `rewardTo`, so the fee comes back and the buy isn't counted as a community keeper's. Then **Close and withdraw**, which returns the second buy's ether | create 233k; trigger 250–305k; close 53k |
| `3-prove` | The holder agent's page proves its SPX: Collective DCA → Help run the network → **Community keeping** → **Prove my SPX**, one transaction to the SPX holder registry, read back from its `Proven` event. Only when it needs one: `validUntil` is read first, and a proof valid for more than five more days is left alone (the panel offers none). Then it checks that the panel says the wallet is a community keeper, and sends nothing | prove 654–684k, about once a month |
| `4-keeper` | A vault of one buy, due now, made outside the page, with an hourly plan's default 15-minute window; then one tick of the keeper's own code (what `pnpm keeper` runs) makes its buy through the batcher, inside the window, and the vault pays the buy fee to the holder agent as `rewardTo` | create 199k; batch 256–311k |
| `5-help-run` | First, nothing spent: an outside caller naming itself as `rewardTo` is refused `NotEligible` by the vault, directly and through the batcher (`eth_call`). Then the holder agent's page makes the owner's due vault buy with **Help run the network**, inside its window, sent privately, and is paid exactly its buy fee | create 199k; batch 237–292k |
| `6-every-5-minutes` | **Set and forget** in the Expert view, every 5 minutes (**Custom…**), three buys, with the default window: 75 seconds, a quarter of the interval. The app holds a five-minute plan's first buy back 105 seconds, so a slow creation still finds its first window open. The keeper makes all three as each falls due, about twelve minutes in all, paying the holder agent, and nobody clicks Trigger now. Checks each buy's spacing, the fees paid to the holder agent, and the card ending at 3 of 3, Done. A buy someone else makes after its window is reported, not failed | create 199–216k; three batches 206–333k |

A whole run is about **2.6–3.0 million gas**: about 0.0006 ETH of network fees
at 0.2 gwei, 0.003 ETH at 1 gwei and 0.006 ETH at 2 gwei. A run that proves
adds 654,000–684,000 gas (about 0.00007 ETH at 0.1 gwei, 0.0007 ETH at 1
gwei): the first run, then about one run in 25 days, since a proof lasts 30
days and `3-prove` renews it only in its last five. In the week to 2026-10-02
the base fee's hourly median was 0.09–0.15 gwei from 22:00 to 12:00 UTC and
0.35–1.2 gwei from 13:00 to 20:00.

Besides gas, a run turns some ether into SPX, which stays in the owner's
wallet: the vault's buy, the keeper's buy, the Help run buy and the
five-minute vault's three. The swap's round trip costs Uniswap's 0.3% twice.
The keeper's buy is a small loss to the keeper
(`SPDEX_SMOKE_KEEPER_SUBSIDY_ETH` at most), because the app's default fee on a
small buy rarely covers a batch. The holder agent's 690 SPX is not spent: it
stays where it is, run after run.

**Help run the network is skipped when gas is dear.** The panel offers a
batch only when its buy fees cover its network fee, and a fee is at most
0.69% of a buy. So the spec makes the smallest vault whose 0.69% covers a
one-vault batch at the price the page will sign it at, with half again for
the price to move: about 0.015 ETH a buy at a 0.15 gwei base fee, about 0.08
ETH at 1 gwei. Above `SPDEX_SMOKE_HELP_RUN_MAX_BUY_ETH` (0.02 by default) the
spec is skipped, and prints the figure. On mainnet it also needs a private
relay.

## What it can't tell you

- **A real wallet extension.** The page's wallet is the repo's headless one
  (`packages/testing/src/wallet.ts`), signing with the agent's key in the
  test process. MetaMask's own pop-ups, fee choices and refusals still need a
  person.
- **"Final".** The finality badge is checked to reach "included"; final is
  64 blocks later, which no spec waits for.
- **Prove my SPX, most runs.** It is sent on the first run, then only in a
  proof's last five days. On a fork it is never sent for the holder agent (a
  fork can't prove a key's holding), only rehearsed for a real holder through
  Prove another address. **Paste a proof**, the lapse banner and reminder,
  and the keeper's own proving (`SPDEX_KEEPER_PROVE`) are not exercised.
- **Races between community keepers.** The holder agent is the only
  community keeper the suite runs. On mainnet another proven keeper may win a
  buy inside its window; `6-every-5-minutes` reports such a buy rather than
  failing, and the other specs fail on it as on any buy they didn't make.
- **Flash borrows.** What a borrowed balance can do at buy time is measured in
  forge (`docs/DESIGN.md`, decision 17), not here.
- **Everything else**: tips, the second opinion, amounts typed in money,
  Collective DCA's figures, the walkaway kit. A tip through Permit2 is refused
  on purpose: the wallet won't sign typed data.

## Setting up

Once, on the machine that will run it.

**1. Make the wallets.**

```bash
pnpm mainnet:smoke:wallets
```

This makes three cast keystores (`spdex-smoke-owner`, `-helper`, `-keeper`) in
`~/.config/spdex-agents/keystores` (`SPDEX_SMOKE_HOME` moves it), and a random
password in `~/.config/spdex-agents/password`, readable by your user alone.
It prints the three addresses, and only those. Run again, it makes nothing
new and prints the same addresses. cast opens the keystores too:
`cast wallet address --keystore … --password-file …`.

**2. Fund them** from your own wallet: enough for one run with Help run at a
quiet hour, and a margin.

| Agent | Send | Spends |
|---|---|---|
| owner | 0.035 ETH | the swap, the three vaults' funding, Help run's vault, their gas |
| helper | 0.004 ETH | the holder agent: its proof's gas about once a month, and the Help run batch's gas (the buy fees it earns come as WETH) |
| keeper | 0.003 ETH | four batches' gas: one for `4-keeper`, three for `6-every-5-minutes` |

**3. Send the holder agent 690 SPX, once**, from your own wallet: 690 SPX
(`69000000000` base units; SPX has 8 decimals; the token is
`0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C`) to the helper's address. Not
from the owner agent, and not bought by the suite, which never buys SPX for
it and refuses anything that could move it ([No SPX out of an
agent](#what-keeps-it-safe)). Before anything is signed, a mainnet run checks
that the helper is an ordinary account holding at least 690 SPX, and stops
otherwise, saying so. The first run's `3-prove` then proves it. Proving
publishes, for good, that this address held 690 SPX, and links it to these
agents in public, which is why it is an agent's address and not yours.

**4. Settings**, in `.env.local` (never committed) or the environment:

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

It starts by saying what kind of run this is, the base fee, the budget left,
each agent's balance, and the holder agent's SPX and proof. It ends with
every transaction it sent (which step, which wallet, its gas and cost) and
each agent's balance before and after; the same goes to
`.mainnet-smoke/runs/<run>.summary.json`. A failed test leaves a screenshot
and a trace in `.mainnet-smoke/results/`. Traces hold the endpoint's address
and every request, which is why `.mainnet-smoke/` is gitignored.

Each transaction is appended to `~/.config/spdex-agents/ledger.jsonl` as it is
signed, and settled with its real cost once mined: that is what the daily
limit reads. One test runs at a time, and nothing is retried: a retry would
send real transactions again.

A vault a failed test left funded is closed by the spec's own clean-up, from
its owner's key. If the run stopped too hard for that, the summary lists it
under STILL OPEN, and the next run's clean-up closes it: it closes any vault
an agent owns that still holds something, on any listed factory, not only
that run's. The sweep closes it too.

The specs after `3-prove` need the holder agent proven: run alone on a first
mainnet run, they stop at once with "run 3-prove first" rather than wait out
a community window.

## Rehearsing on a fork

Do this first, and after any change to the suite. Nothing real is at stake:

```bash
pnpm mainnet:smoke:fork                               # terminal 1: a fork of today's chain on :8547
pnpm build:release && pnpm --filter @spdex/web exec vite preview --port 5198 --strictPort   # terminal 2
SPDEX_SMOKE_RPC_URL=http://127.0.0.1:8547 SPDEX_SMOKE_BASE_URL=http://localhost:5198 \
  SPDEX_SMOKE_HELP_RUN_MAX_BUY_ETH=0.1 SPDEX_SMOKE_MAX_RUN_ETH=0.3 pnpm mainnet:smoke
```

(`vite preview` listens on `localhost`, which Node may resolve to `::1` only,
so the base URL says `localhost`, not `127.0.0.1`.)

The global setup knows a fork by `web3_clientVersion` (anvil), and then:

- makes three fresh keys and funds them on the fork;
- deploys any contract in `deployments.json` the fork lacks, in order,
  through the deterministic deployer (`deployReleaseCalls`); a fork of
  today's chain lacks none;
- gives the holder agent its 690 SPX and a registry record, and nothing else,
  with `anvil_setStorageAt`: its SPX balance (SPX's balances are its mapping
  at slot 1) and its `validUntil` (the registry's mapping at slot 0) as if it
  had just proven, then checks that the registry finds it eligible. A fresh
  key never held SPX at a block anyone can prove, and anvil can't prove the
  blocks it mines (their state root is zero), so neither the transfer nor the
  proof can happen for real on a fork;
- finds a real account that held 690 SPX at the fork's `finalized` block,
  from SPX's transfers in the 600 blocks before it, for `3-prove`'s
  rehearsal;
- uses the fork itself as the private relay. It never opens the keystores
  on a fork.

So on a fork, `3-prove` takes its "already proven" path for the holder agent
(the panel says it is a community keeper, and nothing is sent), and its
second test rehearses the registry's real transaction: the holder agent's
page proves that real holder through **Prove another address**, with a proof
the page builds from the fork's `finalized` block, a real Ethereum block
whose state anvil fetches from upstream. That works only while the fork has
mined fewer than 64 blocks, after which its `finalized` block is one anvil
mined: **start a fresh fork for each full rehearsal** (a whole run mines
about 70, most in `6-every-5-minutes`, after `3-prove`). The rehearsal's proof
is of a stranger's address, which is why the harness allows it on a fork
only.

This fork is today's chain, not the pinned one the gate uses (`pnpm
anvil:fork`, :8545), and it is yours: to rehearse a quiet hour, lower its
base fee before a run with `cast rpc anvil_setNextBlockBaseFeePerGas
100000000 --rpc-url http://127.0.0.1:8547` and `cast rpc evm_mine …`. anvil
quotes `eth_gasPrice` as the base fee plus 1 gwei, so Help run's vault comes
out at about 0.075 ETH there: raise `SPDEX_SMOKE_HELP_RUN_MAX_BUY_ETH`, and
`SPDEX_SMOKE_MAX_RUN_ETH` with it, for the rehearsal; it's the fork's ether.

## Giving the ether back

```bash
pnpm mainnet:smoke:sweep 0xYourAddress          # says what it would do
pnpm mainnet:smoke:sweep 0xYourAddress --send   # does it
```

It closes any vault an agent owns that still holds something, on every
release's factory, sends each agent's SPX and WETH to the address, then its
ether, all of it but the last transfer's exact network fee. It refuses a fork
(`--fork` rehearses it with a `SPDEX_SMOKE_HOME` of throwaway keystores), and
refuses an agent's own address.

It leaves the holder agent's SPX where it is, and says so: the 690 SPX you
sent it is not the suite's to move (decision 33). If you are retiring the
agents, send it back yourself before the sweep, while the helper still has
gas: `cast send 0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C
"transfer(address,uint256)" 0xYourAddress <amount> --keystore
~/.config/spdex-agents/keystores/spdex-smoke-helper --password-file
~/.config/spdex-agents/password --rpc-url …` (about 35,000 gas).

## What keeps it safe

**Before anything runs**, the global setup refuses a run whose endpoint is not
chain 1. It also refuses:

- a run that is not on a fork, unless `SPDEX_SMOKE_MAINNET=yes`;
- a fork run with a relay other than the fork. A chain-1 transaction signed
  on a fork is valid on Ethereum, and a real relay would try it there;
- a base fee above its limit;
- a mainnet run without the current registry, factory and batcher deployed;
- a holder agent that isn't an ordinary account, or holds less than 690 SPX;
- agents with no ether;
- a day whose budget is spent.

**Every transaction the harness signs** (`e2e-mainnet/wallet.ts`), for the
page or for a spec, is checked before the key is used:

- **Where it goes.** A Uniswap router, from the owner agent only, or the
  current factory. A vault any listed factory vouches for (`isVault`), and
  only one an agent owns; a trigger that names a `rewardTo`
  (`execute(rewardTo)`) only when it pays an agent. The batcher, with only
  this run's own vaults, an agent as `rewardTo`, and each vault given exactly
  `MIN_EXECUTE_GAS` (400,000), what the app and the keeper send: it is bound
  to no factory and calls whatever it is given, so what it may trigger is the
  wallet's to check. The SPX holder registry, for `prove` alone, with no
  ether, for the holder agent (on a fork run, also the rehearsal's real
  holder), and only when the proof moves its `validUntil`: `validUntil` is
  read first, and a proof that would revert `NotNewer` is never signed. An
  agent wallet. WETH, for an approval to a router, a transfer to an agent or
  a wrap. SPX only for the exception below. Anything else is refused, so a
  build that tried to send elsewhere fails the run instead.
- **No SPX out of an agent** (decision 33 of `docs/DESIGN.md`). The wallets'
  owner sends the holder agent 690 SPX once, by hand, and the suite never
  buys SPX for it. Nothing from the holder agent goes to SPX (a transfer, an
  approval, a permit), to Permit2 or to a router. From any agent, no SPX
  transfer (to an agent or anyone), `transferFrom`, permit or approval, and
  no swap but the owner agent's. The one exception is `1-swap`'s round trip,
  which buys a little SPX and sells exactly that back: before the sale the
  owner agent may approve a router for no more SPX than it holds, which is
  that spec's purchase and never the holder's. That sale is the only SPX that
  leaves an agent; refusing it too would stop `1-swap` testing a sale.
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
  the spec expects buys (one, or three, and one more in `6-every-5-minutes`
  for a batch that loses its buy to someone else after the window), and
  refuses any other. It reads what the transaction may cost from its signed
  bytes and records it in the budget before it leaves;
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
