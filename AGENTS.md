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
| `contracts` | The vault contracts break a rule their forge tests pin, on a mainnet fork at the pinned block, or `packages/vault/src/artifacts.ts` is stale: the factory and batcher addresses the app and the keeper ship are not the ones the source builds to, or `packages/vault/deployments.json` does not end with this build. Runs `build-artifacts.mjs --check`, then `forge test`. Skips without `forge` on PATH or without `SPDEX_FORK_RPC_URL`. The forge tests fork from that archive endpoint themselves, so a rate limit (HTTP 429) fails the stage without any assertion failing; read the output before believing a red |
| `conformance` | A module violates the interface, or escaped its sandbox |
| `parity` | Native and QuickJS runtimes disagree — the fast path has drifted. It runs fixture modules covering every loadable kind, not the shipped ones; each first-party module checks its own parity in `unit` (tip list, tracker, scheduler: whole outputs) or `integration` (venues: pool discovery and quotes, not the calls that get signed) |
| `redteam` | **The Guard let a malicious plan through** — a swap, a tip, a scheduled buy, a vault transaction (a creation above the buy-fee ceiling included), or a batch of other people's due vault buys (Help run the network) — or a second opinion that disagrees was talked out of refusing, or one that went quiet made a plan more signable than one service alone would. It also fails when the Engine builds a Guard class the second-opinion structural test doesn't know. Never ship this red. |
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
  never mine a block just to reach a confirmation.
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
   trigger), and a fifth: a batch of other people's due vault buys sent from
   the person's own wallet (Help run the network). They go through
   `VaultGuard`, and one that sends ether is never signed `unverified`,
   whatever `requireSimulation` says. A batch is never signed `unverified` at
   all, is offered only with private sending and only when its buy fees cover
   its network fee, and pays nobody but the account. What else the Guard
   checks on a batch: `docs/THREAT-MODEL.md`, "Helping run the network".
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
   `executeBatch` to a listed batcher paying the configured `rewardTo`, a
   listed batcher's deployment, a 0-value cancel to itself, and a WETH unwrap
   when it is its own `rewardTo`, none of them carrying ether — and everything
   else throws before the key is used. Widen that list and you widen what a
   bug, or an endpoint that lies, can get a hot key to sign.
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
   an allowance to that test only with where the request goes. The keeper and
   its report are operator tools, not the app: they contact only the endpoints
   their operator configures (an optional dead-man's-switch URL included), and
   the app never contacts a keeper. `index.ts` never re-exports them, with one
   exception: the keeper's pure planning in `keeper-plan.ts` (`selectBatch`,
   `batchGasLimit`, `modelBatchGas`, `earliestBuyAt` and their constants),
   which Help run the network uses. It reads nothing, signs nothing and imports only types, the
   artifacts and the fee, and `boundaries.test.ts` pins exactly that. Nothing
   under `apps/web` imports `@spdex/vault/keeper` or any other keeper module
   (`boundaries.test.ts`).
5. **No backend.** The app is a static bundle. If a feature seems to need a
   server, it needs a module or a different design.
