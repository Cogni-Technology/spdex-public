# Security

## Reporting a vulnerability

Open a GitHub security advisory on this repository. Do not open a public issue
for anything that lets a module reach a signer, escape the sandbox, or pass
the Guard with a plan that does not match its intent. The same goes for
anything that moves a vault's money, or buys with it, other than as its terms
allow, for anything that gets the SPX holder registry to accept a proof that
isn't true, and for anything that gets a keeper to sign what it should refuse.

There is no admin key, no treasury and no upgrade path. For the app, the
realistic impact of a finding is on people running it, and the fastest useful
outcome is a fix and a new pinned CID.

The auto-buy vault is different, and **unaudited**. Its contracts hold or move
real money, at most 0.5 ETH put in per vault, and they cannot be patched:
nobody can upgrade or pause them, us included. There are two releases. v1's
(`packages/vault/releases/v1/contracts`: the vault, its factory, and the
batcher keepers call them through) is on mainnet and stays there, unchanged,
for good. v2's (`packages/vault/contracts`) adds a fourth contract, the SPX
holder registry, which decides who may be paid a v2 buy's fee during its
community window; the v2 addresses in `packages/vault/src/artifacts.ts` are
the ones this build deploys to, and are live only once
`packages/vault/deployments.json` records their blocks. A finding in either is
fixed by a new release at new addresses, listed beside the old in
`deployments.json`: a new factory (and, from v2 on, a new registry where the
finding is there), or, for a finding in v2's batcher alone, a new batcher,
which is bound to no factory and needs nothing else replaced. Vaults already created keep their code, and their
owners' way out is `close()`, which only the owner can call and which pays
only the owner. So for a contract finding, the useful outcome is disclosure
early enough for owners to close their vaults, then a fixed release that
points at the new addresses. A finding in the registry alone can cost
community-window fees, paid to the wrong address or waiting out their
community windows, never a vault's funds. For that case the response is fixed
in advance: the app keeps creating v2 vaults, since the worst case is v1's
behaviour, a build of it sets the notice that is ready for this
(`REGISTRY_ADVISORY` in `apps/web/src/lib/dca/advisory.ts`, empty until
then), which shows on every v2 vault's card, above the form that creates
one and in Help run the network's **Community keeping**, and the fix ships
as v3 (decision 31 of `docs/V2_UPGRADE.md`).

## Bug bounty: paid in credit

