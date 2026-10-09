# AGENTS.md — spDEX

Read this before changing anything. It exists so an AI agent can work here
unattended and know whether it succeeded.

## The one command

```bash
pnpm verify          # every gate; exit 0 = green
pnpm verify --strict # same, but a SKIPPED stage is a failure
pnpm verify --json   # machine-readable to stdout
pnpm verify --only=typecheck,unit,redteam   # runs in the gate's order, not this one
```

Results land in `.verify/report.json` (`schema: spdex.verify/1`). **Read that
file, not stdout.** Each stage reports `passed | failed | skipped | empty`, and
a skip carries a `reason`. An unknown argument or stage id runs nothing and
exits 2, with `ok` false and `error` naming the valid stages.

**A skip is not a pass.** Stages needing Foundry, a browser or an archive
endpoint skip without them, so a green `pnpm verify` on a bare machine may have
exercised half the repo. **Neither is `empty`**: a stage that matched zero test
files. Use `--strict` whenever the answer matters; it fails on both. CI always
runs `--strict`.

## What each stage proves

| Stage | A failure means |
|---|---|
| `typecheck` | Types are wrong |
| `lint` | Nothing: no package defines a `lint` script, so it runs nothing and cannot fail. Rule 4's partial check is `apps/web/src/no-requests.test.ts`, in `unit` |
| `unit` | Logic is wrong (mocked RPC, no network) |
| `integration` | Logic disagrees with the real chain (pinned fork) |
| `contracts` | The vault contracts break a rule their forge tests pin, on a mainnet fork at the pinned block (registry included: real recorded proofs, false ones, fuzzed headers and trie nodes); or `packages/vault/src/artifacts.ts` is stale: the addresses the app and keeper ship aren't what the source builds to, a frozen source (`packages/vault/releases/v1`) no longer builds to its deployed addresses, or `deployments.json` isn't what this build makes of it. Runs `build-artifacts.mjs --check`, then `forge test`. Skips without `forge` or `SPDEX_FORK_RPC_URL`. The forge tests fork from that endpoint themselves, so a rate limit (HTTP 429) fails the stage with no assertion failing: read the output before believing a red |
| `conformance` | A module violates the interface, or escaped its sandbox |
| `parity` | Native and QuickJS runtimes disagree on fixture modules of every loadable kind. Shipped modules check their own parity: tip list, tracker and scheduler in `unit` (whole outputs), venues in `integration` (pool discovery and quotes, not the calls that get signed) |
| `redteam` | **The Guard let a malicious plan through**: a swap, a tip, a scheduled buy, a vault transaction (a creation above the fee ceiling, a **Trigger now** paying anyone but the owner, a `prove` sent anywhere but the release's registry, carrying ether or built on the wrong block), or a Help run batch paying anyone but the account; or a disagreeing second opinion was talked out of refusing, or a silent one made a plan more signable than one service alone. Also fails when the Engine builds a Guard class the second-opinion structural test doesn't know. **Never ship this red.** |
| `reproducible` | Two release builds disagree, so a published CID can't be checked against the source |
| `e2e` | The app is broken in a real browser against a real fork |

## Determinism rules

- **The pinned block.** Integration tests fork mainnet at `SPDEX_FORK_BLOCK`
  (`.env.defaults`); the forge tests pin the same block as `FORK_BLOCK`
  (`packages/vault/test/forge/utils/Fork.sol`). **Never change it to `latest`
  and never bump it to make a test pass:** a drifting block silently
  invalidates every quote assertion. `scripts/anvil-fork.mjs` asserts the fork
  produced `SPDEX_FORK_BLOCK_HASH`; if that fails, the upstream RPC is on
  another chain: fix the RPC, never the assertion.
- **The fork's clock.** Forge tests fork from `SPDEX_FORK_RPC_URL` themselves
  and move time with `vm.warp`, inside each test's EVM. No test moves the
  shared fork's clock (`evm_increaseTime`, `anvil_setTime`): a timing edge
  that needs it belongs in forge. The shared fork's clock runs on with the wall
  clock, and Chainlink's answers count as unknown at five days old
  (`FX_MAX_AGE_SECONDS`), so a fork up for about four days shows every currency
  but dollars as unavailable (`e2e/money.spec.ts` checks this first). Restart
  `pnpm anvil:fork`; never bump the block.
- **Keeper tests on the shared fork** (integration, e2e, `pnpm keeper:smoke`)
  use fresh keys, an allowlist of their own vaults (`vaults`,
  `SPDEX_KEEPER_VAULTS`, or the Compose fork profile's `SPDEX_FORK_VAULTS`),
  `confirmations: 1` and `maxHeadLagSeconds: 0n`: the fork mines only when sent
  a transaction, and its idle head is days behind the wall clock. They never
  call `anvil_setNextBlockBaseFeePerGas` or `anvil_setMinGasPrice`, and never
  mine a block just to reach a confirmation. A fresh key is never an SPX
  holder, so a keeper test pays an eligible address (next rule) or waits out a
  vault's community window.
- **Eligibility on the fork.** anvil can't prove a block it mined (its state
  root is zero), so every proof a test sends is a real mainnet one, for a real
  holder at a block up to the pinned one: recorded by
  `packages/vault/scripts/record-proofs.mjs` into
  `packages/vault/test/fixtures/proofs`, or, in the browser suite, built by the
  page from the fork's answers for such a block.
  - The registry checks a proven block's hash with `BLOCKHASH` (last 256
    blocks) or the EIP-2935 history contract (last 8,191), counted from the
    fork's head. A fork that has mined about 8,000 blocks can no longer prove
    the recorded blocks: restart it, never bump the block. A proof lasts 30
    days from its block's time, by the fork's clock.
  - An eligible address that never signs (a keeper's or batch's `rewardTo`)
    is a real holder, proven from its recorded proof by a fresh key. Read
    `validUntil` first: on a reused fork it is proven already, and the same
    proof again reverts `NotNewer`.
  - An eligible address that must sign (Help run's connected wallet) is a
    fresh key that buys at least 690 SPX with a real swap on the fork, then has
    its `validUntil` written with `anvil_setStorageAt` (registry slot 0, at
    `keccak256(abi.encode(key, 0))`, pinned by
    `test_validUntilIsMappingSlotZero`; `writeEligibleOnFork` in
    `packages/testing/src/vaultFork.ts`). That is the only write to the
    registry a test may make, only for a fresh key: never for a real holder,
    never to SPX's balances, never to code.
  - anvil's `finalized` block is its head − 64: a mainnet block, so provable,
    only until 64 blocks are mined. A browser test that proves pins
    `finalized` to a forked block with `page.route`.
  - A community window's edges are forge's (`vm.warp`); on the fork, exactly
    one integration case waits a 60-second window out in real time.
  - The mainnet smoke rehearsal runs on its own fork of today's chain, never
    this one (`docs/MAINNET-SMOKE.md` says what it writes there).
- **A second opinion on the fork** is the same fork under its other host name
  (`http://127.0.0.1:8545` and `http://localhost:8545`). Two forks of the
  pinned block are not an agreeing pair once either has mined: their histories
  differ, and the Guard is right to refuse them. A second service that lies,
  lags or goes quiet is made in the test (an in-process JSON-RPC proxy,
  `packages/guard/test/integration/proxy.ts`, or `page.route` in e2e), never by
  changing a fork. Help run tests trigger only vaults they created from fresh
  keys, and untick every other vault the panel lists before sending.
- **Modules read no clock or randomness.** The sandbox has neither, so relying
  on them fails in QuickJS and in the conformance kit. Identical inputs must
  give byte-identical output. The kit repeats each kind's characteristic call
  (for a venue, `discoverPools`, not `buildCalls`); `parity` compares built
  calls across runtimes for a fixture venue only, not the shipped ones.

## Architectural rules that are not negotiable

1. **Modules never touch the signer, the network, storage, or the DOM.** They
   propose; the host performs. If you are widening `VenueContext` to let a
   module do something directly, that is the bug.

2. **The Guard is not optional and has no bypass.** Every `TxPlan` reaches the
   signer through it, native runtime included: a native module is faster,
   never more trusted.
   - **The oracle only warns.** It can never refuse a plan: an oracle that can
     block swaps is worth attacking into blocking them. Never promote
     `ORACLE_DIVERGENCE` to a violation.
   - **Tips** go through `TipGuard`, though the host composes them: "we wrote
     it" is no exemption. `MAX_TOTAL_TIP_BPS` is a constant, never a setting.
     A batch of tips through Permit2 adds a signature and a standing Permit2
     permission, asked once and after the signature (so a wallet that can't
     sign typed data is never asked for it); both go through `TipGuard`
     (`checkSignature`, `checkPermission`) before the wallet is asked. A
     signature request moves money as surely as a transaction.
   - **Scheduled buys** go through `ScheduledBuyGuard`, which wraps the Guard
     rather than adding an option to it. A scheduled buy is never signed
     `unverified`, and `MIN_DCA_INTERVAL_SECONDS` is a constant.
   - **Vault transactions** go through `VaultGuard`: the four the host
     composes (create, fund, close, trigger), a batch of other people's due
     buys sent from the person's wallet (Help run the network), and `prove`
     (a proof that an address held 690 SPX, sent to the release's registry).
     One that sends ether is never signed `unverified`, whatever
     `requireSimulation` says.
     - **Trigger now** is `execute(owner)` sent by the owner; the Guard
       refuses any other `rewardTo` or sender. (A vault from the earlier test
       deployment takes `execute()`.)
     - **A batch** is never signed `unverified`; is offered only with private
       sending and only when its buy fees cover its network fee; takes only
       vaults whose source takes `rewardTo`; pays nobody but the account (its
       `rewardTo`); goes only to the newest batcher, at the gas per vault the
       host encodes; and lists only vaults the Guard has proved, from the
       host's per-vault claims (owner, nonce, terms), to be where a listed
       factory put them, since the batcher calls whatever it is given. The
       rest: `docs/THREAT-MODEL.md`, "Helping run the network".
     - **A `prove`** is refused unless it goes to the release's registry,
       carries no ether, and its header hashes to that block's hash as the
       network service reports it, with both halves of the proof tied to the
       header's state root. It is simulated like any other; since it moves no
       money and a false proof only reverts, it follows `requireSimulation`
       and may be signed `unverified`.
   - **The second opinion** (`guard.secondOpinion.url`) is part of the Guard:
     every Guard the Engine builds that simulates runs through
     `AgreeingSimulationProvider` when one is set, and a structural red-team
     test fails on one it doesn't know. The second opinion is *unavailable*
     ("Checked on one service", `unverified`) only when the second service
     itself fails: nothing the main service reports or fails to answer can
     produce that state, and a disagreement is a refusal on every path. Never
     let `unavailable` pass where a path never signs unchecked: under
     `requireSimulation`, a Permit2 permission, a vault transaction that sends
     ether, a batch, a scheduled buy. How the two are compared, and what they
     don't cover: `docs/THREAT-MODEL.md`, "A second opinion".
   - **The keeper** has no Guard, but the same idea bounds it: it signs only
     what `assertKeeperMaySign` (`keeper-send.ts`) allows, none of it carrying
     ether, and throws before the key is used for anything else:
     `executeBatch` to a listed batcher paying the configured `rewardTo` (at
     exactly its configured gas per vault, for a shared batcher); a listed
     batcher's deployment; a 0-value cancel to itself; a WETH unwrap when it
     is its own `rewardTo`; and, only with `SPDEX_KEEPER_PROVE=1`, a `prove`
     to a listed release's registry for the configured `rewardTo`. Widen that
     list and you widen what a bug, or a lying endpoint, can get a hot key to
     sign. Since the batcher calls whatever it is given, the keeper batches
     only vaults it has proven its factory's clones (address recomputed from
     owner, terms and nonce: `proveClones`, `keeper-read.ts`), never on an
     endpoint's word.
   - **Trackers** are never in the path of a signature: their output is
     display-only, and every figure degrades to *unknown*, never zero. No
     routing decision reads one. Collective DCA (`packages/vault/src/platform.ts`)
     is host code under the same rule.
   - **Money rates** (spDEX's 10-minute average for dollars, Chainlink's feeds
     for 16 other currencies) are display too, with one narrow exception: an
     amount typed in money is sized, once and visibly, into the token amount
     that is quoted, saved and signed. The Guard judges token amounts only;
     a rate never refuses or changes a plan. Never re-size a saved plan from a
     rate: a plan is its token amount.

3. **The capability broker is additive-only.** Add capabilities; never change
   an existing signature. A module written for an older host must still load
   on every newer one.

4. **No telemetry, analytics, or error reporting.** Not behind a flag. Every
   request the app makes goes to the network service in use (the one the
   person chose on the first screen; the built-in one the disclaimer names is
   among the choices and never used without asking) or the relay the person
   chose. A link the person clicks is fine; a fetch anywhere else is not, nor a
   remote image, font, script or frame.
   - The mechanical check is partial. `apps/web/src/no-requests.test.ts` (in
     `unit`) parses the app's, host packages', module SDK's and first-party
     modules' source, and fails on any reference to `fetch`, `XMLHttpRequest`,
     `WebSocket`, `EventSource` or `sendBeacon` (a call, or one kept to call
     later), on `new Image(` beyond its allowed list (counted per file), and
     on a notification that would fetch an icon. It can't see a request made
     another way (a remote `src`, a stylesheet `url()`, a name built at run
     time), there is no lint rule, and the CSP leaves `connect-src` open so
     users can choose any endpoint. Check every new request against the rule
     yourself, and add an allowance to that test only with where it goes.
   - Proving is no exception: the header and `eth_getProof` come from the
     service in use. When it refuses `eth_getProof`, the app shows the
     requests to run against another service and checks what is pasted
     against its own; it never fetches them itself.
   - The keeper and its report are operator tools: they contact only the
     endpoints their operator configures (an optional dead-man's-switch URL
     included), and the app never contacts a keeper. `index.ts` never
     re-exports them, except the keeper's pure planning in `keeper-plan.ts`
     that Help run uses (`selectBatch`, `batchGasLimit`, `modelBatchGas`,
     `earliestBuyAt`, the community window's arithmetic `slotStartAt`,
     `dueSinceAt`, `communityWindowEndsAt`, `inCommunityWindow`, `urgentFrom`,
     and their constants). It reads nothing, signs nothing, and imports only
     types, the artifacts and the fee. Nothing under `apps/web` imports
     `@spdex/vault/keeper` or any other keeper module. `boundaries.test.ts`
     pins both.

5. **No backend.** The app is a static bundle. If a feature seems to need a
   server, it needs a module or a different design.

6. **No contract anyone controls.** The vault, its factory, the batcher and
   the SPX holder registry (`packages/vault/contracts`) have no owner, admin,
   upgrade path, pause switch anyone else holds, or fee, and none may be
   added: no setter, initializer, proxy with a changeable implementation,
   "guardian", or fee "for keepers" routed anywhere but the `rewardTo` the
   caller of `execute` names. They are on mainnet and unchanged for good: the
   registry since block 26,134,915, the factory 26,134,916, the shared batcher
   26,134,918. An earlier test deployment (release id `v1`, factory block
   26,100,366, its source frozen in `packages/vault/releases/v1`) is still
   listed and served. Freeze the current source, as below, before anything
   under `contracts/` changes.
   - **The caller of a vault chooses when, and who receives the caller's own
     fee; nothing about the buy.** `execute` takes exactly one parameter,
     `rewardTo` (decision 11 of `docs/DESIGN.md`); never give it another. (The
     earlier test deployment's `execute()` takes none and pays its caller.)
     The amount, token, recipient, market and floor are fixed at creation; a
     forge fuzz test pins that any two accepted `rewardTo`s make byte-identical
     buys (`testFuzz_anyTwoAcceptedRewardTosMakeTheSameBuy`). `rewardTo` may
     not be zero or the vault. For `communityWindow` seconds after the buy fell
     due (`dueSince`), it must be the owner or pass the registry's
     `isEligible`, asked with a fixed gas stipend (`ELIGIBILITY_GAS`, 100,000,
     about nine times an honest answer: no vault can ever be given more, and a
     fork that repriced cold reads past a smaller one would shut holders out
     of every window for good). Any failure counts as not eligible, so a
     broken registry delays a buy at most until its window ends. A plan with
     turns (`turnBuckets`: 0, or 2 to `MAX_TURN_BUCKETS`) also holds the
     window's first half to the eligible addresses in that slot's bucket
     (`bucketOf`, `turnOf`; `NotYourTurn`); the owner is never refused. A plan
     names a market only by its index in the factory's list, never by a token,
     pair or pool address.
   - **The SPX holder registry** (`SpxHolderRegistry`) decides one thing:
     whether a `rewardTo` may be paid inside a community window. It has no
     owner, setter, list or deposit, takes no ether, never holds or moves
     tokens, and stores only one `validUntil` per proven address. `prove`
     records, from a block's own header and two Merkle-Patricia proofs, that an
     address held at least `MIN_SPX` when a recent block closed; anyone may
     prove any address. `isEligible` is true while a proof is valid, the
     address is an account (no code, or only an EIP-7702 delegation) and holds
     `MIN_SPX` now. `MIN_SPX` (690 SPX) and `PROOF_TTL` (30 days) are
     constants, never a setting or a vault term: changing one is a new registry
     and a new contract release. Keep it accounts only: a contract can hand
     what it is paid to whoever asks (a pair's `skim`), so an eligible
     contract would let anyone take every window's fee
     (`test_aProvenContractThatHandsOutWhatItIsPaidIsNeverEligible`). The proof
     verifier under `contracts/vendor/optimism` is Optimism's, with only its
     import paths changed; never edit it here.
   - **The batcher** (`SpdexVaultBatcher`) has no owner, fee, setter or storage
     beyond a transient lock, and is bound to no factory: built for WETH alone,
     it passes its caller's `rewardTo` to the `execute(rewardTo)` of each
     address listed, and each vault pays that address directly, so no reward
     passes through it and it holds no WETH. One batcher serves every release
     whose vaults take `rewardTo`, and a batch may mix them. It has no way to
     send WETH, so WETH sent to it, or a fee a direct caller names it to
     receive after a window, is stranded for good
     (`test_aFeeNamedToTheBatcherByADirectCallerStaysThere`); never add a
     sweep. Its `earned` is how much `rewardTo`'s WETH rose during the call,
     which nothing listed can inflate without paying it, so it trusts no
     vault's answer. It calls whatever it is given: the keeper lists only
     vaults a listed factory's list names, and the Guard checks every vault in
     a batch the app sends. Each vault's gas is the caller's (`gasPerVault`,
     `MIN_EXECUTE_GAS` to `MAX_EXECUTE_GAS`), so a fork that reprices a buy
     needs a new figure in the app and keeper, never a new batcher.
     `minRewards` is a condition the caller sets on its own transaction; a
     revert is the same as not sending. Any change to the batcher is a new
     address. (The earlier test deployment's batcher is bound to its factory,
     is paid as each vault's caller and forwards rewards to its caller's
     `rewardTo`.)
   - **The buy fee** is each vault's `keeperReward`, fixed at creation. The
     app's default for new vaults (`packages/vault/src/fee.ts`): one batched
     buy's network cost at release constants (`BATCHED_BUY_GAS`, 126,000 gas,
     × 0.15 gwei) plus 0.25% of the buy, never above 0.69%. The ceiling is the
     contract's `MAX_REWARD_BPS`, network cost included: nobody who makes a
     buy or is named to be paid for one, spDEX's developers included, is ever
     paid more. Never raise it, never add a second fee, never make it
     configurable in the app (`VaultGuard` refuses a creation above it, and so
     does the factory). Changing the default under it is a release decision,
     never a setting on chain, and reaches only plans created after the
     release; every vault keeps the fee it was made with (the earlier test
     deployment's: that network cost at 122,000 gas, plus a tenth).
   - **The limits in `VaultLimits.sol` are constants, not terms.** Above all
     `MAX_FUNDING` (0.5 ETH, the most an owner can put into a vault): it is
     what makes unaudited code a risk a person can decide to accept. Likewise
     `MIN_COMMUNITY_WINDOW` (60 seconds), `MAX_COMMUNITY_WINDOW` (an hour) and
     `MAX_TURN_BUCKETS` (64). Every vault has a window, held by the factory to
     a quarter of the plan's interval, so it ends inside its slot. Turns ship
     unused: the app creates vaults with none (`DEFAULT_TURN_BUCKETS`, 0)
     until decision 29 of `docs/DESIGN.md` trips; then a new app build may use
     them, and nothing is deployed. Nothing a fork can reprice may strand an
     owner's money: `close` returns the budget as WETH if WETH's `withdraw` (a
     2,300-gas send to the clone) fails
     (`test_closeReturnsTheBudgetAsWethWhenUnwrappingFails`), and no gas
     figure a vault depends on may shrink.
   - **Every change is a new address.** The market list is fixed in the
     factory's constructor, and so is the registry: a new market or registry
     is a new factory. The batcher names only WETH, so a fixed batcher is one
     more `batchers` entry and no new factory. A new market list or registry
     with the factory's code unchanged is a release from an existing source:
     one more `releases` entry (`source`, `registry`, `markets`, `factory:
     null`), which `build:artifacts` fills in, and no code changes. One factory
     belongs to one release; the build refuses an entry that reuses one.
   - **`src/artifacts.ts` is generated.** After any change under `contracts/`,
     run `pnpm --filter @spdex/vault build:artifacts`; never hand-edit it (the
     `contracts` stage refuses a stale copy). It carries every source under
     its own prefix (`V1_*`, `V2_*`) and as data (`SOURCES`, each with
     `features` read from its ABIs: `executeTakesRewardTo`, `communityWindow`,
     `turns`, `registry`, `sharedBatcher`); the current source also unprefixed
     (`VAULT_ABI`, …, for creating vaults only); the latest release's
     addresses (`MAINNET_FACTORY`, `MAINNET_BATCHER`, `MAINNET_REGISTRY`, …);
     and the record (`DEPLOYMENTS`, `BATCHERS`). Code that handles a vault goes
     by its release's source's features (`featuresOf`,
     `packages/vault/src/releases.ts`), never by a release's name: a release
     from an existing source must need no code change.
   - **Frozen sources.** `releases/v1/contracts` is a verbatim copy of the
     earlier test deployment's source, built by forge's `v1` profile; never
     edit it: the build refuses to write unless it still gives that
     deployment's factory and batcher. Before `contracts/` changes after a
     release built from it reaches mainnet (the current source has), freeze
     it the same way: `releases/vN`, a profile, its `SOURCES` row in
     `build-artifacts.mjs` set frozen, and a row for the next source. The build
     refuses a deployed entry its source no longer builds to.
   - **`packages/vault/deployments.json` is append-only**: `{ "releases":
     [...], "batchers": [...] }`. The `v1` entry keeps the five keys it was
     written with (`id`, `factory`, `batcher`, `factoryBlock`,
     `batcherBlock`); every later release records `id`, `source`, `factory`,
     `registry`, `markets`, `factoryBlock` and `registryBlock`, and every
     shared batcher `source`, `batcher` and `batcherBlock`. `build:artifacts`
     recomputes every entry and refuses one that differs; it rewrites only a
     trailing entry not yet deployed (blocks null) and appends the current
     source's release and batcher when nothing lists them. Once an entry's
     blocks are filled in by hand after deployment (`registryBlock` ≤
     `factoryBlock`), it is frozen. Never remove or edit a deployed entry:
     keepers and reports serve every entry, so a removed one is a release whose
     vaults nobody triggers.
   - **Trust is `isVault`.** The app, keeper and report trust only vaults a
     factory in `DEPLOYMENTS` vouches for. The app lists, funds, closes and
     triggers vaults from every listed factory, and creates only on the latest.
     A factory's vault list (`vaultCount`, `vaultsPage`) is append-only and
     changes nothing about trust: membership is `isVault`, written in the same
     call. A vault figure nobody can read is unknown, never zero.

## Layout

```
packages/core       types + zod schemas (TxPlan is a signable intent, not a fire-once object)
packages/chain      Multicall3 (pinnable to a block), httpRpc, SimulationProvider, TWAP oracle,
                    fx.ts (Chainlink's 16 currency feeds and USDC/USD in one call), a local-key
                    signer (the keeper's), header.ts (a header rebuilt as RLP and checked against
                    its block's hash; `eth_getProof`), scripts/fx-bands.ts (`pnpm fx:bands`)
packages/guard      static checks → simulation → oracle cross-check; tip, scheduled-buy and vault
                    paths (batch and `prove` included); second-opinion.ts (each test-run on two
                    services, compared)
packages/host       capability broker, runtimes/{native,quickjs}, KIND_SPECS (a row per kind)
packages/router     split routing (host-side on purpose: it decides where money goes)
packages/config     versioned SpdexConfig (v9) + migrations + presets + auto-buy plan edits
packages/vault      contracts/ (Solidity 0.8.33, unaudited: SpdexVaultFactory, SpdexDcaVault,
                    SpdexVaultBatcher, VaultLimits, SpxHolderRegistry; vendor/optimism: Optimism's
                    MIT trie and RLP verifier, pinned to a commit); releases/v1/ (the earlier test
                    deployment's frozen source); test/forge/ (fork tests); test/fixtures/proofs
                    (mainnet proofs, recorded by scripts/record-proofs.mjs); deployments.json
                    (append-only record); src/artifacts.ts (generated, never hand-edited);
                    src/releases.ts (each release's source, features, factory and batcher);
                    src/index.ts (encoders, readVault, availability, turns, findVaultsByOwner, the
                    factories' lists); src/registry.ts (eligibility; building, checking and
                    pasting a proof; `encodeProve`; app and keeper); src/fee.ts (the buy fee);
                    src/batcher.ts; src/platform.ts (Collective DCA, and which buys are due for
                    Help run; host code); keeper-plan's pure selection, re-exported for Help run.
                    Behind `@spdex/vault/keeper` only, never imported by the app: src/keeper.ts
                    (the tick) with keeper-plan, -send (the one nonce manager), -state, -log,
                    -config; src/report.ts; scripts/keeper.ts (`pnpm keeper`), keeper-report.ts
                    (`pnpm keeper:report`), keeper-health.mjs, keeper-smoke.mjs (`pnpm keeper:smoke`)
docker/keeper       the keeper's image and Compose file (keeper, report, a fork-only profile);
                    docs/KEEPER.md runs it
packages/module-sdk authoring kit + conformance suite (MIT; the rest is AGPL)
packages/testing    anvil fixtures, fork helpers (src/vaultFork.ts: releases, the recorded holder,
                    an eligible fresh key; imported by path), headless EIP-1193 wallet
e2e-mainnet         the mainnet smoke suite (docs/MAINNET-SMOKE.md); not a gate stage
modules/            first-party modules; same interface as any stranger's
  venue-uniswap-v2/v3    kind: venue
  tiplist-spx-community  kind: tiplist — no capabilities, no contracts
  tracker-pool-stats     kind: tracker — chain:read on three token contracts
  scheduler-dca          kind: scheduler — no capabilities, no contracts
apps/web            Vite SPA
  lib/dca             auto-buy runner, ledger, vault.ts (reads, the four transactions, Trigger now,
                      chain time), factoryListSearch.ts (finding vaults by owner() when log
                      searches are refused), advisory.ts (decision 31's notice: null until needed)
  components/dca      the auto-buy screens, driven by lib/dca/useAutoBuy.ts
  lib/money           amounts typed in 17 currencies (parse, size, convert), rates, number styles
  lib/records         Your activity, its CSV and statement
  lib/reminders       calendar files, the buy-due and proof-lapse notifications
  lib/finality.ts     + components/trust: the Sent → Included → Final badge
  lib/culture         Welcome, Your stack, the "I bought" card, #receipt=, sayings, preset amounts
  lib/network         Collective DCA; Help run the network (batch.ts: due buys from the person's
                      wallet, private sending only, in-window only for an eligible wallet);
                      Community keeping (keeping.ts: eligibility, Prove my SPX, Prove another
                      address, paste a proof); the second-opinion setting; Trust and exits
  lib/quoteRefresh.ts a One-time price kept current: 30 s, 10 times, visible tab only
  lib/links.ts        release addresses and build settings, never guessed
  lib/download.ts     every file the app hands over
  no-requests.test.ts rule 4's check
```

## Local setup

```bash
pnpm install
pnpm verify              # works at once; fork stages skip without Foundry
pnpm anvil:fork          # another terminal: the pinned fork, which checks its own block hash
pnpm verify --strict
```

- Fork stages need Foundry (`anvil`; `forge` for `contracts`):
  `docs/DEVELOPMENT.md`, "Installing Foundry" (NixOS included). Playwright
  starts the web server itself; on NixOS set `SPDEX_CHROMIUM_PATH`.
- `contracts` needs `forge` and an archive endpoint in `SPDEX_FORK_RPC_URL`
  (`.env.local`), not the local fork. Run forge through
  `node packages/vault/scripts/forge.mjs`, which passes it the repo's `.env`
  files and the pinned solc.
- `pnpm keeper` needs Node 22.15 or later. Running a keeper, its report and
  the Docker image: `docs/KEEPER.md`. `pnpm keeper:smoke` checks the image end
  to end against the local fork (needs Docker); it is not a gate stage.
- `pnpm mainnet:smoke` (`docs/MAINNET-SMOKE.md`) drives the published app with
  three agent wallets against Ethereum, or against its own fork of today's
  chain (`pnpm mainnet:smoke:fork`, :8547, never the pinned one). It is not a
  gate stage and never becomes one. A mainnet run spends real ether: run one
  only within the limits the wallets' owner set (`SPDEX_SMOKE_*`), rehearse
  any change to the suite on the fork first, and never point the keystores at
  a fork. Every transaction it signs goes through `e2e-mainnet/wallet.ts`'s
  checks; widen its allowlist only with where the new transaction goes.
