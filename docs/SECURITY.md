# Security

## Reporting a vulnerability

Open a GitHub security advisory on this repository. Do not open a public issue
for anything that lets a module reach a signer, escape the sandbox, or pass
the Guard with a plan that does not match its intent. The same goes for
anything that moves a vault's money, or buys with it, other than as its terms
allow, and for anything that gets a keeper to sign what it should refuse.

There is no bug bounty. There is also no admin key, no treasury and no upgrade
path. For the app, the realistic impact of a finding is on people running it,
and the fastest useful outcome is a fix and a new pinned CID.

The auto-buy vault is different, and **unaudited**. Its contracts
(`packages/vault/contracts`: the vault, its factory, and the batcher keepers
call them through) hold or move real money, at most 0.5 ETH put in per vault,
and they cannot be patched: nobody can upgrade or pause them, us included. A
finding in them is fixed by a new factory, or a new batcher, at a new address,
listed beside the old in `deployments.json`. Vaults already created keep their
code, and their owners' way out is `close()`, which only the owner can call and
which pays only the owner. So for a contract finding, the useful outcome is
disclosure early enough for owners to close their vaults, then a fixed release
that points at the new addresses.

## What counts as a vulnerability

The security model is not "we vet module authors". It is that nothing reaches
your signer until the host proves the outcome matches your intent. So a
vulnerability is anything that **breaks that proof**:

- A `TxPlan` that reaches the signer without a Guard verdict.
- A plan the Guard marks `verified` whose simulated effects do not match its
  intent — wrong recipient, more spent than agreed, an undeclared approval, a
  second token leaving the wallet.
