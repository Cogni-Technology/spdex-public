# Releasing spDEX

One page for whoever publishes a release: a checklist in the order things have
to happen, then the runbook for putting the vault contracts on Ethereum. The
details live where they already were (`docs/IPFS-RELEASE.md`,
`docs/RPC-RUNBOOK.md`, `docs/KEEPER.md`), and each step links to them.

## The order, and why

1. **Settle what no command can**: where the source lives, who reviewed the
   disclaimer, which domain serves the app.
2. **Deploy the contracts, then record the blocks they landed in.** The blocks
   go into `packages/vault/src/artifacts.ts`, which the app bundles, so they
   are part of the release's CID. A release built before its contracts are
   deployed is a release that has to be built again.
3. **Start a keeper.** Without one, a vault's buys happen only when its owner
   triggers them.
4. **Set the build settings, run the gate, tag, build, publish.** Every source
   change above has to be in the tagged commit.

Two things cannot be undone. A deployed factory, vault or batcher cannot be
changed: a fix is a new address and a new entry in `deployments.json`, beside
the old one. And a pushed history is public: decide what it says first.

## Checklist

### 1. Before anything is deployed

- [ ] **The source has a public home.** The repository has a remote, and
      private vulnerability reporting is switched on there:
      `docs/SECURITY.md` and `CONTRIBUTING.md` send reports to a security
      advisory "on this repository" and name no other contact. `git remote -v`
      prints it.
- [ ] **The history says what you want it to.** Every commit so far is
      authored `devuser <user@dev.local>` (`git log --format='%an <%ae>' | sort -u`).
      Changing that after the first push rewrites public history.
- [ ] **The placeholder that needed a home is filled in**: the `git clone`
      line in `docs/KEEPER.md`'s quick start still says
      `<spDEX's repository URL>`. `grep -n "repository URL>" docs/KEEPER.md`
      prints nothing once it doesn't.
- [ ] **The disclaimer's legal review is decided.**
      `apps/web/src/lib/disclaimer.ts` carries a `NOT REVIEWED BY A LAWYER`
      note: the community prototype is published without a review, a risk
      its publisher accepted on 2026-10-02. Before a release beyond the
      prototype, have a lawyer read the text, then remove the note, its test
      in `apps/web/src/lib/disclaimer.test.ts` and the sentence in
      `docs/ARCHITECTURE.md` that repeats it, in one commit. A text that has
      never been released keeps version `2026-10`.
- [ ] **The donation address is yours.** The tip list ships one entry, "spDEX
      donation vault" (`modules/tiplist-spx-community/module.js`,
      `SPDEX_DONATION_ADDRESS` in `packages/core/src/tips.ts`). You hold its
      key, or every signer of its Safe is someone you chose, and it can receive
      SPX and WETH.
- [ ] **The contracts are final.** Nothing under `packages/vault/contracts` is
      waiting to change, and the committed addresses are what the source builds
      to:

      ```bash
      pnpm --filter @spdex/vault check:artifacts
      ```

      A contract change after deployment is the next release (`v2`), never an
      edit to this one.
- [ ] **The buy fee's reference still fits the network.** The default fee is
      priced at `FEE_NETWORK_REFERENCE` (0.15 gwei) and judged against
      `FEE_CHEAP_REFERENCE` (0.083 gwei) in `packages/vault/src/fee.ts`, both
      derived from one week of base fees. Look at a recent week before
      publishing. Changing them is a source change, not a contract change: no
      address moves, the 0.69% ceiling stays where the contract holds it, and
      only plans created after the release pay the new figure.

### 2. The contracts

The runbook below has the commands.

- [ ] Rehearsed on a fork, start to finish.
- [ ] The factory is deployed: there is code at its address, and
      `vaultCount()` answers `0`.
- [ ] The batcher is deployed, and its `factory()` is the factory.
- [ ] Both blocks are in `packages/vault/deployments.json`, `artifacts.ts` is
      rebuilt, `check:artifacts` passes, and the change is committed. From then
      on the entry is frozen.
