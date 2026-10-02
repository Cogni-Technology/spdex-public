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

## The contracts

The auto-buy vault, its factory and the batcher live in `packages/vault`: the
Solidity in `contracts/`, the forge tests in `test/forge/`, the release registry
in `deployments.json`, and the TypeScript the app and the keeper use in
`src/`.

```bash
node packages/vault/scripts/forge.mjs build      # compile
node packages/vault/scripts/forge.mjs test -vv   # the forge tests, with their logs
pnpm verify --only=contracts                     # what the gate runs: the artifacts check, then the tests
pnpm --filter @spdex/vault build:artifacts       # regenerate src/artifacts.ts after changing a contract
```

Run forge through `scripts/forge.mjs` rather than directly. The wrapper hands
forge the repository's `.env.defaults` and `.env.local`, which forge on its
own would not read, and it picks the compiler.

- **The compiler is pinned** to solc 0.8.33 (`0.8.33+commit.64118f21`),
  because the factory's address depends on its bytecode, and a different
  compiler would make a different factory. If the `solc` on your PATH is
  exactly that build (nixpkgs' can be), it is used and nothing is
  downloaded. Otherwise forge fetches the official build and checks its
  published checksum. A different `solc` on PATH is ignored, not used.
- **The forge tests fork mainnet themselves,** at block 26000000 (the fork's
  pin, as a constant in `test/forge/utils/Fork.sol`), from
  `SPDEX_FORK_RPC_URL`. They never touch the local fork on :8545, and they move
  time freely with `vm.warp`, which stays inside each test's own EVM. They make
  many archive requests, and a free endpoint's rate limit (HTTP 429) shows up as
  a failed test, not a skip, so read a failure before believing it. The same
  burst throttles the endpoint the local fork fetches cold state from: right
  after a forge run, the fork's first read of a fresh account took 30 seconds.
  So the gate runs `contracts` last, after `integration` and `e2e`; a forge run
  of your own just before the browser suite can slow its first test the same
  way.
- **Changing a contract changes its address.** `src/artifacts.ts` is
  generated: the ABIs, the factory's and the batcher's creation code, mainnet's
  deployment, the addresses they give, the batcher's limits, and
  `DEPLOYMENTS`. `check:artifacts`, the first half of the `contracts` stage,
  rebuilds from source and fails if the committed copy differs by a byte. After
  any change under `contracts/`, run `build:artifacts` and commit the result.
  The app will then expect the factory at the new address, and on a chain where
  nothing is there yet it offers the one-time deployment; the keeper expects
  the batcher at its new address, and `pnpm keeper --deploy-batcher` deploys
  it. Today's addresses: factory `0xe4a1410a9ee0833d41e7514306e65ad729b7199e`,
  its implementation `0xb32b5e1092de9596877be9b6c783c7e98b55b1c6`, batcher
  `0xc5ce65451dd5fc99d08eb18440b06f2bcca3c5a0`.
- **`deployments.json` is append-only.** It lists every release — `id` (`v1`,
  `v2`, … with no gaps), `factory`, `batcher`, and the mainnet blocks they
  were deployed in — oldest first. `build:artifacts` rewrites only a trailing
  entry whose `factoryBlock` is null (a release not yet deployed) to this
  build's addresses, and appends a new entry after one that has blocks. After
  a mainnet deployment, fill in `factoryBlock` and `batcherBlock` by hand
  (`docs/RELEASE.md` has the deployment's steps): the only hand edit an entry
  ever gets, and it freezes the entry. `--check` fails
  when a frozen entry changed or the last entry is not this build. Never
  remove an entry: the keeper and the report serve every listed release.
- **Stack too deep is fixed by rescoping, never by `via_ir`.** Turning on the
  IR pipeline would move every address and every gas figure the fee and the
  forge tests pin. Keep locals in a smaller scope, as `SpdexDcaVault.execute`
  does to emit `Bought` with its three newer fields, or move work into a small
  private function.
- **Verifying on Sourcify or Etherscan** takes the settings in `foundry.toml`:
  solc 0.8.33, the optimizer at 200 runs, EVM `cancun`, `bytecode_hash =
  "none"` and `cbor_metadata = false`. Verified, explorers and dashboards
  decode the contracts' indexed events.

## The keeper

A keeper triggers due vault buys, many to a transaction through the batcher,
for their buy fees. Anyone can run it; it needs no permission from vault
owners, and it contacts nothing but the endpoints its operator configures.
**`docs/KEEPER.md` is the guide**: the five-step Docker quick start, the
economics, every setting, and troubleshooting. From a checkout:

```bash
SPDEX_KEEPER_RPC_URL=http://127.0.0.1:8545 SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS=0 pnpm keeper --once --dry-run
```

| Variable | What it does |
|---|---|
| `SPDEX_KEEPER_RPC_URL` (or `_FILE`) | The endpoint it reads, and sends through unless `SPDEX_KEEPER_SEND_URL` is set. Required, and never printed or logged, since URLs carry API keys. |
| `SPDEX_KEEPER_SEND_URL` (or `_FILE`) | A private, revert-protected relay for its sends. Unset, it warns that it sends to the public mempool. |
| `SPDEX_KEEPER_KEY_FILE` or `SPDEX_KEEPER_KEY` | The key it signs with. Without one it is a dry run. Never printed or logged. |
| `SPDEX_KEEPER_REWARD_TO` | Where the batches' fees go. Default: the keeper's own address. |
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
`pnpm anvil:fork`: it builds the image, creates two due vaults with fresh
keys, lets the containerised keeper batch them, checks the fees, logs,
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