- A swap or scheduled buy the Guard does not refuse that leaves an allowance
  inside Permit2 (Permit2's own `approve`, or `permit` from a signature): its
  spender could take the token through Permit2 later, with no signature, once
  Permit2 holds the ERC-20 permission a batched tip asks for. A call to
  Permit2, or an approval naming it, in any swap plan is refused statically
  (`PERMIT2_TARGET`), and an allowance inside Permit2 in any simulation is
  refused (`UNEXPECTED_APPROVAL`); a way past either is a finding.
- Any way for a module in the QuickJS sandbox to reach the signer, the network,
  storage, or the DOM, or for the app to run natively — where all four are
  within reach — a module it was not built with.
- A difference in behaviour between the native and QuickJS runtimes for a
  module that keeps the rules in `docs/WRITING-MODULES.md`. (Natively a module
  can still reach the page's clock, randomness and globals; one that does is
  broken, and fails in the sandbox and in the conformance kit. That difference
  is stated, not a vulnerability.)
- A path that treats `unverified` as `verified`, or that silently downgrades
  private sending to a public broadcast.
- A release build that is not reproducible from its source.

Tips to two or more people are paid through Uniswap's Permit2, which adds a
signature and a standing permission to what spDEX asks a wallet for. A
signature request moves money as surely as a transaction does, so these count
as well:

- A tip signature (`eth_signTypedData_v4`) requested without a Guard verdict,
  or a verdict of `verified` for typed data that is not byte for byte what
  `permit2BatchTypedDataJson` builds from the tips: another spender, token,
  amount, order, chain or verifying contract, an extra entry, or a deadline
  more than 30 minutes out.
- A batched tip the Guard marks `verified` that pays anyone but the intent's
  recipients, pays them other amounts, draws from another owner, or grants an
  approval. (A token logging Permit2's allowance going down as Permit2 spends
  it, at or below what it was before, is the one approval a batch may show;
  SPX logs one on every such spend.)
- A Permit2 permission asked for other than exactly `approve(PERMIT2, max)` on
  the token a tip sends, or `approve(PERMIT2, 0)` to revoke it; one asked for
  outside a tip to two or more people; a grant sent without a simulation; or
  anything resting on Permit2 (a signature, a grant, a batch) while the code at
  its address is not the Permit2 spDEX pins (`PERMIT2_CODE_HASH`), or could not
  be read.

Auto-buy adds a standing order, so these count as well:

- A scheduled buy signed outside its plan: another pair, chain, signer or
  recipient; more than one buy's amount, summed across legs; past the plan's
  budget or its last buy; twice in one window, or in a window other than the one
  open now; below the five-minute interval floor; or while the plan is paused.
- A scheduled buy signed without a `verified` verdict.
- A plan that opens a wallet prompt nobody clicked for.
- A way for an unreadable or swapped record of what a plan has spent to count
  as zero, or for a lost one to let the plan buy again without its owner
  starting it — anything that lets a plan start its budget again on its own.
- A plan that arrives from outside this browser, by link or pasted file, and
  is not paused; or a config migrated from before version 8 whose autopilot
  plan arrives anything but paused.
- Anything in the app that creates, funds or signs with a key of its own.
  Earlier versions made such spending wallets for autopilot plans; no release
  ever made one, and since 2026-10-02 the app no longer reads them.

Vaults add contracts that hold money on chain, so these count too, and they
matter most, because a deployed vault cannot be fixed:

- A vault's WETH or ether leaving it other than in a buy delivered to its
  owner, the fixed buy fee to whoever triggered that buy, or a `close` or
  `rescue` paying its owner. That includes anyone but the owner funding,
  closing or rescuing.
- A buy that breaks the vault's terms: before `startAt`, twice in one window
  or sooner than half an interval after the last, past `maxBuys`, more than
  `amountPerBuy`, delivered to anyone but the owner, delivering less than the
  floor, or made while the oracle pool's depth is under `MIN_ORACLE_DEPTH`.
- More than `MAX_FUNDING` taken from an owner into one plan, through
  `createVault` or `fund`.
- A vault the factory vouches for (`isVault`) on a market it did not list, or
  on terms other than the ones its `VaultCreated` event and its address commit
  to; a clone that can exist without its terms, or be initialised by someone
  else; or a call to the implementation that changes any clone.
- A vault its owner cannot close, or whose `close` strands what it holds.
- The batcher paying anyone but the `rewardTo` its caller named, counting
  WETH it already held as `earned`, holding value between calls, calling a
  vault its factory does not vouch for, or giving an attempt more or less than
  `EXECUTE_GAS_CAP`.
- The keeper signing anything `assertKeeperMaySign` should refuse — anything
  but `executeBatch` to a listed batcher paying the configured `rewardTo`, a
  listed batcher's deployment, a 0-value cancel to itself, or a WETH unwrap
  when it is its own `rewardTo` — burning its gas on one vault again and
  again, or exposing its key.
- A keeper log, heartbeat or report output containing the keeper's key, a
  configured endpoint URL, or a secret segment of one.
- A vault transaction the Guard marks `verified` whose simulated effects do not
  match its intent: another factory, owner, market or terms; funding someone
  else's vault or more than it needs; a close that pays anyone else; or a
  creation or funding that sends ether without a simulation.
- A vault creation the app composes with a buy fee above the 0.69% ceiling
  that the Guard does not refuse, or a vault the factory creates that pays
  more than 0.69% of a buy.
- A factory or batcher address in `packages/vault/src/artifacts.ts` that a
  build from source does not reproduce, or a released entry in
  `packages/vault/deployments.json` changed or removed.
- "Vaults on chain not in your plans" listing a vault as the connected
  wallet's when it is not, or offering to close, or add back as a plan, a
  vault the factory did not make.

Things that are **not** vulnerabilities, because they are stated limits rather
than failures — see `docs/THREAT-MODEL.md` for the reasoning:

- A malicious token contract that moves balances without logging them.
- An RPC endpoint that lies about simulation results.
- Price risk on a swap the Guard correctly verified — including a scheduled buy
  made at a poor price.
- Partial execution of a multi-leg route, which the app warns about.
- A Permit2 signature, or a Permit2 approval, asked for by another site or by
  a tampered copy of spDEX, for a token you gave Permit2 the standing
  permission on. Given, it moves what it allows with no further transaction
  from you, and an approval can do so again and again. spDEX can check only
  the requests it makes itself. The permission stands until you revoke it
  (Settings → Tips → **Revoke**), and revoking also stops every other app's use
  of Permit2 with that token. It does not erase allowances held inside
  Permit2; those work again if the permission is given again.
- A flaw in Permit2 itself. It is Uniswap's contract, not spDEX's; report it to
  Uniswap. spDEX's part is checking that the code at its address is the code
  it pinned, and a way past that check would be a finding here.
- Auto-buys not made while no spDEX tab was open, or while the browser had
  paused it.
- An endpoint delaying or holding auto-buys by reporting high fees, refusing to
  simulate, or pricing a pair the oracle warns about.
- Code already running on spDEX's page — a malicious extension, for
  instance. A way for an attacker to get code running there — an XSS in
  spDEX, say — *is* a vulnerability; what such code can then do is not a
  second one.
- The same plan started in two browsers spending twice, or started again in
  this one after its record was lost. Each start writes a record from zero.
- Vault buys nobody triggered. No keeper is promised, and a buy's fee, never
  above 0.69%, may not cover its network cost unless a keeper batches it at a
  cheap block.
- A keeper, spDEX's developers' included, collecting the buy fee on the buys
  it triggers. That is the fee's purpose, and it was fixed when the vault was
  created.
- A public batch copied from the mempool, raced, or sandwiched within each
  vault's allowance, and a keeper losing gas to it. Private orderflow is the
  remedy, and the keeper warns without it.
- A keeper choosing when a due buy happens, or sandwiching it, as long as the
  owner still receives at least the floor: the pool's price less the plan's
  allowance.
- Vault buys refused for a while by someone moving the oracle pool's average,
  or one buy refused by someone pushing the pool's price now around it (about
  0.0045 ETH each at the pinned block), by liquidity leaving the pool, or by
  the pool and pair drifting apart. The buys wait and no money moves.