- [ ] The factory, the vault implementation and the batcher are verified on
      Sourcify and Etherscan.
- [ ] The docs say what is true now: where `README.md` says which networks
      have the factory ("Stats count vaults only"), and what
      `docs/WALKAWAY.md` says about the explorer route to `close()`.

### 3. A keeper

`docs/KEEPER.md` is the guide; its quick start is five steps with Docker.

- [ ] A keeper is running against Ethereum with a key of its own, and its fees
      go to an address whose key is not on that machine
      (`SPDEX_KEEPER_REWARD_TO`).
- [ ] It sends privately (`secrets/send_url`). Without that it says so at
      every start, and its batches can be copied or sandwiched.
- [ ] **It has a subsidy.** The buy fee is one batched buy's network cost and
      a tenth more, never above 0.69% of the buy. It pays for a buy only in a
      shared transaction at a cheap block, and a keeper with no subsidy never
      plans a loss, so it skips the rest. To have buys made anyway, uncomment
      the four subsidy lines in `docker/keeper/.env` (`SPDEX_KEEPER_MAX_LOSS_PER_BUY_ETH`
      and the three caps under it) and set them to what you will pay a day.
      "How it earns, and what it costs" in `docs/KEEPER.md` has the figures.
- [ ] Something tells you when it stops ("Watching it"), and
      `pnpm keeper:report` prints what it did.
- [ ] A small vault of your own, created in the app, gets its first buy from
      the keeper and not from you.

### 4. The network service

`docs/RPC-RUNBOOK.md`, "Alchemy setup", steps 1 to 5.

- [ ] A separate account holds the key, its Domains allowlist is exactly the
      canonical origins, and it has a spending cap and alerts.
- [ ] Step 5's checks pass from a shell: 200 with the origin, 403 without, and
      `eth_simulateV1` answers.

### 5. Build settings

In `.env.local` or the environment, each an `https://` address on a public
name. Every one is written into the bundle, so every one is part of the CID.

| Setting | What it gives the release | Unset |
|---|---|---|
| `VITE_SPDEX_SOURCE_URL` | The `git clone` in Verify this build, and the footer's Source link | "This build doesn't say where its source is published." |
| `VITE_SPDEX_FEEDBACK_URL` | The footer's Feedback link | No link: testers have no way to reach the issue forms |
| `VITE_SPDEX_APP_URL` | The link on "I bought" cards and in calendar files | "open #receipt=… in any spDEX" |
| `VITE_SPDEX_DEFAULT_RPC_URL` and `VITE_SPDEX_CANONICAL_ORIGIN` | The built-in network service, used without a screen at those origins | Every newcomer is asked for a network service first |

- [ ] All five are set, the key and its origins together or neither.
- [ ] The currency references are read again at a recent block (`FX_REFERENCE`
      and `FX_REFERENCE_BLOCK` in `packages/chain/src/fx.ts`), as
      `docs/IPFS-RELEASE.md` asks at each release.

### 6. Gate, tag, build, publish

- [ ] The release commit is on `main`, and the repository has the
      `SPDEX_FORK_RPC_URL` secret: CI runs `pnpm verify --strict` on pushes to
      `main` and on pull requests, and nowhere else.
- [ ] The strict gate is green on that exact commit, with a clean tree:

      ```bash
      git status --short            # prints nothing
      pnpm anvil:fork               # another terminal
      pnpm verify --strict          # exit 0; .verify/report.json says ok, nothing skipped or empty
      ```

      Save no file under `apps/` or `packages/` while it runs: the browser
      stage's dev server reloads and a test sees a blank page.
- [ ] The commit is tagged, and the tag is pushed. Verify this build tells
      people to `git checkout <release tag>`, so the tag is what they will look
      for. Every package is still version `0.0.0`; the tag is the release's
      name.
