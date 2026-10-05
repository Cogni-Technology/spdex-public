# Development

## Requirements

- Node >= 22.13.1 (`engines`; `.nvmrc` pins 22.23.2). **`pnpm keeper` needs
  22.15 or later**: it runs the repository's TypeScript directly, through
  `module.registerHooks` and `--experimental-transform-types`, and stops with
  that message on an older Node.
- pnpm 12.x
- **Foundry**: `anvil` for the fork-backed stages (integration and e2e), and
  `forge` for the `contracts` stage (the vault's build and tests).
- **An archive RPC endpoint** in `SPDEX_FORK_RPC_URL` (below), for the fork and
  for the forge tests.
- **Docker 24+ with Compose v2**, optional: only for the keeper's image and
  `pnpm keeper:smoke`. Nothing in `pnpm verify` needs it.

Without Foundry, `pnpm verify` still runs and passes, but the integration,
contracts and e2e stages **skip** and say so. `contracts` also skips when
`SPDEX_FORK_RPC_URL` is unset. That is a partial run, not a green build — use
`pnpm verify --strict` when you need the real answer.

## Installing Foundry

The fork stages need `anvil`, and the `contracts` stage `forge`. Install
Foundry with its own installer (`foundryup`, see https://book.getfoundry.sh),
or your package manager's `foundry`.

On NixOS, add it to `environment.systemPackages` in
`/etc/nixos/configuration.nix` and rebuild (`sudo nixos-rebuild switch`), or
use `nix-shell -p foundry` for one shell:

```nix
environment.systemPackages = with pkgs; [
  # ...existing packages...
  foundry      # forge, cast, anvil — spDEX fork tests
];
```

Then confirm:

```bash
anvil --version
pnpm verify --strict      # every stage should now run
```

## The fork

```bash
pnpm anvil:fork
```

Forks mainnet at `SPDEX_FORK_BLOCK` and **verifies the block hash matches
`SPDEX_FORK_BLOCK_HASH`** before serving. A mismatch means the upstream RPC is
on a different chain or a reorged history — fix the RPC rather than relaxing the
check.

### You need an archive RPC

`SPDEX_FORK_RPC_URL` must point at an **archive** endpoint. Forking at a pinned
block asks for state thousands of blocks back, which full nodes have pruned —
most free public endpoints reject it (`Archive requests require a personal
token`). Alchemy's free tier includes archive access.

```bash
echo 'SPDEX_FORK_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY' >> .env.local
```

This is a *test-time* key and has nothing to do with the key baked into
production builds — see `docs/RPC-RUNBOOK.md`. Never commit either.

### Proofs, and how long a fork stays useful for them

The SPX holder registry (v2) believes a proof only of a block whose real hash
it can read: through `BLOCKHASH` for the last 256 blocks, and EIP-2935's
history contract for the 8,191 before the head. On the fork that has three
consequences.

- **The fork can't prove a block it mined.** anvil leaves a mined block's
  `stateRoot` empty (all zeros), and its `eth_getProof` answers from its
  partial local copy of the state, so nothing proven against one is true.
  Tests prove real mainnet blocks at or before the pinned one instead, from
  proofs recorded once from the archive endpoint (`packages/vault/test/fixtures/proofs`,
  [below](#the-contracts)). The fork's history contract and `BLOCKHASH` hold
  those blocks' real hashes, so the registry checks them as it would on
  mainnet.
- **Restart a long-lived fork after about 8,000 mined blocks.** EIP-2935's
  8,191 blocks count back from the fork's head, so a recorded proof of a block
  just before
  26,000,000 can be proven there only until roughly 8,000 blocks have been
  mined on top of it; after that `prove` refuses it with `UnknownBlock`. The
  fork mines a block per transaction, so a fork that has run the test suites
  many times gets there; `pnpm anvil:fork` again starts from the pinned block.
  A proof lasts 30 days from its block's time, and the fork's clock runs on
  from the pinned block's, so a fork's proofs also lapse after 30 days of
  uptime, long after the currency rates have gone stale ("Determinism rules"
  in `AGENTS.md`).
- **`finalized` is the head less 64.** On a fork of the pinned block whose head
  was 26,000,003, `finalized` answered 25,999,939. While fewer than 64 blocks
  have been mined, that is a real mainnet block, provable for an address that
  held 690 SPX there; after that it is a block the fork mined, which nothing
  can be proven against. So **Prove my SPX** and the keeper's
  `SPDEX_KEEPER_PROVE`, which prove the `finalized` block, work on a fresh
  fork briefly at most, and only for a real holder.

A proof is not idempotent either: once an address is proven on a shared fork,
proving the same block again reverts with `NotNewer`, so a test reads
`validUntil` before it proves. The forge fixture makes an address eligible
without a proof by writing the registry's one record (`makeEligible` in
`test/forge/utils/Fork.sol`: `validUntil` is mapping slot 0, so a holder's is
at `keccak256(abi.encode(holder, 0))`, a layout `test/forge/Registry.t.sol`
pins).

The fork suites share their helpers in `packages/vault/test/integration/fork.ts`
and, for the browser suite, `packages/testing/src/vaultFork.ts` (imported by
path): deploying a release's contracts where they are missing
(`deployReleaseCalls`), proving the recorded holder `0xb007…bb8e` once
(`ensureHolderProven`, which reads `validUntil` first), and making a fresh
key that must sign eligible: it buys 690 SPX with a real swap, and then its
`validUntil` record is written with `anvil_setStorageAt`, the one registry
write `AGENTS.md` allows, for fresh keys only (`writeEligibleOnFork`). The
browser suite's community spec also proves two other real holders through
the page, each at the block after the one it was last proven at, with
`finalized` pinned to a forked block; that runs about a thousand times on one
fork, bounded like the recorded proofs by the 8,191 blocks above.

## The contracts

The auto-buy vault, its factory, the batcher and, from v2, the SPX holder
registry live in `packages/vault`:

| Path | What it holds |
|---|---|
| `contracts/` | The release being built, v2: `SpdexDcaVault`, `SpdexVaultFactory`, `SpdexVaultBatcher`, `VaultLimits` and `SpxHolderRegistry` |
| `contracts/vendor/optimism/` | The Merkle-Patricia proof verifier the registry uses, Optimism's MIT-licensed `SecureMerkleTrie`, `MerkleTrie`, `RLPReader`, `RLPErrors` and `Bytes`, vendored at a pinned commit with only their import paths changed. Its `README.md` names the commit, each file's hash and how to check them again. Never edited here, and not linted here (`foundry.toml`, `[lint]`) |
| `releases/v1/contracts/` | v1's source, frozen: a verbatim copy of what v1's factory and batcher were deployed from. Never edited again; `releases/v1/README.md` says why it is kept |
| `test/forge/` | The forge tests (v2's; v1's were run before it was deployed) |
| `test/fixtures/proofs/` | SPX balance proofs recorded from mainnet, which the registry's tests prove |
| `deployments.json` | The record of releases, append-only |
| `src/` | The TypeScript the app and the keeper use; `src/artifacts.ts` is generated |

```bash
node packages/vault/scripts/forge.mjs build                     # compile v2
FOUNDRY_PROFILE=v1 node packages/vault/scripts/forge.mjs build  # compile v1's frozen source, into out-v1/
node packages/vault/scripts/forge.mjs test -vv                  # the forge tests, with their logs
pnpm verify --only=contracts                                    # what the gate runs: the artifacts check, then the tests
pnpm --filter @spdex/vault build:artifacts                      # regenerate src/artifacts.ts after changing a contract
node packages/vault/scripts/record-proofs.mjs                   # re-record the proof fixtures (rarely: below)
```

Run forge through `scripts/forge.mjs` rather than directly. The wrapper hands
forge the repository's `.env.defaults` and `.env.local`, which forge on its
own would not read, and it picks the compiler.

- **The compiler is pinned** to solc 0.8.33 (`0.8.33+commit.64118f21`),
  because every contract's address depends on its bytecode, and a different
  compiler would make a different registry, factory and batcher. If the
  `solc` on your PATH is exactly that build (nixpkgs' can be), it is used and
  nothing is downloaded. Otherwise forge fetches the official build and checks
  its published checksum. A different `solc` on PATH is ignored, not used.
- **Two releases, two profiles.** `foundry.toml`'s default profile builds
  `contracts/` (v2) into `out/`; its `v1` profile builds `releases/v1/contracts`
  into `out-v1/` with the same settings, repeated, since a profile inherits
  nothing. v1 is on mainnet and its contracts can never change, so its source
  can't either: the copy is kept so that anyone can rebuild v1 and check its
  addresses, and so the app and the keeper go on shipping v1's ABIs and
  creation code for v1's vaults. The two releases' contracts share names, so
  always say which profile you mean. v1 has no forge tests of its own here; it
  was tested before it was deployed.
- **The forge tests fork mainnet themselves,** at block 26000000 (the fork's
  pin, as a constant in `test/forge/utils/Fork.sol`), from
  `SPDEX_FORK_RPC_URL`. They never touch the local fork on :8545, and they move
  time freely with `vm.warp`, which stays inside each test's own EVM; the
  community window's edges are tested there to the second
  (`test/forge/Window.t.sol`). The one thing they read from disk is the
  recorded proofs, read-only (`fs_permissions` in `foundry.toml`). They make
  many archive requests, and a free endpoint's rate limit (HTTP 429) shows up as
  a failed test, not a skip, so read a failure before believing it. The gate
  runs one suite at a time (`-j 1`) for that reason: about two minutes for the
  whole suite. The same burst throttles the endpoint the local fork fetches
  cold state from: right after a forge run, the fork's first read of a fresh
  account took 30 seconds. So the gate runs `contracts` last, after
  `integration` and `e2e`; a forge run of your own just before the browser
  suite can slow its first test the same way.
- **Recorded proofs.** The registry's tests need real proofs of SPX balances,
  which a fork can't produce for blocks it mined
  ([above](#proofs-and-how-long-a-fork-stays-useful-for-them)).
  `test/fixtures/proofs/holder-<first 8 hex digits>-<block>.json` holds them:
  the block's header as the protocol hashes it, its hash, state root and time,
  the holder's balance and storage key, and both Merkle proofs, each with a
  note saying what the fixture is for (a holder well above 690 SPX at blocks
  that test each way of reading a hash, one below it, one with none, one that
  sold, and Uniswap's SPX pair, a contract that must never be eligible).
  `scripts/record-proofs.mjs` wrote them from the archive endpoint: with no
  arguments it writes the whole set the tests use, and
  `node packages/vault/scripts/record-proofs.mjs 0xHolder@25999000` records
  one more (`--out` writes elsewhere). It reads `SPDEX_FORK_RPC_URL` and never
  prints it, and refuses to write a fixture unless the header it rebuilds
  hashes to the block's hash, each proof's first node hashes to its root, and
  the proven value equals SPX's own `balanceOf` at that block, which checks the
  balance slot too. Re-record only on purpose: the tests pin the balances these
  blocks show.
- **Changing a contract changes its address.** `src/artifacts.ts` is
  generated from every source's build. Each source is exported under its own
  prefix (`V1_*`, `V2_*`: ABIs, creation code, salts, limits) and as data,
  `SOURCES`, with what its contracts can do (`features`, read from its ABIs);
  the current source, v2's, also under unprefixed names (`VAULT_ABI`,
  `FACTORY_ABI`, `BATCHER_ABI`, `REGISTRY_ABI`, …), for creating vaults; the
  latest release's addresses (`MAINNET_REGISTRY`, `MAINNET_FACTORY`,
  `MAINNET_IMPLEMENTATION`, `MAINNET_BATCHER`); and the record, `DEPLOYMENTS`
  and `BATCHERS`. `check:artifacts`, the first half of the `contracts` stage,
  rebuilds every source and fails if the committed copy differs by a byte, or
  if a recorded deployment no longer builds from its source. After any change
  under `contracts/`, run `build:artifacts` and commit the result. The
  registry has no constructor arguments, so its address is a function of its
  bytecode alone, the vendored verifier's included; the factory's
  constructor names the registry, so a change to the registry moves the
  factory too; the batcher's names only WETH, so it moves alone. The app will
  then expect the contracts at their new addresses, and on a chain where
  nothing is there yet it offers the one-time deployment; the keeper expects
  the batcher at its new address, and `pnpm keeper --deploy-batcher` deploys
  it. Code that handles a vault of any release asks its source's features
  (`featuresOf`, `src/releases.ts`), never a release's name.

  | | v1, on mainnet since block 26,100,366 | v2, the addresses this source deploys to (not yet deployed) |
  |---|---|---|
  | SPX holder registry | — | `0x2c7f732a453fe0a4a65f36ac564ff16007b5610d` |
  | Factory | `0xe4a1410a9ee0833d41e7514306e65ad729b7199e` | `0xbf40f0fb41e5ee1194173545749d80c4651bac32` |
  | Its implementation | `0xb32b5e1092de9596877be9b6c783c7e98b55b1c6` | `0xeba51b96621f0fce83e017c0a46330c8cde323db` |
  | Batcher | `0xc5ce65451dd5fc99d08eb18440b06f2bcca3c5a0` (bound to v1's factory) | `0xd1f8327aa8398997bd88165f420412c703ebfed0` (bound to no factory; every later release shares it) |
- **`deployments.json` is append-only.** `{ "releases": [...], "batchers":
  [...] }`, each oldest first. v1's release has `id`, `factory`, `batcher`,
  `factoryBlock` and `batcherBlock`, and stays byte for byte as it is; every
  later release has `id`, `source`, `factory`, `registry`, `markets`,
  `factoryBlock` and `registryBlock`, and every batcher bound to no factory
  `source`, `batcher` and `batcherBlock`. Ids run `v1`, `v2`, … with no gaps.
  `build:artifacts` recomputes every entry from its source and refuses one
  that differs, rewrites only a trailing entry not yet deployed (its blocks
  null), fills in a release appended by hand with `factory: null` (another
  market list or registry, built from an existing source), and appends the
  current source's release and batcher when nothing lists them. After a
  mainnet deployment, fill in the blocks by hand, a release's registry's at
  or before its factory's (`docs/RELEASE.md` has the deployment's steps): the
  only hand edit an entry ever gets, and it freezes the entry. It also
  refuses one factory in two entries, and a deployed entry its source no
  longer builds to — `contracts/` changed after its release reached mainnet
  without being frozen first (`docs/RELEASE.md`, "Before the next release,
  freeze this one"). Never remove an entry: the keeper and the report serve
  every listed release.
- **Stack too deep is fixed by rescoping, never by `via_ir`.** Turning on the
  IR pipeline would move every address and every gas figure the fee and the
  forge tests pin. Keep locals in a smaller scope, as `SpdexDcaVault.execute`
  does with its swap so it can emit `Bought` with all its fields (v2's adds
  `rewardTo` and `dueSince`), or move work into a small private function.
- **Verifying on Sourcify or Etherscan** takes the settings in `foundry.toml`:
  solc 0.8.33, the optimizer at 200 runs, EVM `cancun`, `bytecode_hash =
  "none"` and `cbor_metadata = false`. Verified, explorers and dashboards
  decode the contracts' indexed events.

## The keeper

A keeper triggers due vault buys, many to a transaction through the batcher,
for their buy fees: v1's vaults in batches to v1's batcher, and every later
release's to the shared batcher, which is bound to no factory. Anyone can run it; it needs no permission from vault
owners, and it contacts nothing but the endpoints its operator configures.
Inside a v2 buy's community window only an eligible `rewardTo` (an ordinary
account proven to hold 690 SPX) or the vault's owner can be paid, so a keeper
that is neither waits for the window to end. **`docs/KEEPER.md` is the
guide**: the five-step Docker quick start, becoming a community keeper, the
economics, every setting, and troubleshooting. From a checkout:

```bash
SPDEX_KEEPER_RPC_URL=http://127.0.0.1:8545 SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS=0 pnpm keeper --once --dry-run
```

| Variable | What it does |
|---|---|
| `SPDEX_KEEPER_RPC_URL` (or `_FILE`) | The endpoint it reads, and sends through unless `SPDEX_KEEPER_SEND_URL` is set. Required, and never printed or logged, since URLs carry API keys. |
| `SPDEX_KEEPER_SEND_URL` (or `_FILE`) | A private, revert-protected relay for its sends. Unset, it warns that it sends to the public mempool. |
| `SPDEX_KEEPER_KEY_FILE` or `SPDEX_KEEPER_KEY` | The key it signs with. Without one it is a dry run. Never printed or logged. |
| `SPDEX_KEEPER_REWARD_TO` | The address every vault in its batches pays. Default: the keeper's own address. On the fork, set it to your vaults' owner to make their buys inside their windows: a fresh key is never eligible there. |
| `SPDEX_KEEPER_PROVE` | `1` to prove `rewardTo` to the SPX holder registry (off by default). Of no use on the fork: it can't prove a block it mined, and a fresh key held no SPX at any block before them. |
| `SPDEX_KEEPER_VAULTS` | A comma-separated allowlist of vaults, instead of every vault in every listed factory. Tests and anything on the shared fork always set it. |
| `SPDEX_KEEPER_SEND_WHEN` | `cheap` (default: wait for a cheap block, up to a deadline), `deadline`, or `now`. |
| `SPDEX_KEEPER_CONFIRMATIONS`, `SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS` | Set them to `1` and `0` on the fork: it mines only when sent a transaction, and its idle head is days old. |
| `SPDEX_KEEPER_DATA_DIR` | State, lease, heartbeat and daily JSONL logs. Default `./.keeper/<chainId>`. |

Every other setting is in `docs/KEEPER.md`. They are read from the
environment, then `.env.local`, then `.env.defaults`, like every script here.
`--once` runs one tick and exits; `--dry-run` never signs and writes nothing;
`--deploy-batcher` deploys any listed batcher missing on this chain. Every
decision is a JSON line on stdout and in the day's log file, so a keeper that
did nothing says why. `docs/TRY-IT.md` runs one against the fork.

```bash
pnpm keeper:report --to-block latest --vault 0xYourVault   # beta data: CSV and summary.json in ./keeper-report/
pnpm keeper:smoke                                          # the Docker image end to end on the fork
```

`pnpm keeper:report` reads the chain through `SPDEX_REPORT_RPC_URL` (falling
back to `SPDEX_KEEPER_RPC_URL`) and the keeper's logs; KEEPER.md lists its
options and what each table answers. `pnpm keeper:smoke` needs Docker and
`pnpm anvil:fork`: it builds the image, creates two due v2 vaults with fresh
keys, started far enough back that their community windows are over (its
fresh `rewardTo` can't be paid inside one), lets the containerised keeper
batch them, checks the fees, logs,
heartbeat, healthcheck, report and the image's contents, then closes the
vaults and deletes its key file and the fork profile's data volume.
`SPDEX_FORK_URL=http://127.0.0.1:8546` points it at a second fork. Neither is
a `pnpm verify` stage.

## Running the app

```bash
pnpm anvil:fork                 # terminal 1 — pinned fork with a verified anchor
pnpm --filter @spdex/web dev    # terminal 2 — http://localhost:5173
```

On first load the app asks how spDEX should reach Ethereum. Under **Use my own
service**, enter `http://127.0.0.1:8545` and click **Use this** to point it at
the fork. `docs/TRY-IT.md` goes on from there: a wallet, a swap and an
auto-buy.

## Browsers for e2e

`pnpm verify` starts Vite itself, but the fork has to already be running.
The server it starts names no published address: `playwright.config.ts` sets
`VITE_SPDEX_APP_URL`, `VITE_SPDEX_SOURCE_URL` and `VITE_SPDEX_FEEDBACK_URL`
empty in its environment, over anything your `.env.local` holds, since the
specs check the build that names none (no docs links in Help run or
Community keeping either). A dev server you already started is reused as it
is, so stop one started with those set before running the browser suite.

On NixOS, Playwright's downloaded Chromium will not start: it is a generic Linux
build whose interpreter nothing has patched, so it dies looking for `libxcb.so.1`.
nixpkgs ships a patched build, but at a different revision than Playwright
expects, so `PLAYWRIGHT_BROWSERS_PATH` fails a version check. Point at the binary
directly instead:

```bash
echo "SPDEX_CHROMIUM_PATH=$(ls -d /nix/store/*playwright-chromium/chrome-linux64/chrome | head -1)" >> .env.local
```

Elsewhere, leave it unset and `pnpm exec playwright install chromium` is enough.

## The typefaces

The display faces **ship with the app**, so every visitor sees the SPX look
rather than a system fallback: Orbitron (one variable file), Space Mono Regular
and Bold, and Bebas Neue, in `apps/web/src/assets/fonts/`, each directory with
the font's `OFL.txt` (all four are under the SIL Open Font License 1.1). They
are the files from the google/fonts repository (`ofl/orbitron`,
`ofl/spacemono`, `ofl/bebasneue`), unmodified; only Orbitron's is renamed, since
`Orbitron[wght].ttf` has brackets that don't belong in a URL.

- `apps/web/src/fonts.css` declares them with `@font-face` and
  `font-display: swap`, and `main.tsx` imports it before the theme. No
  `local()` source, so every browser draws the same glyphs.
- They come from the app's own origin: Vite copies each into the build's
  assets with a content hash, and the CSP's `default-src 'self'` already
  allows that. Nothing is loaded from another origin, and the release build
  stays reproducible, since they are static bytes.
- The licence travels with them: `apps/web/vite.config.ts` (`fontLicences`)
  emits the three `OFL.txt` files, byte for byte, at
  `assets/fonts/<family>/OFL.txt` in every build.
- What they cost: 297,564 bytes of TTF (Orbitron 38,576, Space Mono Regular
  99,356 and Bold 98,232, Bebas Neue 61,400). Inter (876 KB) is **not**
  bundled; body text keeps the system UI stack.
- `packages/ui/src/theme.css` still names a system fallback after each face,
  for the moment before a face arrives, and the layout holds with the
  fallbacks: titles wrap and summaries ellipsise rather than overflow.
- The "I bought" card's PNG embeds the same four files (`lib/culture/card.ts`),
  read back from the same origin when the PNG is made, so the picture matches
  the preview.