6. **No contract anyone controls.** The auto-buy vault, its factory and the
   batcher (`packages/vault/contracts`) have no owner, admin, upgrade path,
   pause switch anyone else holds, or fee, and none may be added. That includes
   a setter, an initializer, a proxy whose implementation can change, a
   "guardian", or a fee "for keepers" routed anywhere but the caller of
   `execute`.
   - The batcher (`SpdexVaultBatcher`) is held to the same standard. It has no
     owner, fee, setter or storage beyond a transient lock, and holds nothing
     between calls. It is one more caller of each vault's `execute`, and it
     forwards every reward, in the same transaction, to the `rewardTo` its own
     caller names: that is the caller's own reward sent where the caller
     chooses, not a fee routed elsewhere. `minRewards` is a condition the
     caller sets on its own transaction; a revert is the same as not sending.
     It is bound to one factory, and any change to it means a new address.
   - The buy fee is each vault's `keeperReward`, fixed at creation and never
     changeable afterwards. The app's default comes from
     `packages/vault/src/fee.ts`: one batched buy's network cost at a release
     constant (122,000 gas × 0.15 gwei) and a tenth more, never above 0.69% of
     the buy. That ceiling is the contract's `MAX_REWARD_BPS`, the whole fee
     with the network cost included: nobody who triggers a buy, spDEX's
     developers among them, is ever paid more for it. Never raise it, and
     never add a second fee beside it. Changing the default under it is a
     release decision, never a setting on chain, and it only reaches plans
     created after the release. Do not make the ceiling configurable in the
     app: `VaultGuard` refuses a creation above it, and so does the factory.
   - The limits in `VaultLimits.sol` are constants, not terms, for the reason
     the tip ceiling is. Above all `MAX_FUNDING` (0.5 ETH, the hard cap on what
     an owner can put into a vault) stays a constant: it is what makes
     unaudited code a risk a person can decide to accept.
   - The market list is fixed in the factory's constructor. Adding, removing
     or changing a market means a new factory at a new address, never an edit
     to this one. The same goes for any change to any of the three contracts.
   - After any change under `contracts/`, regenerate `src/artifacts.ts`
     (`pnpm --filter @spdex/vault build:artifacts`), and never hand-edit it.
     The `contracts` stage refuses a stale copy.
   - `packages/vault/deployments.json` is append-only. `build:artifacts`
     rewrites only a trailing release not yet deployed (`factoryBlock` null);
     once a release's blocks are filled in by hand after its mainnet
     deployment, it is frozen. Never remove or edit a deployed entry: keepers
     and reports serve every entry, so an entry removed is a release whose
     vaults nobody triggers. The intent, not yet built, is that once a second
     release exists the app lists, funds and closes vaults from every listed
     factory and creates only on the latest; today it reads the last one only.
   - A vault's caller chooses only *when*, so never give `execute` a
     parameter. The amount, recipient, market and floor are fixed when the
     vault is created. A plan names a market only by its index in the
     factory's list, never by a token, pair or pool address.
   - The app, the keeper and the report trust only vaults a factory vouches
     for (`isVault`): the app its one factory, the keeper and the report any
     factory in `DEPLOYMENTS`. The factory's vault list (`vaultCount`,
     `vaultsPage`) is append-only and changes nothing about trust: membership
     is `isVault`, written in the same call. All of them treat a vault figure
     they cannot read as unknown, never as zero.

## Layout

```
packages/core       types + zod schemas (TxPlan is a signable intent, not a fire-once object)
packages/chain      Multicall3 (pinnable to a block), httpRpc, SimulationProvider, TWAP oracle,
                    fx.ts (Chainlink's 16 currency feeds and USDC/USD, read in one call), a
                    local-key signer (the keeper's)
packages/guard      static checks → simulation → oracle cross-check; tip, scheduled-buy
                    and vault paths (the batch path included); second-opinion.ts (every
                    test-run on two services, compared)
packages/host       capability broker, runtimes/{native,quickjs}, KIND_SPECS (a row per kind)
packages/router     split routing (host-side on purpose — it decides where money goes)
packages/config     versioned SpdexConfig (v9) + migrations + presets + auto-buy plan edits
packages/vault      the auto-buy vault: contracts/ (Solidity 0.8.33, unaudited; SpdexVaultFactory,
                    SpdexDcaVault, SpdexVaultBatcher, VaultLimits), test/forge/ (forge fork tests),
                    deployments.json (append-only release registry), src/artifacts.ts
                    (generated — never hand-edit), src/index.ts (encoders, readVault, availability,
                    findVaultsByOwner, the factory's list), src/fee.ts (the buy fee),
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
packages/testing    anvil fixtures, fork helpers, headless EIP-1193 wallet
e2e-mainnet         the mainnet smoke suite: agent wallets, an allowlist and a spending limit
                    on every transaction, Playwright specs (docs/MAINNET-SMOKE.md); not a gate stage
modules/            first-party modules; same interface as any stranger's
  venue-uniswap-v2/v3  kind: venue
  tiplist-spx-community  kind: tiplist — no capabilities, no contracts
  tracker-pool-stats     kind: tracker — chain:read on three token contracts
  scheduler-dca          kind: scheduler — no capabilities, no contracts
apps/web            Vite SPA; src/lib/dca: auto-buy runner, ledger, vault.ts (vault plans: reads,
                    the four transactions, chain time) and factoryListSearch.ts (finding
                    vaults by their owner() when log searches are refused);
                    src/components/dca: the auto-buy screens, driven by lib/dca/useAutoBuy.ts
                    lib/money + components/money: amounts typed in 17 currencies (input only:
                    parse, size, convert), the rates, number styles, the currency menu
                    lib/records + components/records: Your activity, its CSV and statement;
                    lib/reminders: calendar files and the buy-due notification; lib/finality.ts
                    + components/trust: the Sent → Included → Final badge
                    lib/culture + components/culture: Welcome, Your stack, the "I bought" card,
                    the #receipt= view, saying lines, preset amounts
                    lib/network + components/network: Collective DCA, Help run the network
                    (batch.ts: a batch of due vault buys from the person's wallet, private
                    sending only), the second-opinion setting, and Trust and exits
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
