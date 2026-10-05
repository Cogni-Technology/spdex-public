# AGENTS.md — spDEX

Read this before changing anything. It exists so an AI agent can work here
unattended and know whether it succeeded.

## The one command

```bash
pnpm verify          # every gate; exit 0 = green
pnpm verify --strict # same, but a SKIPPED stage is a failure
pnpm verify --json   # machine-readable to stdout
pnpm verify --only=unit
pnpm verify --only=typecheck,unit,redteam   # run in the gate's order, not this one
```

Results always land in `.verify/report.json` (`schema: spdex.verify/1`).
**Read that file rather than scraping stdout.** Each stage reports
`passed | failed | skipped`, and a skip carries a `reason`. An argument the
gate doesn't know, or a stage id that doesn't exist, runs nothing and exits 2,
with the report's `ok` false and its `error` naming the valid stages.

**A skip is not a pass.** Stages needing Foundry, a browser or an archive
endpoint (`contracts` needs `SPDEX_FORK_RPC_URL`) skip when those are missing,
so a green `pnpm verify` on a bare machine may have exercised half the repo.
Use `--strict` whenever the answer matters. CI always runs `--strict`.

**An empty stage is not a pass either.** A stage whose project matched zero test
files reports `empty`, not `passed` — stages for phases that haven't landed yet
would otherwise look identical to ones that ran and succeeded. `--strict` fails
on these too.

## What each stage proves