- The factory's one-time deployment made to revert by someone moving SPX's
  pair in the same block. It costs them the pair's fee both ways, and sending
  it again succeeds.
- A vault holding more than 0.5 ETH because someone sent it WETH. The cap
  limits what the owner can put in; `close` returns the rest too.
- A vault plan deleted from spDEX, one card at a time, while its vault still
  holds money. The card warns first, and the vault stays on chain, closable by
  its owner. spDEX lists it again under "Vaults on chain not in your plans"
  while the owner's wallet is connected, as far back as the network service
  lets it search. A reset, an imported file or a shared link can't drop or
  repoint a vault plan whose vault may still hold money or buy: spDEX keeps it
  and says so.
- The search for your vaults falling short: an endpoint that caps log ranges
  or refuses log queries, or one that hides a vault. The factory's own count
  says how many exist, and spDEX says how many of them it can't show rather
  than showing fewer as all of them. A vault in your plans counts as shown.
  (A search that says every vault is shown while one is missing, with an
  honest endpoint, would be a finding: the count and the logs are read at one
  block so that it can't.)

## Before you report, try to prove it

The threat model's claims are tests: the Guard's in `redteam`; the host's own —
plans arriving paused, a buy waiting for a click — and the keeper's — what it
will sign, what its logs may contain — in `unit`; and the contracts' in
`contracts`. If you think you have found a hole, the fastest way to show it is
a failing one:

```bash
pnpm verify --strict
```

`packages/guard/test/redteam` holds what deliberately malicious modules,
schedules and vault transactions would put in front of the Guard, which must
refuse every one. Tips are there too:
`tips.test.ts` for one transfer each, and `tips-permit2.test.ts` for the batch,
the signature it rests on, and the standing permission. `attacks.test.ts` and
`schedule.test.ts` hold the swaps and scheduled buys that try to leave an
allowance inside Permit2. A new case that survives the Guard is a complete bug
report on its own, and the most useful form one can take.

For the keeper, a failing unit test beside `packages/vault/src/keeper-send.ts`
(what it signs) or `keeper-log.ts` (what it writes) is the equivalent.

For the contracts, the same goes for a forge test in
`packages/vault/test/forge`. Those tests fork mainnet at the pinned block from
the archive endpoint in `SPDEX_FORK_RPC_URL`, and can move time with
`vm.warp`, so any sequence of blocks can be replayed. `Review1.t.sol` and
`Review5b0.t.sol` hold the reviews' attacks, and `Batcher.t.sol` the
batcher's; they are the models to copy:

```bash
pnpm verify --only=contracts                 # the artifacts check, then every forge test
node packages/vault/scripts/forge.mjs test -vv   # the forge tests alone, with their logs
```

## Supply chain

The app is a static bundle with a reproducible build: two builds from the same
source produce the same IPFS address, which the `reproducible` stage checks. If
you are running a pinned CID you verified yourself, no future release — ours or
anyone's — can reach you without you choosing it.

Verify a published release against its source with:

```bash
pnpm build:release && pnpm ipfs:cid
```

See `docs/IPFS-RELEASE.md`.

## Scope

Ethereum mainnet, the modules in `modules/`, and the packages in this
repository: the vault contracts in `packages/vault/contracts` (the batcher
included), the keeper and its report, and the Docker image in `docker/keeper`,
included. A vault made by hand outside the factory is not in scope, because
nothing vouches for its terms and neither the app, the keeper nor the batcher
trusts one. A third-party module is not in scope as *itself* — the whole point
is that it does not need to be trusted — but a way for one to defeat the Guard
very much is.