- [ ] The release is built and its address computed
      (`docs/IPFS-RELEASE.md`, "Cutting a release"):

      ```bash
      pnpm build:release
      pnpm ipfs:cid
      ```

- [ ] The release notes give the tag, the root CID, every `VITE_SPDEX_*`
      value it was built with (the committed `.env.defaults` ones included),
      and the factory's and the batcher's addresses and blocks.
- [ ] The build is pinned, and DNSLink points at it
      (`docs/IPFS-RELEASE.md`, "Pinning").
- [ ] The domain that serves it sends
      `Content-Security-Policy: frame-ancestors 'none'` as a header. The app's
      own policy is a `<meta>` tag, which cannot carry that directive, so
      nothing else stops another site from framing the page. An IPFS gateway
      cannot send it; a domain in front of one can.

### 7. The first hour

Open the published address in a browser that has never seen spDEX.

- [ ] The disclaimer shows, and past it the app is reading the chain with no
      "choose a network service" screen.
- [ ] A price check on **Buy SPX** does not say "Not checked".
- [ ] **Recurring** → **Set and forget** offers **Create and fund vault**, not
      "Vaults aren't set up on this network yet".
- [ ] **Collective DCA** reads the factory, and **Trust and exits** → **Verify
      this build** shows the source address and the commands.
- [ ] The footer has **Feedback**, and it opens the issue forms.
- [ ] The keeper's log shows it found the factory and is waiting.
- [ ] `pnpm mainnet:smoke` passes against the published address
      (`docs/MAINNET-SMOKE.md`), Help run the network included: run it at a
      quiet hour, or it is skipped for the gas.

## Runbook: deploying the contracts

### What gets deployed

Two transactions, both to the standard deterministic deployer
(`0x4e59b44847b379578588920ca78fbf26c0b4956c`), each carrying a fixed salt and
the contract's creation code:

1. **The factory.** Its constructor deploys the vault implementation every
   vault is a clone of, so one transaction puts both on chain.
2. **The batcher**, bound to that factory. It reads the factory in its
   constructor, so it cannot go first.

Their addresses follow from the source alone, which is why
`packages/vault/deployments.json` lists them before anything is deployed.
Anyone may send either transaction, from any account; the sender gets no
rights over what it deploys. If someone else sends one first, it lands at the
same address with the same code, and yours has nothing left to do.

**What it costs.** 3,562,618 gas for the factory and 601,283 for the batcher,
measured on a fork of the pinned block: about 4.2 million together. That is
0.0006 ETH at 0.15 gwei and 0.0042 ETH at 1 gwei. Base fees swing several-fold
within a day, so a quiet hour is worth waiting for.

**What can refuse it.** The factory's constructor checks SPX's market as it is
in that block: the v3 pool and the v2 pair must agree on the price within 2%
(`MAX_MARKET_GAP_BPS`), and the pool must have at least 10 WETH of depth and
100 observations behind its average. If a check fails, the transaction
reverts; step 4's dry run tells you before you pay for it.

### 1. Start from the release's source

```bash
git status --short                           # prints nothing
pnpm install --frozen-lockfile
pnpm --filter @spdex/vault check:artifacts   # the committed addresses are this source's
```

You need Foundry's `cast` (`docs/DEVELOPMENT.md`, "Installing Foundry") and
Node 22.15 or later.

### 2. Write out the two calls

```bash
export OUT=~/spdex-deploy && mkdir -p "$OUT"
node --experimental-transform-types --disable-warning=ExperimentalWarning \
  --import ./packages/vault/scripts/ts-hooks.mjs --input-type=module -e '
import { writeFileSync } from "node:fs";
const v = await import("./packages/vault/src/index.ts");
const out = process.env.OUT;
const factory = v.deployFactoryCall();
const batcher = v.deployBatcherCall(v.MAINNET_FACTORY);
writeFileSync(`${out}/factory.calldata`, factory.data);
writeFileSync(`${out}/batcher.calldata`, batcher.data);
writeFileSync(`${out}/factory.args`, "0x" + v.factoryInitCode(v.MAINNET_DEPLOYMENT).slice(v.FACTORY_CREATION_CODE.length));
console.log("deployer      ", factory.to);
console.log("factory       ", v.MAINNET_FACTORY);
console.log("implementation", v.MAINNET_IMPLEMENTATION);
console.log("batcher       ", batcher.batcher);
console.log("WETH          ", v.MAINNET_DEPLOYMENT.weth);'
```