| Stage | A failure means |
|---|---|
| `typecheck` | Types are wrong |
| `lint` | Nothing yet — it cannot fail: no workspace package defines a `lint` script, so the stage runs nothing. It does not enforce the no-telemetry rule (rule 4); `apps/web/src/no-requests.test.ts`, in `unit`, is that rule's partial check |
| `unit` | Logic is wrong (mocked RPC, no network) |
| `integration` | Logic disagrees with the real chain (pinned fork) |
| `contracts` | The vault contracts break a rule their forge tests pin, on a mainnet fork at the pinned block (the SPX holder registry's included: real proofs recorded from mainnet, false ones, and fuzzed headers and trie nodes), or `packages/vault/src/artifacts.ts` is stale: the registry, factory and batcher addresses the app and the keeper ship are not the ones the source builds to, v1's frozen source (`packages/vault/releases/v1`) no longer builds to v1's deployed factory and batcher, or `packages/vault/deployments.json` is not what this build makes of it (every release and batcher recomputed from its source). Runs `build-artifacts.mjs --check`, then `forge test`. Skips without `forge` on PATH or without `SPDEX_FORK_RPC_URL`. The forge tests fork from that archive endpoint themselves, so a rate limit (HTTP 429) fails the stage without any assertion failing; read the output before believing a red |
| `conformance` | A module violates the interface, or escaped its sandbox |
| `parity` | Native and QuickJS runtimes disagree — the fast path has drifted. It runs fixture modules covering every loadable kind, not the shipped ones; each first-party module checks its own parity in `unit` (tip list, tracker, scheduler: whole outputs) or `integration` (venues: pool discovery and quotes, not the calls that get signed) |
| `redteam` | **The Guard let a malicious plan through** — a swap, a tip, a scheduled buy, a vault transaction (a creation above the buy-fee ceiling included, a v2 **Trigger now** paying anyone but the owner, and a `prove` sent anywhere but the release's registry, carrying ether, or built against the wrong block), or a batch of other people's due vault buys (Help run the network) paying anyone but the account — or a second opinion that disagrees was talked out of refusing, or one that went quiet made a plan more signable than one service alone would. It also fails when the Engine builds a Guard class the second-opinion structural test doesn't know. Never ship this red. |
| `reproducible` | Two release builds disagree, so a published CID cannot be checked against the source |
| `e2e` | The app is broken in a real browser against a real fork |

## Determinism rules

- Integration tests fork mainnet at `SPDEX_FORK_BLOCK` (`.env.defaults`).
  **Never change it to `latest`,** and never bump it to make a test pass —
  a drifting block silently invalidates every quote assertion in the repo.
- `scripts/anvil-fork.mjs` asserts the fork produced `SPDEX_FORK_BLOCK_HASH`
  at that height. If that check fails the upstream RPC is on a different chain;
  fix the RPC, do not relax the assertion.
- The vault's forge tests pin the same block, as `FORK_BLOCK` in
  `packages/vault/test/forge/utils/Fork.sol`, and the same rules apply. They
  fork it from `SPDEX_FORK_RPC_URL` themselves and move time with `vm.warp`,
  which stays inside each test's EVM. No test moves the shared fork's clock
  (`evm_increaseTime`, `anvil_setTime`): a timing edge that needs the clock
  moved belongs in forge.
- Keeper tests on the shared fork (integration, e2e, `pnpm keeper:smoke`) use
  fresh keys, an allowlist of their own vaults (`vaults`,
  `SPDEX_KEEPER_VAULTS`, or the Compose fork profile's `SPDEX_FORK_VAULTS`),
  `confirmations: 1` and `maxHeadLagSeconds: 0n`: the fork mines only when
  sent a transaction, and its idle head is days behind the wall clock. They
  never call `anvil_setNextBlockBaseFeePerGas` or `anvil_setMinGasPrice`, and
  never mine a block just to reach a confirmation. A fresh key is never an
  SPX holder, so a keeper test on a v2 vault either pays an eligible address
  (next rule) or waits for a vault whose community window has passed.
- Eligibility on the fork. anvil cannot prove a block it mined (its state
  root is zero), so every proof a test sends is a real mainnet one, for a real
  holder at a block up to the pinned one: recorded from the archive endpoint
  by `packages/vault/scripts/record-proofs.mjs` into
  `packages/vault/test/fixtures/proofs`, or, in the browser suite, built by
  the page from the fork's own answers for such a block. The registry checks
  a proven block's hash against the chain:
  `BLOCKHASH` for the last 256 blocks, the fork's EIP-2935 history contract
  for the last 8,191, both counted back from the fork's head. So a fork that
  has mined about 8,000 blocks can no longer prove the recorded blocks:
  restart `pnpm anvil:fork`, never bump the block. A proof lasts 30 days
  from its block's time, by the fork's clock. An eligible address that never signs (a keeper's or a batch's
  `rewardTo`) is a real holder proven from its recorded proof by a fresh key;
  read `validUntil` first, since on a reused fork it is proven already and the
  same proof again reverts `NotNewer`. An eligible address that must sign
  (Help run's connected wallet) is a fresh key that buys at least 690 SPX
  with a real swap on the fork and is then made eligible by writing its
  `validUntil` record with `anvil_setStorageAt` (the registry's slot 0, at
  `keccak256(abi.encode(key, 0))`, pinned by `test_validUntilIsMappingSlotZero`).
  That is the one write to the registry a test may make on the shared fork,
  and only for a fresh key: never for a real holder, never to SPX's balances,
  never to code (`writeEligibleOnFork`, `packages/testing/src/vaultFork.ts`).
  The mainnet smoke suite's rehearsal runs on a fork of its own, of today's
  chain, never this one, and `docs/MAINNET-SMOKE.md` says what it writes
  there. anvil's `finalized` block is its head − 64, which is a mainnet
  block, and so provable, only until 64 blocks are mined; a browser test that proves
  pins `finalized` to a forked block with `page.route`. A community window's
  edges are forge's (`vm.warp`); on the fork, exactly one integration case
  waits a 60-second window out in real time.
- A second opinion on the fork is the same fork under its other host name
  (`http://127.0.0.1:8545` and `http://localhost:8545`). Two forks of the
  pinned block are not an agreeing pair once either has mined anything: their
  histories differ, and the Guard is right to refuse them. A second service
  that lies, lags or goes quiet is made in the test itself (an in-process
  JSON-RPC proxy, `packages/guard/test/integration/proxy.ts`, or `page.route`
  in e2e), never by changing a fork. Help run the network's tests trigger
  only vaults they created from fresh keys, and untick every other vault the
  panel lists before anything is sent.
- The fork's clock runs on from the pinned block's time with the wall clock,
  and Chainlink's currency answers count as unknown once they are five days
  old by chain time (`FX_MAX_AGE_SECONDS`). A fork left up for about four
  days shows every currency but dollars as unavailable, which is the app
  being right: restart `pnpm anvil:fork`, never bump the block.
  `e2e/money.spec.ts` checks this first and says so.
- Modules must not read a clock or randomness. The sandbox has neither;
  natively they exist, and relying on them fails in QuickJS and in the
  conformance kit. Identical inputs must produce byte-identical output. The
  kit checks it by repeating each kind's characteristic call, which for a
  venue is `discoverPools`, not `buildCalls`; `parity` compares built calls
  across runtimes for a fixture venue, and nothing yet does for the shipped
  ones.

## Architectural rules that are not negotiable

1. **Modules never touch the signer, the network, storage, or the DOM.** They
   propose; the host performs. If you find yourself widening `VenueContext` to
   let a module do something directly, that is the bug.
2. **The Guard is not optional and has no bypass.** Every `TxPlan` reaches the
   signer through it, native runtime included. A native module is faster, never
   more trusted.
   The oracle layer is the exception to "the Guard decides": it produces
   *warnings* only and can never refuse a plan. An oracle that can block swaps
   is an oracle worth attacking into blocking them. Do not promote
   `ORACLE_DIVERGENCE` to a violation.
   Tip transfers go through `TipGuard` even though the host composes them
   itself. "We wrote it" is not an exemption, and `MAX_TOTAL_TIP_BPS` is a
   constant rather than a setting on purpose — do not make the ceiling
   configurable. A batch of tips through Permit2 adds a signature and a
   standing Permit2 permission, asked once and after the signature, so a
   wallet that can't sign typed data is never asked for it. Both go through
   `TipGuard` too (`checkSignature` and `checkPermission`, each before the
   wallet is asked): a signature request moves money as surely as a
   transaction does.
   Scheduled buys are the same case as tips. They go through
   `ScheduledBuyGuard`; it wraps the Guard rather than adding an option to it,
   a scheduled buy is never signed `unverified`, and
   `MIN_DCA_INTERVAL_SECONDS` is a constant for the same reason the tip
   ceiling is.
   So are the four vault transactions the host composes (create, fund, close,
   trigger), a fifth: a batch of other people's due vault buys sent from
   the person's own wallet (Help run the network), and a sixth: `prove`, a
   proof that an address held 690 SPX, sent to the release's SPX holder
   registry. They go through `VaultGuard`, and one that sends ether is never
   signed `unverified`, whatever `requireSimulation` says. On a v2 vault,
   **Trigger now** is `execute(owner)` sent by the owner, and the Guard
   refuses any other `rewardTo` or sender (a v1 vault's is `execute()`, as it
   always was). A batch is
   never signed `unverified` at all, is offered only with private sending and
   only when its buy fees cover its network fee, takes only vaults whose
   source takes `rewardTo` (v2's), pays nobody but the account (its
   `rewardTo`), goes only to the newest batcher at the gas per vault the host
   encodes, and lists only vaults the Guard has proved, from the host's
   per-vault claims (owner, nonce, terms), to be where a listed factory put
   them: the batcher is bound to no factory and calls whatever it is given. A `prove` is refused unless
   it goes to the release's registry, carries no ether, and its header hashes
   to that block's hash as the network service reports it, with both halves
   of the proof tied to that header's state root; it is simulated
   like any other, and, since it moves no money and a false proof only
   reverts, it is not on the list below: it follows `requireSimulation` and
   may be signed `unverified`. What else the Guard checks on a batch:
   `docs/THREAT-MODEL.md`, "Helping run the network".
   The second opinion (`guard.secondOpinion.url`) is part of the Guard, not
   beside it: every Guard the Engine builds that simulates runs through
   `AgreeingSimulationProvider` when one is set, and a structural red-team
   test fails on one it doesn't know. Its invariant: the second opinion is
   *unavailable* ("Checked on one service", `unverified`) only when the second
   service itself fails. Nothing the main service reports, or fails to
   answer, can produce that state, and a disagreement is a refusal on every
   path. Never let `unavailable` pass where a path never signs unchecked:
   under `requireSimulation`, a Permit2 permission, a vault transaction that
   sends ether, a batch, a scheduled buy. How the two are compared, and what
   they don't cover: `docs/THREAT-MODEL.md`, "A second opinion".
   The keeper is not the app and has no Guard, but the same idea bounds it:
   it signs only what `assertKeeperMaySign` (`keeper-send.ts`) allows —
   `executeBatch` to a listed batcher paying the configured `rewardTo` (from
   v2 at exactly its configured gas per vault), a listed batcher's
   deployment, a 0-value cancel to itself, a WETH unwrap
   when it is its own `rewardTo`, and, only when its operator opts in with
   `SPDEX_KEEPER_PROVE=1`, a `prove` to a listed release's registry whose
   holder is the configured `rewardTo`, none of them carrying ether — and
   everything else throws before the key is used. Widen that list and you
   widen what a bug, or an endpoint that lies, can get a hot key to sign. And
   since the batcher calls whatever it is given, the keeper batches only
   vaults it has proven its factory's clones (their address recomputed from
   owner, terms and nonce, `proveClones` in `keeper-read.ts`), never on an
   endpoint's word.
   Trackers are the opposite case: never in the path of a signature, so their
   output is display-only and every figure degrades to *unknown* rather than to
   zero. Do not let a routing decision read from one. Collective DCA
   (`packages/vault/src/platform.ts`) is host code under the same rule.
   Money rates (spDEX's 10-minute average for dollars, Chainlink's feeds for
   the other 16 currencies) are display too, with one exception that stays
   narrow: an amount typed in money is sized, once and visibly, into the token
   amount that is quoted, saved and signed. The Guard judges token amounts
   only, and a rate never refuses or changes a plan. Do not re-size a saved
   plan from a rate: a plan is its token amount.
3. **The capability broker is additive-only.** Add capabilities; never change
   an existing signature. A v1 module must still load on a v3 host.
4. **No telemetry, analytics, or error reporting.** Not behind a flag. Every
   request the app makes goes to the network service in use — the built-in one
   the disclaimer names, used by default only at its publisher's origin, or one
   the person chose — or the relay the person chose. A link
   the person clicks is fine; a fetch to anywhere else is not, and neither is
   a remote image, font, script or frame. The mechanical check is partial:
   `apps/web/src/no-requests.test.ts` (in `unit`) parses the app's, the host
   packages', the module SDK's and the first-party modules' source, and fails
   on any reference to `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`
   or `sendBeacon` (a call, or one kept to call later) and on `new Image(`
   beyond its allowed list, counted per file, and on a notification that
   would fetch an icon. It can't see a request made another way (a remote
   `src`, a stylesheet `url()`, a name built at run time), there is no lint
   rule (see the `lint` stage), and the CSP leaves `connect-src` open so
   users can choose any endpoint. So check any new request against the rule yourself, and add
   an allowance to that test only with where the request goes. Proving is
   no exception: the header and `eth_getProof` come from the network service
   in use, and when it refuses `eth_getProof` the app shows the requests to
   run against another service and checks what is pasted against its own;
   it never fetches them itself. The keeper and
   its report are operator tools, not the app: they contact only the endpoints
   their operator configures (an optional dead-man's-switch URL included), and
   the app never contacts a keeper. `index.ts` never re-exports them, with one
   exception: the keeper's pure planning in `keeper-plan.ts` (`selectBatch`,
   `batchGasLimit`, `modelBatchGas`, `earliestBuyAt`, the community window's
   arithmetic — `slotStartAt`, `dueSinceAt`, `communityWindowEndsAt`,
   `inCommunityWindow`, `urgentFrom` — and their constants), which Help run
   the network uses. It reads nothing, signs nothing and imports only types, the
   artifacts and the fee, and `boundaries.test.ts` pins exactly that. Nothing
   under `apps/web` imports `@spdex/vault/keeper` or any other keeper module
   (`boundaries.test.ts`).
5. **No backend.** The app is a static bundle. If a feature seems to need a
   server, it needs a module or a different design.
6. **No contract anyone controls.** The auto-buy vault, its factory, the
   batcher and the SPX holder registry (`packages/vault/contracts`) have no
   owner, admin, upgrade path, pause switch anyone else holds, or fee, and
   none may be added. That includes a setter, an initializer, a proxy whose
   implementation can change, a "guardian", or a fee "for keepers" routed
   anywhere but the `rewardTo` the caller of `execute` names (on a v1 vault,
   the caller itself). Two releases are on record: v1, on mainnet since block
   26,100,366 and unchanged for good, and v2, the current source, whose
   addresses in `deployments.json` are the ones this build deploys to (not
   yet deployed).
   - A vault's caller chooses *when* and, on a v2 vault, who receives the
     caller's own fee; nothing about the buy. So v1's `execute` takes no
     parameter and v2's exactly one, `rewardTo`, who receives the caller's own
     fee (decision 11 of `docs/V2_UPGRADE.md`); never give it another. The
     amount, the token, the recipient of what is bought,
     the market and the floor are fixed when the vault is created, and a
     forge fuzz test pins that any two `rewardTo` values a vault accepts make
     byte-identical buys (`testFuzz_anyTwoAcceptedRewardTosMakeTheSameBuy`).
     `rewardTo` may not be zero or the vault. For the community window, from
     when the buy fell due (`dueSince`) for `communityWindow` seconds, it must
     be the owner or pass the registry's `isEligible`, asked with a fixed gas
     stipend (`ELIGIBILITY_GAS`, 100,000: about nine times an honest answer,
     because no vault can ever be given more, and a fork that repriced cold
     reads past a smaller one would shut holders out of every window for
     good); any failure counts as not eligible, so a broken registry delays a
     buy at most until its window ends. A plan with turns (`turnBuckets`, a
     term: 0, or 2 to `MAX_TURN_BUCKETS`) also holds the window's first half
     to the eligible addresses in that slot's bucket (`bucketOf`, `turnOf`;
     `NotYourTurn`); the owner is never refused. A plan names a market only by
     its index in the factory's list, never by a token, pair or pool address.
   - The SPX holder registry (`SpxHolderRegistry`, from v2) is held to the
     same standard and decides one thing: whether a `rewardTo` may be paid
     inside a v2 vault's community window. It has no owner, setter, list or
     deposit, takes no ether, and never holds or moves anyone's tokens; its
     only storage is one `validUntil` time per address that has proven.
     `prove` records, from a block's own header and two Merkle-Patricia
     proofs, that an address held at least `MIN_SPX` when a recent block
     closed, and anyone may prove any address. `isEligible` is true while a
     proof is valid, the address is an account (no code, or only an EIP-7702
     delegation) and it holds `MIN_SPX` now. `MIN_SPX` (690 SPX) and
     `PROOF_TTL` (30 days) are constants for the reason the tip ceiling is:
     never make either a setting or a vault term; changing one is a new
     registry and a new release. Keep it accounts only: a contract can hand
     what it is paid to whoever asks (a pair's `skim`), so an eligible
     contract would let anyone take every window's fee
     (`test_aProvenContractThatHandsOutWhatItIsPaidIsNeverEligible`). The
     proof verifier under `contracts/vendor/optimism` is Optimism's, vendored
     with only its import paths changed; never edit it here.
   - The batcher (`SpdexVaultBatcher`) is held to the same standard. It has no
     owner, fee, setter or storage beyond a transient lock. It is one more
     caller of each vault's `execute`, and any change to it means a new
     address. v1's is bound to v1's factory, is paid as each vault's caller and
     forwards every reward, in the same transaction, to the `rewardTo` its own
     caller names, sweeping any WETH it holds. From v2 the batcher is bound to
     no factory: it is built for WETH alone, passes its caller's `rewardTo` to
     the `execute(rewardTo)` of each address its caller lists, and each vault
     pays that address directly, so no reward passes through it and it holds
     no WETH. So one batcher serves every release whose vaults take
     `rewardTo`, and a batch may mix them. It has no way to send WETH either,
     so WETH sent to it, or a fee a direct caller of a vault names it to
     receive after a window, is stranded there for good
     (`test_aFeeNamedToTheBatcherByADirectCallerStaysThere`). Never add a
     sweep: it would put WETH back through the batcher. Its `earned` is how
     much `rewardTo`'s WETH rose during the call, which nothing in the list
     can inflate without paying it; it trusts no vault's answer, which is why
     it needs no factory. It calls whatever it is given, so deciding which
     vaults are worth calling is its caller's: the keeper lists only vaults a
     listed factory's own list names, and the Guard's batch path checks every
     vault in a batch the app sends. The gas each vault's `execute` gets is the
     caller's (`gasPerVault`, `MIN_EXECUTE_GAS` to `MAX_EXECUTE_GAS`), so a
     fork that reprices a buy needs a new figure in the app and the keeper,
     never a new batcher. Either way the fee is the caller's own, paid where
     the caller chooses, not a fee routed elsewhere. `minRewards` is a
     condition the caller sets on its own transaction; a revert is the same
     as not sending.
   - The buy fee is each vault's `keeperReward`, fixed at creation and never
     changeable afterwards. The app's default for new vaults comes from
     `packages/vault/src/fee.ts`: one batched buy's network cost at release
     constants (`BATCHED_BUY_GAS`, 126,000 gas, × 0.15 gwei) plus 0.25% of the
     buy, never above 0.69% of the buy. v1's default was that network cost,
     at 122,000 gas, and a tenth more; every vault keeps the fee it was made
     with. The ceiling is the contract's `MAX_REWARD_BPS`, the whole fee with
     the network cost included: nobody who makes a buy, or is named to be
     paid for one, spDEX's developers among them, is ever paid more for it.
     Never raise it, and never add a second fee beside it. Changing the
     default under it is a release decision, never a setting on chain, and it
     only reaches plans created after the release. Do not make the ceiling
     configurable in the app: `VaultGuard` refuses a creation above it, and
     so does the factory.
   - The limits in `VaultLimits.sol` are constants, not terms, for the reason
     the tip ceiling is. Above all `MAX_FUNDING` (0.5 ETH, the hard cap on what
     an owner can put into a vault) stays a constant: it is what makes
     unaudited code a risk a person can decide to accept. So do v2's window
     bounds: `MIN_COMMUNITY_WINDOW` (60 seconds) and `MAX_COMMUNITY_WINDOW`
     (an hour), and `MAX_TURN_BUCKETS` (64). Every v2 vault has a window, and
     the factory also holds it to a quarter of the plan's interval, so a
     window always ends inside its slot. Turns ship unused: the app creates
     every vault with none (`DEFAULT_TURN_BUCKETS`, 0) until decision 29 of
     `docs/V2_UPGRADE.md` trips, when a new app build may create vaults with
     them and nothing is deployed. Nothing a fork can reprice may strand an
     owner's money: `close` returns the budget as WETH if WETH's `withdraw`
     (a 2,300-gas send to the clone) ever fails
     (`test_closeReturnsTheBudgetAsWethWhenUnwrappingFails`), and no gas
     figure a vault depends on may shrink.
   - The market list is fixed in the factory's constructor. Adding, removing
     or changing a market means a new factory at a new address, never an edit
     to this one. The same goes for any change to any of the four contracts.
     The factory names the registry in its constructor, so a new registry
     means a new factory too; the batcher names only WETH, so a fixed batcher
     is one more entry in `deployments.json`'s `batchers` and no new factory.
     A new market list or registry with the factory's code unchanged is a
     release built from an existing source: one more `releases` entry (its
     `source`, `registry`, `markets`, and `factory: null`), which
     `build:artifacts` fills in, and no code anywhere changes. One factory
     belongs to one release: the build refuses an entry that reuses one.
   - After any change under `contracts/`, regenerate `src/artifacts.ts`
     (`pnpm --filter @spdex/vault build:artifacts`), and never hand-edit it.
     The `contracts` stage refuses a stale copy. It carries every source of
     the contracts under its own prefix (`V1_*`, `V2_*`) and as data
     (`SOURCES`, each with `features` read from its ABIs: `executeTakesRewardTo`,
     `communityWindow`, `turns`, `registry`, `sharedBatcher`), the current
     source also under unprefixed names (`VAULT_ABI`, …, for creating vaults
     only), the latest release's addresses (`MAINNET_FACTORY`,
     `MAINNET_BATCHER`, `MAINNET_REGISTRY`, …), and the record (`DEPLOYMENTS`,
     `BATCHERS`). Code that handles a vault of any release goes by its
     release's source's features (`featuresOf`, `packages/vault/src/releases.ts`),
     never by a release's name: a release built from an existing source must
     need no code change. v1's source is built by forge's `v1` profile from
     `releases/v1/contracts`, a verbatim copy of the source v1 was deployed
     from. Never edit `releases/v1`: the build refuses to write unless it
     still gives v1's deployed factory and batcher. Before `contracts/`
     changes after a release built from it reaches mainnet, freeze it the
     same way (`releases/vN`, a profile, its `SOURCES` row in
     `build-artifacts.mjs` set frozen, and a row for the next source); the
     build refuses a deployed entry its source no longer builds to.
   - `packages/vault/deployments.json` is append-only: `{ "releases": [...],
     "batchers": [...] }`. v1's release keeps the five keys it was written
     with (`id`, `factory`, `batcher`, `factoryBlock`, `batcherBlock`); every
     later release records `id`, `source`, `factory`, `registry`, `markets`,
     `factoryBlock` and `registryBlock`, and every shared batcher `source`,
     `batcher` and `batcherBlock`. `build:artifacts` recomputes every entry
     from its source and refuses one that differs; it rewrites only a trailing
     entry not yet deployed (its blocks null), and appends the current
     source's release and batcher when nothing lists them. Once an entry's
     blocks are filled in by hand after its mainnet deployment (a release's
     `registryBlock` ≤ `factoryBlock`), it is frozen. Never remove or edit a
     deployed entry: keepers and reports serve every entry, so an entry
     removed is a release whose vaults nobody triggers.
   - The app, the keeper and the report trust only vaults a factory vouches
     for (`isVault`), and any factory in `DEPLOYMENTS`: v1's and v2's alike.
     The app lists, funds, closes and triggers vaults from every listed
     factory, and creates only on the latest. The factory's vault list
     (`vaultCount`, `vaultsPage`) is append-only and changes nothing about
     trust: membership is `isVault`, written in the same call. All of them
     treat a vault figure they cannot read as unknown, never as zero.

## Layout

```
packages/core       types + zod schemas (TxPlan is a signable intent, not a fire-once object)
packages/chain      Multicall3 (pinnable to a block), httpRpc, SimulationProvider, TWAP oracle,
                    fx.ts (Chainlink's 16 currency feeds and USDC/USD, read in one call), a
                    local-key signer (the keeper's), header.ts (a block header rebuilt as RLP
                    and checked against the block's hash, and `eth_getProof`)
packages/guard      static checks → simulation → oracle cross-check; tip, scheduled-buy
                    and vault paths (the batch and `prove` paths included); second-opinion.ts
                    (every test-run on two services, compared)
packages/host       capability broker, runtimes/{native,quickjs}, KIND_SPECS (a row per kind)
packages/router     split routing (host-side on purpose — it decides where money goes)
packages/config     versioned SpdexConfig (v9) + migrations + presets + auto-buy plan edits
packages/vault      the auto-buy vault: contracts/ (Solidity 0.8.33, unaudited, the current
                    release, v2; SpdexVaultFactory, SpdexDcaVault, SpdexVaultBatcher (bound to no factory),
                    VaultLimits,
                    SpxHolderRegistry; vendor/optimism: Optimism's MIT trie and RLP verifier,
                    pinned to a commit, only its import paths changed), releases/v1/ (the source
                    v1 was deployed from, frozen, built by forge's `v1` profile), test/forge/
                    (forge fork tests), test/fixtures/proofs (mainnet proofs for the registry's
                    tests, recorded by scripts/record-proofs.mjs), deployments.json (append-only
                    record: releases and batchers), src/artifacts.ts (generated — never hand-edit;
                    every source prefixed, `SOURCES` with its features, the current source also
                    unprefixed), src/releases.ts (a release's source, features, factory and
                    batcher, by data), src/index.ts (encoders, readVault, availability, turns,
                    findVaultsByOwner, the factories' lists), src/registry.ts (an address's
                    eligibility, building, checking and pasting a proof, `encodeProve`; shared by
                    the app and the keeper), src/fee.ts (the buy fee),
                    src/batcher.ts (encoders and decoders for the batcher), src/platform.ts
                    (Collective DCA: every listed vault's figures at one block, and which are
                    due now for Help run the network; host code); keeper-plan's pure
                    selection, re-exported for Help run the network;
                    behind `@spdex/vault/keeper` only: src/keeper.ts (the tick) with keeper-plan,
                    -send (the one nonce manager), -state, -log and -config; src/report.ts (the
                    report's aggregation, imported only by its script); scripts/keeper.ts
                    (`pnpm keeper`), keeper-report.ts (`pnpm keeper:report`), keeper-health.mjs,
                    keeper-smoke.mjs (`pnpm keeper:smoke`); operator tools the app never imports
docker/keeper       the keeper's image and Compose file (keeper, report, and a fork-only profile);
                    docs/KEEPER.md runs it
packages/module-sdk authoring kit + conformance suite (MIT; the rest is AGPL)
packages/testing    anvil fixtures, fork helpers (src/vaultFork.ts: releases, the recorded holder,
                    an eligible fresh key, imported by path), headless EIP-1193 wallet
e2e-mainnet         the mainnet smoke suite: agent wallets, an allowlist and a spending limit
                    on every transaction, Playwright specs (docs/MAINNET-SMOKE.md); not a gate stage
modules/            first-party modules; same interface as any stranger's
  venue-uniswap-v2/v3  kind: venue
  tiplist-spx-community  kind: tiplist — no capabilities, no contracts
  tracker-pool-stats     kind: tracker — chain:read on three token contracts
  scheduler-dca          kind: scheduler — no capabilities, no contracts
apps/web            Vite SPA; src/lib/dca: auto-buy runner, ledger, vault.ts (vault plans of
                    either release: reads, the four transactions, Trigger now as `execute(owner)`
                    on v2, chain time), factoryListSearch.ts (finding vaults by their owner()
                    when log searches are refused) and advisory.ts (decision 31's registry
                    notice: null until a build needs it);
                    src/components/dca: the auto-buy screens, driven by lib/dca/useAutoBuy.ts
                    lib/money + components/money: amounts typed in 17 currencies (input only:
                    parse, size, convert), the rates, number styles, the currency menu
                    lib/records + components/records: Your activity, its CSV and statement;
                    lib/reminders: calendar files, the buy-due notification and the proof-lapse
                    one (lapse.ts); lib/finality.ts
                    + components/trust: the Sent → Included → Final badge
                    lib/culture + components/culture: Welcome, Your stack, the "I bought" card,
                    the #receipt= view, saying lines, preset amounts
                    lib/network + components/network: Collective DCA, Help run the network
                    (batch.ts: a batch of due v2 vault buys from the person's wallet, private
                    sending only, inside a community window for an eligible wallet only), its
                    Community keeping fold (keeping.ts, CommunityKeeping.tsx: eligibility,
                    Prove my SPX, Prove another address, paste a proof), the second-opinion
                    setting, and Trust and exits
                    lib/links.ts: the two release addresses, build settings, never guessed;
                    lib/download.ts: every file the app hands over; src/no-requests.test.ts (rule 4)
```

## Local setup

```bash
pnpm install
pnpm verify              # works immediately; fork stages skip without Foundry
```

The fork must be running for the chain-backed stages:

```bash
pnpm anvil:fork          # separate terminal; verifies its own block hash
pnpm verify --strict
```

Playwright starts the web server itself. On NixOS set `SPDEX_CHROMIUM_PATH` —
see `docs/DEVELOPMENT.md`.

Fork stages need Foundry (`anvil`, and `forge` for `contracts`): see
`docs/DEVELOPMENT.md`, "Installing Foundry" (NixOS included).

The `contracts` stage needs `forge` and an archive endpoint in
`SPDEX_FORK_RPC_URL` (in `.env.local`). It does not need the local fork, and
it never uses it. Run forge through `node packages/vault/scripts/forge.mjs`,
which passes it the repo's `.env` files and the pinned solc. `pnpm keeper`
needs Node 22.15 or later.

Running a keeper, the report and the Docker image are `docs/KEEPER.md`'s.
`pnpm keeper:smoke` checks the image end to end against the local fork (it
needs Docker and `pnpm anvil:fork`); it is not a `pnpm verify` stage.

`pnpm mainnet:smoke` (`docs/MAINNET-SMOKE.md`, `e2e-mainnet/`) drives the
published app with three agent wallets against Ethereum, or against a fork of
today's chain (`pnpm mainnet:smoke:fork`, :8547, never the pinned one). It is
not a `pnpm verify` stage and never becomes one. A mainnet run spends real
ether: run one only within the limits the wallets' owner set
(`SPDEX_SMOKE_*`), rehearse any change to the suite on the fork first, and
never point the keystores at a fork. Every transaction it signs goes through
`e2e-mainnet/wallet.ts`'s checks; widen its allowlist only with where the new
transaction goes, as for rule 4's test.