Findings are rewarded with credit, not money. The first private report of a
finding that this page counts as a vulnerability is credited in this file once
it is confirmed, with a failing test or a reproduction ("Before you report,
try to prove it", below), and in the release notes of the release that fixes
it: under the name, pseudonym or handle the reporter chooses, or not at all if
they prefer. It is not paid in money because there is nothing to pay it from:
spDEX has no treasury and takes no fee, and its contracts hold nothing but
their users' own money.

In scope, most important first:

1. **The SPX holder registry** (`packages/vault/contracts/SpxHolderRegistry.sol`)
   and the Merkle-Patricia verifier it vendors
   (`packages/vault/contracts/vendor/optimism`): any way to have it record a
   proof that isn't true, or find an address eligible that shouldn't be. It is
   the one complex piece of v2, and where review starts.
2. **v2's vault, factory and batcher** (`packages/vault/contracts`): above all
   the community window and `rewardTo`, the newest code that touches what a
   buy pays and to whom.
3. **v1's vault, factory and batcher** (`packages/vault/releases/v1/contracts`),
   whose vaults hold real money on mainnet now, and which are never replaced,
   only followed by newer releases.
4. **The Guard, the keeper's signing rules and the app**, as listed under
   "What counts as a vulnerability".

v2's review before release is self-review, the strict gate
(`pnpm verify --strict`) and fuzzing; an outside review or audit is welcome,
not required (decision 30). That is why v2 is labelled "Unaudited", as v1 is,
and why the 0.5 ETH cap stays.

Credited so far: none.

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
  owner, the fixed buy fee to whoever triggered that buy (v1) or to the
  `rewardTo` its caller named (v2), or a `close` or `rescue` paying its owner.
  That includes anyone but the owner funding, closing or rescuing.
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
- A v2 buy inside its community window that pays a `rewardTo` that is neither
  the vault's owner nor eligible in the registry; two `rewardTo` values the
  vault accepts that make different buys (any difference but who is paid the
  fee and whether `windowBuys` counts it); a registry that fails, by
  reverting, running out of gas or answering anything but `true`, making a buy
  wait past its community window or refusing the owner's `execute(owner)`; or
  a vault the factory vouches for whose community window is outside the
  factory's bounds.
- The SPX holder registry recording a proof that isn't true: an address that
  did not hold 690 SPX at the end of the proven block; a block that is not the
  chain's, or more than 8,191 back; a header whose hash is not that block's;
  a value read from another contract or slot than SPX's balance of that
  holder.
- The registry setting `validUntil` to anything but the proven block's time
  plus 30 days, or moving it earlier; answering `isEligible` true for an
  address whose proof has lapsed, that holds under 690 SPX at that moment, or
  that has code other than an EIP-7702 delegation designator; or holding or
  moving any value, or writing anything but `validUntil`.
- v1's batcher paying anyone but the `rewardTo` its caller named, counting
  WETH it already held as `earned`, calling a vault its factory does not
  vouch for, giving an attempt more or less than `EXECUTE_GAS_CAP`, or holding
  value between calls. v2's batcher having any vault pay anyone but the
  `rewardTo` its caller named, reporting as `earned` anything but the rise in
  `rewardTo`'s WETH during the call, giving an attempt more or less than the
  `gasPerVault` its caller named, or ever moving WETH. (It calls whatever its
  caller lists by design; that the keeper, or the Guard for a batch the app
  sends, lets something that isn't a listed factory's vault into a batch is a
  finding against them.)
- A v2 vault paying a `rewardTo` inside the first half of a window of a plan
  with turns when it is not in that slot's bucket, or refusing one that is.
- `close` failing, for any reason but its caller not being the owner, while
  the vault holds anything.
- The keeper signing anything `assertKeeperMaySign` should refuse — anything
  but `executeBatch` to a listed batcher paying the configured `rewardTo`, a
  listed batcher's deployment, a 0-value cancel to itself, a WETH unwrap when
  it is its own `rewardTo`, or, with `SPDEX_KEEPER_PROVE=1` only, a 0-value
  `prove` to a listed registry for the configured `rewardTo` — burning its gas
  on one vault again and again, or exposing its key.
- A keeper log, heartbeat or report output containing the keeper's key, a
  configured endpoint URL, or a secret segment of one.
- A vault transaction the Guard marks `verified` whose simulated effects do not
  match its intent: another factory, owner, market or terms; funding someone
  else's vault or more than it needs; a close that pays anyone else; a v2
  **Trigger now** that pays its fee to anyone but the vault's owner; a batch
  that pays anyone but the connected account; or a creation or funding that
  sends ether without a simulation.
- A proof of SPX held that the Guard lets be signed, `verified` or
  `unverified`, while it goes anywhere but the release's registry, carries
  ether, carries other calldata than the proof, or names a block whose hash
  is not its header's.
- A vault creation the app composes with a buy fee above the 0.69% ceiling
  that the Guard does not refuse, or a vault the factory creates that pays
  more than 0.69% of a buy.
- A registry, factory or batcher address in `packages/vault/src/artifacts.ts`
  that a build from source does not reproduce; v1's frozen source no longer
  building to v1's deployed addresses; or a released entry in
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
  it triggers, inside v2 community windows too once its `rewardTo` is
  proven, like any community keeper's. That is the fee's purpose, and it was
  fixed when the vault was created.
- SPX borrowed within a transaction meeting the registry's balance check at
  the moment of a v2 buy. A proof needs SPX really held when a block closed;
  the check at the buy cannot tell borrowed SPX from held SPX, and Uniswap v4
  lends it for no fee. It is measured (`test/forge/FlashBorrow.t.sol`) and
  stated in `docs/THREAT-MODEL.md`, "The community window and the SPX holder
  registry".
- A bot that buys 690 SPX, proves it and wins community-window buys. The
  registry filters for accounts that held SPX recently, not for people;
  `pnpm keeper:report` publishes how concentrated those wins are.
- Community keepers racing, or outbidding one another, for the same buys.
- A `Proven` event saying, for good, that an address held 690 SPX, and a
  keeper's buys linking its `rewardTo` to the key that sends them. Both are
  public by design, and the app says so before a wallet's first proof.
- SPX held in a contract (a Safe, a smart account) not making that contract
  eligible. Only accounts can be: a contract can hand what it is paid to
  whoever asks.
- Anyone making a v2 buy inside its community window by paying the fee back
  to the vault's owner, or to a proven address it does not control. The
  sender gains nothing; the buy is the one the terms allow.
- v2 buys waiting out their community windows when no eligible keeper is
  online. A plan's first buy whose community window ended before the vault was
  mined, and a buy that becomes possible only after its community window (an
  overdue vault topped up), being open to anyone at once.
- WETH sent to v2's batcher, or a fee a direct caller names it to receive,
  staying there. It has no way to send WETH, and a batch never pays it.
- A proof sent from the app on one service's word ("Checked on one service").
  A proof moves no money, and a false one only reverts.
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
batcher's; they are the models to copy. For the registry, `Registry.t.sol`
proves real holders from proofs recorded from mainnet
(`packages/vault/test/fixtures/proofs`; `scripts/record-proofs.mjs` records
more, for any holder and block, from the same archive endpoint), and holds the
false and fuzzed ones; `Holder.t.sol` runs the real registry inside vaults and
batches, `Window.t.sol` the community window's edges to the second, and
`FlashBorrow.t.sol` the borrow from v4:

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
repository: the vault contracts of both releases, v2's in
`packages/vault/contracts` (the batcher and the SPX holder registry included)
and v1's frozen in `packages/vault/releases/v1/contracts`, the keeper and its
report, and the Docker image in `docker/keeper`, included. So is the proof
verifier vendored in `packages/vault/contracts/vendor/optimism` as the
registry uses it. A flaw in that library itself is Optimism's as well, whose
portal proves every withdrawal from its chain with it: report it to them too.
A vault made by hand outside the factory is not in scope, because nothing
vouches for its terms and neither the app, the keeper nor the batcher trusts
one. A third-party module is not in scope as *itself* — the whole point is
that it does not need to be trusted — but a way for one to defeat the Guard
very much is.