It prints the five addresses the rest of this page calls the deployer, the
factory, the implementation, the batcher and WETH. The factory and the batcher
must be the ones in `packages/vault/deployments.json`'s last entry. Put them
in the shell:

```bash
DEPLOYER=0x4e59b44847b379578588920ca78fbf26c0b4956c
FACTORY=0x…          # as printed
IMPLEMENTATION=0x…
BATCHER=0x…
WETH=0x…
```

These are the same calls the app's **Set up vaults on this network** and the
keeper's `--deploy-batcher` send (`deployFactoryCall`, `deployBatcherCall`).

### 3. Rehearse on a fork

Start a fresh fork (`pnpm anvil:fork`; one that has run the test suite already
has both contracts) and walk steps 4 to 7 against `http://127.0.0.1:8545` with
a throwaway key:

```bash
cast wallet new                 # an address and a private key, for the fork only
pnpm dev:fund 0xThatAddress
```

Add `--legacy` to each `cast send` there. A fork that has mined nothing passes
cast's fee-history request upstream, where an archive endpoint refuses it.
Don't use an anvil test key: those accounts pass on any ether they receive
(`docs/TRY-IT.md`).

The app's own path is rehearsed in `docs/TRY-IT.md`, "Set up vaults on the
fork".

### 4. Dry run, on Ethereum

```bash
read -rs RPC                    # paste your mainnet endpoint URL, then Enter

cast chain-id --rpc-url "$RPC"                                        # 1
cast code "$FACTORY" --rpc-url "$RPC"                                 # 0x: nothing is there yet
cast call "$DEPLOYER" "$(cat "$OUT/factory.calldata")" --rpc-url "$RPC"    # prints the factory's address
cast estimate "$DEPLOYER" "$(cat "$OUT/factory.calldata")" --rpc-url "$RPC"  # about 3.6 to 3.7 million
cast gas-price --rpc-url "$RPC"                                       # in wei; 150000000 is 0.15 gwei
```

The `cast call` is the deployment run without sending it. If it prints the
factory's address, the constructor's checks pass in this block. If it reverts
while nothing is at the address, a market check failed: run the app against
the same endpoint, where **Set and forget** shows **Vaults aren't available
right now** and names the check, and try again later. If it reverts because
the factory is already there (`cast code` prints more than `0x`), someone
deployed it: go to step 5's checks.

### 5. The factory

```bash
cast send "$DEPLOYER" "$(cat "$OUT/factory.calldata")" --rpc-url "$RPC" --ledger --priority-gas-price 0.1gwei
```

`--ledger` signs with a hardware wallet; `--account <name>` signs with a
keystore made by `cast wallet import`. Don't put a private key on the command
line: it stays in the shell's history. Keep the transaction hash it prints.

`--priority-gas-price` is the tip, and it matters. Without it cast tips what
recent blocks' cheapest fifth paid: about 0.0002 gwei on 2026-10-01, which may
leave a 3.6-million-gas transaction waiting. 0.1 gwei adds about 0.0004 ETH
across both deployments. The account must hold the gas limit at the highest
fee cast bids, twice the base fee plus the tip, before anything is sent: about
0.009 ETH for the factory at a 1.25 gwei base fee.

```bash
FACTORY_TX=0x…
cast receipt "$FACTORY_TX" status --rpc-url "$RPC"          # true
cast receipt "$FACTORY_TX" blockNumber --rpc-url "$RPC"     # the factory's block: write it down
cast code "$FACTORY" --rpc-url "$RPC" | wc -c               # 9667: 4,832 bytes of code
cast code "$IMPLEMENTATION" --rpc-url "$RPC" | wc -c        # 20425: 10,211 bytes
cast call "$FACTORY" "vaultCount()(uint256)" --rpc-url "$RPC"   # 0
```

**Or from the app.** Run this same source (`pnpm dev:web`), give it your
mainnet endpoint, connect the wallet that will pay, and open **Buy SPX** →
**Recurring** → **Set and forget** → **Set up vaults on this network**. It
runs the same dry run before your wallet opens, and the same checks apply
afterwards; the block is on the transaction's page in your wallet or an
explorer.

### 6. The batcher

Either with the keeper you are about to run, which deploys it and waits for
the receipt (`docs/KEEPER.md`, "Deploying a batcher"), from `docker/keeper`
once its key is funded:

```bash
docker compose run --rm keeper --deploy-batcher
```

(without Docker: `pnpm keeper --deploy-batcher`, with the keeper's endpoint and
key set as `docs/KEEPER.md`'s "Without Docker" shows), or by hand, as the
factory was:

```bash
cast call "$DEPLOYER" "$(cat "$OUT/batcher.calldata")" --rpc-url "$RPC"   # prints the batcher's address
cast send "$DEPLOYER" "$(cat "$OUT/batcher.calldata")" --rpc-url "$RPC" --ledger --priority-gas-price 0.1gwei
```

Then:

```bash
BATCHER_TX=0x…
cast call "$BATCHER" "factory()(address)" --rpc-url "$RPC"   # the factory
cast receipt "$BATCHER_TX" blockNumber --rpc-url "$RPC"      # the batcher's block: write it down
```

When the keeper deployed it, the transaction's hash is in the keeper's log, on
the `batcher_deployed` line.

### 7. Record the blocks

Open `packages/vault/deployments.json` and replace the last entry's two `null`s
with the block numbers, as numbers:

```json
{
  "id": "v1",
  "factory": "0x…",
  "batcher": "0x…",
  "factoryBlock": 26100000,
  "batcherBlock": 26100012
}
```

Then:

```bash
pnpm --filter @spdex/vault build:artifacts
git diff --stat                              # deployments.json and src/artifacts.ts, two lines each
pnpm --filter @spdex/vault check:artifacts
git commit -am "Record where v1's factory and batcher were deployed"
```

This is the only hand edit an entry ever gets, and it freezes the entry:
`check:artifacts` fails from now on if it changes, and the next contract
change appends `v2` instead of rewriting it. Never remove an entry. Keepers
and the report serve every one, so a removed entry is a release whose vaults
nobody triggers.

### 8. Verify the source on explorers

Verified, explorers decode the contracts' events and show `close()` on a
vault's page, which is the walkaway route `docs/WALKAWAY.md` describes. The
settings are `packages/vault/foundry.toml`'s: solc 0.8.33, the optimizer at
200 runs, EVM version `cancun`, no metadata hash and no CBOR trailer.

```bash
cd packages/vault
V="--chain mainnet --verifier sourcify --compiler-version 0.8.33 --use $(which solc) --watch"

node scripts/forge.mjs verify-contract "$FACTORY" contracts/SpdexVaultFactory.sol:SpdexVaultFactory $V \
  --constructor-args "$(cat "$OUT/factory.args")"

node scripts/forge.mjs verify-contract "$IMPLEMENTATION" contracts/SpdexDcaVault.sol:SpdexDcaVault $V \
  --constructor-args "$(cast abi-encode 'constructor(address)' "$WETH")"

node scripts/forge.mjs verify-contract "$BATCHER" contracts/SpdexVaultBatcher.sol:SpdexVaultBatcher $V \
  --constructor-args "$(cast abi-encode 'constructor(address)' "$FACTORY")"
```

`--use` hands forge a solc of your own, which must be exactly 0.8.33 (`solc
--version`). Leave it out to let forge fetch one. NixOS needs it: forge's
downloaded compilers don't run there. For Etherscan, the same three with
`--verifier etherscan` and the key in `ETHERSCAN_API_KEY` (`read -rsp "key: "
ETHERSCAN_API_KEY; export ETHERSCAN_API_KEY`, which keeps it out of the shell's
history). An explorer that wants the input as a file takes what
`--show-standard-json-input` prints in place of submitting; check that it
carries the settings above before handing it over.

What to expect, from v1: Sourcify answers `match` on both the creation code and
the deployed code. That is the highest it can give: its `exact_match` would
need the metadata hash this build leaves out on purpose. Etherscan says
"Exact Match". Read what each explorer answers rather than trusting the exit
code.

A vault is an EIP-1167 clone with its terms appended to its code. Whether an
explorer recognises such a clone as a proxy of the verified implementation is
*unverified*: v1's contracts were verified before any vault existed. Look at
the first vault's page and say what it shows in `docs/WALKAWAY.md`. If it isn't
recognised, the raw call there still closes any vault.

### 9. Afterwards

- Make the docs say what is true now (checklist, part 2), and in
  `docs/WALKAWAY.md` say what the explorers showed.
- Start the keeper (checklist, part 3).
- Go on to the build settings. The release is built from the commit that
  records the blocks, or a later one.

### If something goes wrong

- **The send sits unmined.** Send it again from the same account at a higher
  fee. A deployment is safe to repeat: if the first lands, the second's
  estimate reverts and `cast` sends nothing.
- **Something is at the address, and you didn't send it.** Anyone may deploy
  these. Check it the same way (`cast code`, `vaultCount()`, `factory()`), and
  take its block from its transaction.
- **The addresses printed in step 2 are not the registry's.** The checkout is
  not the release's source, or a contract changed without `build:artifacts`.
  Stop; nothing on chain is wrong yet.
- **You deployed from the wrong source.** What landed is a factory nothing
  points at. Leave it, fix the checkout, and deploy the right one: never edit
  `deployments.json` to match a mistake.
- **A fault is found in a deployed contract.** It cannot be patched. The way
  out for owners is `close()`, and the fix is a new factory listed beside the
  old one: `docs/SECURITY.md`, "Reporting a vulnerability".

### What was rehearsed

Steps 2, 4, 5, 6 (both ways) and 7 were run on a fork of block 26,000,000 when
this page was written: the calls from step 2 are byte for byte what the app
and the keeper send, both landed at the registry's addresses, a second send
was refused at estimation, and `build:artifacts` and `check:artifacts`
accepted the filled-in blocks. Step 4's dry run also passed against Ethereum
itself that day. Not rehearsed: signing with `--ledger` or `--account`, the
explorer uploads, and the hosting header in checklist part 6.

### What happened: v1

Deployed on Ethereum on 2026-10-01, steps 4 to 6 with `cast send --keystore`
from a fresh account that holds no rights over either contract, each sent
with a 0.1 gwei tip at a base fee of about 0.37 gwei:

| | Block | Transaction | Gas |
|---|---|---|---|
| Factory (and the vault implementation) | 26,100,366 | `0x783002e161fe11c64e695fa0e36bd63da2f8fc73ab2913dbc3b9fda1e63fef3b` | 3,562,597 |
| Batcher | 26,100,368 | `0x9e53999cec0a0ae14f12d2d085513795f3ac697da3549201d1af8200631e6b2e` | 601,283 |

Both together cost about 0.0019 ETH. Checked after: the factory's code is
4,832 bytes and the implementation's 10,211, `vaultCount()` answered `0`, the
batcher's `factory()` is the factory, and neither address had code in the
block before its own. Step 7 recorded both blocks, and step 8 was done the
same day, through `scripts/forge.mjs` with `--use`. Sourcify matched all three
on creation and deployed code, and Etherscan shows "Exact Match" for each:
factory, implementation and batcher. How an explorer shows a vault is still
unseen: no vault existed yet.
