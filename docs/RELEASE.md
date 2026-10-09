# Releasing spDEX

The checklist, in the order things happen, then the runbook for deploying the
vault contracts. Details live in `docs/IPFS-RELEASE.md`, `docs/RPC-RUNBOOK.md`
and `docs/KEEPER.md`; each step links to them.

- **Contracts before the build.** Their blocks go into
  `packages/vault/src/artifacts.ts`, which the app bundles, so they are part of
  the release's CID. A release built before its contracts are deployed has to
  be built again.
- **All at once** (`docs/DESIGN.md`, decision 28). A contract release's
  contracts, app and keeper go out the same day. The app built from its commit
  creates vaults only on the newest factory, and goes on showing, funding,
  triggering and closing every listed release's vaults; the keeper built from
  it serves them all.
- **An app-only release** (nothing under `packages/vault/contracts/` changes)
  skips parts 2 and 3.

Decision numbers below are `docs/DESIGN.md`'s.

Two things can't be undone. A deployed registry, factory, vault or batcher
can't be changed: a fix is a new address and a new entry in
`deployments.json`, beside the old one. And a pushed history is public.

## Checklist

### 1. Before anything is deployed

- [ ] **The source has a public home.** `git remote -v` names it, and private
      vulnerability reporting is on there: `docs/SECURITY.md` and
      `CONTRIBUTING.md` send reports to a security advisory "on this
      repository" and name no other contact. `docs/KEEPER.md`'s quick start
      clones the same repository (`grep -n "git clone" docs/KEEPER.md`); if
      the source moves, change both.
- [ ] **The history says what you want it to.**
      `git log --format='%an <%ae>' | sort -u` lists only the authors you
      intend. A pushed commit can't be changed.
- [ ] **The disclaimer's legal review is decided.**
      `apps/web/src/lib/disclaimer.ts` carries a `NOT REVIEWED BY A LAWYER`
      note: the prototype is published without a review, a risk its publisher
      accepted on 2026-10-02. Before a release beyond the prototype, have a
      lawyer read the text, then remove the note, its test in
      `apps/web/src/lib/disclaimer.test.ts` and the sentence in
      `docs/ARCHITECTURE.md` that repeats it, in one commit. A changed text
      bumps `DISCLAIMER_VERSION`, unless the current version has never
      shipped, so every browser shows it once.
- [ ] **The donation address is yours.** The tip list ships one entry, "spDEX
      donation vault" (`modules/tiplist-spx-community/module.js`,
      `SPDEX_DONATION_ADDRESS` in `packages/core/src/tips.ts`). You hold its
      key, or every signer of its Safe is someone you chose, and it can receive
      SPX and WETH.
- [ ] **The contracts are final.** Nothing under
      `packages/vault/contracts` is waiting to change, and the committed
      addresses are what the source builds to:

      ```bash
      pnpm --filter @spdex/vault check:artifacts
      ```

      It also rebuilds every frozen source under `packages/vault/releases/`
      and refuses unless each still gives its deployed addresses. Once the
      current source is on mainnet, a contract change is a new contract
      release, never an edit to this one, and the current source is frozen
      first ([Before the next release](#before-the-next-release-freeze-this-one)).
- [ ] **A contract release is self-reviewed, and the bounty is published.**
      Contracts are released after self-review, the strict gate and fuzzing;
      an outside review is welcome, not required. `docs/SECURITY.md` carries
      the bug bounty, paid in credit (there and in the release notes), not
      money, and the app labels every vault **Unaudited** (decision 30).
      Review starts at the vendored proof verifier,
      `packages/vault/contracts/vendor/optimism` (its README names the commit
      and each file's hash).
- [ ] **The buy fee's references still fit the network.** In
      `packages/vault/src/fee.ts`, the default fee is one batched buy's
      network cost, `BATCHED_BUY_GAS` (126,000) at `FEE_NETWORK_REFERENCE`
      (0.15 gwei), plus 0.25% of the buy, at most 0.69%;
      `FEE_CHEAP_REFERENCE` (0.083 gwei) decides which buys may never be made.
      Both references come from one week of base fees: compare a recent week.
      Changing them is a source change, not a contract change: no address
      moves, the contract keeps the 0.69% ceiling, and only plans created
      after the release pay the new figure.
- [ ] **What the registry was built on still holds.** A registry's constants
      can't change once it is deployed, so check them before deploying one;
      the proof check at the end applies at every release. With your mainnet
      endpoint in `RPC`:

      ```bash
      read -rs RPC                  # paste your mainnet endpoint URL, then Enter
      SPX=0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C
      PAIR=0x52c77b0cb827afbad022e6d6caf2c44452edbc39   # SPX's Uniswap v2 pair, which always holds SPX
      cast codehash "$SPX" --rpc-url "$RPC"      # 0x609392ad0852ef7ee3eb446922aa7d64da8d1524302b7c98b06029e28c5d309e
      cast call "$SPX" "decimals()(uint8)" --rpc-url "$RPC"                          # 8
      cast to-dec "$(cast storage "$SPX" "$(cast index address "$PAIR" 1)" --rpc-url "$RPC")"
      cast call "$SPX" "balanceOf(address)(uint256)" "$PAIR" --rpc-url "$RPC"        # the same number: BALANCE_SLOT is 1
      cast code 0x0000F90827F1C53a10cb7A02335B175320002935 --rpc-url "$RPC" | wc -c # 169: EIP-2935's history contract, 83 bytes
      ```

      The code hash is SPX's at the pinned block and on 2026-10-03: a plain
      contract, not a proxy, so its storage layout can't move. Check that
      `MIN_SPX` (690 SPX) is still within ordinary holders' reach at the day's
      price. Then record one proof of a recent block, through
      `SPDEX_FORK_RPC_URL` as the fork reads it:
      `node packages/vault/scripts/record-proofs.mjs --out /tmp/proofs 0xAHolder@<block>`.
      It refuses to write unless the header it rebuilds hashes to the block's
      hash, so it catches a hard fork that added a header field. If one has,
      add the field to both builders (`FORK_FIELDS` in
      `packages/chain/src/header.ts`, `TRAILING_FIELDS` in the script) in this
      release: until then the app and the keeper prove only through
      `checkedHeaderOf` trying the fields the service names, and any change
      other than an appended field stops them. A constant that no longer fits
      means a new registry, and so a new factory; the batcher stays.
- [ ] **The flash-borrow figure is current.** A proof can't be met with
      borrowed SPX, but the balance check at buy time can, and the release
      notes publish what that costs (decision 17; the figure, from
      `test/forge/FlashBorrow.t.sol`: `docs/UNISWAP-V4.md`, "What the
      PoolManager lends"). Check that Uniswap v4's `PoolManager` still holds
      at least 690 SPX to lend:
      `cast call "$SPX" "balanceOf(address)(uint256)" 0x000000000004444c5dc75cB358380D2e3dE08A90 --rpc-url "$RPC"`.

### 2. The contracts

The [runbook](#runbook-deploying-the-contracts) has the commands.

- [ ] Rehearsed on a fork, start to finish.
- [ ] Each new contract is deployed and answers as it should: a registry's
      `validUntil` is `0` for any address; a factory's `vaultCount()` is `0`
      and its `registry()` is the registry; a batcher's `weth()` is WETH.
- [ ] Their blocks are in `packages/vault/deployments.json`, `artifacts.ts` is
      rebuilt, `check:artifacts` passes, and the change is committed (step 8).
      Those entries are frozen from then on.
- [ ] Each new contract (a new factory's vault implementation included) is
      verified on Sourcify and Etherscan (step 9).
- [ ] The docs say what is true now: the new addresses wherever the docs name
      the live contracts (`git grep -n` the previous factory's address), and
      in `docs/WALKAWAY.md` what explorers show of a vault.

### 3. A keeper

`docs/KEEPER.md` is the guide.

- [ ] A keeper built from the release's commit runs against Ethereum with a
      key of its own, and its fees go to an address whose key is not on that
      machine (`SPDEX_KEEPER_REWARD_TO`). It serves every release in
      `deployments.json`.
- [ ] **It is a community keeper from release day**, like anyone's
      (decision 28): its `rewardTo` is an ordinary account kept for the SPX,
      holding at least 690 SPX, proven once the registry is deployed, from the
      app's **Prove another address** or with `SPDEX_KEEPER_PROVE=1`. Its
      log's `eligibility` record says it may be paid inside windows. It gets
      no special treatment, and counts in the report's concentration figure
      like any other keeper.
- [ ] Its runway is watched: with a cold `rewardTo` the hot key earns nothing
      back, so someone tops it up by hand before
      `SPDEX_KEEPER_MIN_RUNWAY_DAYS` (7) runs out.
- [ ] It sends privately (`secrets/send_url`). Without that it says so at
      every start, and its batches can be copied or sandwiched.
- [ ] **Its subsidy is decided.** Small buys, held at the 0.69% ceiling, don't
      pay their own gas, and a keeper with no subsidy never plans a loss, so
      it skips them. To have them made anyway, uncomment the four subsidy
      lines in `docker/keeper/.env` (`SPDEX_KEEPER_MAX_LOSS_PER_BUY_ETH` and
      the three caps under it) and set them to what you will pay a day
      (`docs/KEEPER.md`, "How it earns, and what it costs").
- [ ] Something tells you when it stops (`docs/KEEPER.md`, "Watching it"),
      and `pnpm keeper:report` prints what it did.
- [ ] A small vault of your own, created in the app, gets its first buy from
      the keeper inside its community window, paid to the keeper's `rewardTo`
      and not to you: the check that the keeper is eligible.

### 4. The network service

`docs/RPC-RUNBOOK.md`, "Alchemy setup", steps 1 to 5.

- [ ] A separate account holds the key, its Domains allowlist is exactly the
      canonical origins, and it has a spending cap and alerts.
- [ ] Step 5's checks pass from a shell: 200 with the origin, 403 without,
      `eth_simulateV1` answers, and so does `eth_getProof` for SPX at the
      `finalized` block, which **Prove my SPX** needs. Where a service refuses
      it, the app falls back to a pasted proof, which works the long way round
      (`docs/RPC-RUNBOOK.md`, "Proving SPX held: `eth_getProof`").

### 5. Build settings

In `.env.local` or the environment, each an `https://` address on a public
name. Each is written into the bundle, so each is part of the CID. The app
never guesses one: not from the address bar (a dev server, a shared gateway or
a stranger's copy) and not from a built-in domain.

| Setting | What it gives the release | Unset |
|---|---|---|
| `VITE_SPDEX_SOURCE_URL` | The `git clone` in Verify this build, the footer's Source link, and two doc links built from it as GitHub browses a repository (`<source>/blob/HEAD/<path>#<anchor>`, so the source should be a GitHub or GitLab address): "Becoming a community keeper" in Help run the network and Community keeping, and the list of services that answer `eth_getProof` beside Paste a proof | "This build doesn't say where its source is published." The two doc links are left out |
| `VITE_SPDEX_FEEDBACK_URL` | The footer's Feedback link | No link: testers have no way to reach the issue forms |
| `VITE_SPDEX_APP_URL` | The link on "I bought" cards and in calendar files | "open #receipt=… in any spDEX", and no link in calendar files |
| `VITE_SPDEX_DEFAULT_RPC_URL` and `VITE_SPDEX_CANONICAL_ORIGIN` | The built-in network service, offered last on the first screen at those origins | The first screen offers no built-in service: a key of their own or the public service |

- [ ] All five are set, the key and its origins together or neither.
- [ ] `pnpm fx:bands` passes, as the weekly "Currency bands" workflow should
      have been saying. Don't re-read `FX_REFERENCE` at a recent block: the
      strict gate would fail (`docs/IPFS-RELEASE.md`, "Read the currency
      feeds").

### 6. Gate, tag, build, publish

- [ ] The release commit is on `main`, and the repository has the
      `SPDEX_FORK_RPC_URL` secret: CI runs `pnpm verify --strict` on pushes to
      `main`, on pull requests, and when started by hand.
- [ ] The strict gate is green on that exact commit, with a clean tree:

      ```bash
      git status --short            # prints nothing
      pnpm anvil:fork               # another terminal
      pnpm verify --strict          # exit 0; .verify/report.json says ok, nothing skipped or empty
      ```

      Save no file under `apps/` or `packages/` while it runs: the browser
      stage's dev server reloads and a test sees a blank page.
- [ ] The commit is tagged, and the tag is pushed. Verify this build tells
      people to `git checkout <release tag>`, so the tag is what they look
      for. Every package stays at version `0.0.0`; the tag names the release.
      The tag's name is not in the bundle, so tagging doesn't change the CID.
- [ ] The release is built and its CID computed: `pnpm build:release`, then
      `pnpm ipfs:cid` (`docs/IPFS-RELEASE.md`, "Cutting a release").
- [ ] The release notes give the tag, the root CID, every `VITE_SPDEX_*`
      value it was built with (the committed `.env.defaults` ones included),
      the registry's, the factory's and the batcher's addresses and blocks,
      the flash-borrow figure (part 1), what a proof costs
      (`docs/ARCHITECTURE.md`, "The SPX holder registry"), and the bug
      bounty's terms (`docs/SECURITY.md`): credit, not money.
- [ ] The build is pinned, and DNSLink points at it (`docs/IPFS-RELEASE.md`,
      "Pinning"). Moving DNSLink is the moment the release reaches people.
- [ ] The domain that serves it sends
      `Content-Security-Policy: frame-ancestors 'none'` as a header:
      `curl -sI https://<host>/ | grep -i content-security-policy`. The app's
      own policy is a `<meta>` tag, which can't carry that directive, so
      nothing else stops another site from framing the page. An IPFS gateway
      can't send it; a domain in front of one can.

### 7. The first hour

Open the published address in a browser that has never seen spDEX.

- [ ] The disclaimer shows, then **Connect to Ethereum**: your own free key
      first, marked **Recommended**, then **Use a free public service**, then
      **Continue with spDEX's built-in service** as a link. That link shows
      only at the canonical origins; choose it, and the app reads the chain.
- [ ] A price check on **Buy SPX** does not say "Not checked".
- [ ] **Recurring** → **Set and forget** offers **Create and fund vault**, not
      "Vaults aren't set up on this network yet", and the plan has its one
      line on who may earn its fee and for how long.
- [ ] **Collective DCA** reads every listed factory, and **Trust and exits** →
      **Verify this build** shows the source address and the commands.
- [ ] **Help run the network** → **Community keeping**, opened with the
      keeper's `rewardTo` connected, says it is eligible and until when.
- [ ] The footer has **Feedback**, and it opens the issue forms.
- [ ] The keeper's log shows it found every listed factory, that its
      `rewardTo` is eligible, and that it is waiting.
- [ ] `pnpm mainnet:smoke` passes against the published address
      (`docs/MAINNET-SMOKE.md`), Help run the network included, with its
      holder agent proven: run it at a quiet hour, or that spec is skipped
      for the gas.

## Where the contracts are

On Ethereum since 2026-10-06, verified on Sourcify and Etherscan. Their
addresses and blocks, and the earlier test deployment's (`"v1"` in
`deployments.json`, source frozen in `packages/vault/releases/v1`), are in
`docs/ARCHITECTURE.md`, "One address, checkable from source".

## Runbook: deploying the contracts

Each contract is one transaction to the standard deterministic deployer
(`0x4e59b44847b379578588920ca78fbf26c0b4956c`), carrying a fixed salt and the
creation code. The salts are set per source in `build-artifacts.mjs`'s
`SOURCES` (`REGISTRY_SALT`, `FACTORY_SALT` and `BATCHER_SALT` in
`packages/vault/src/artifacts.ts`), so the addresses follow from the source
alone, and `deployments.json` lists them before anything is deployed. The
order:

1. **The SPX holder registry.** No constructor arguments and no owner: its
   address follows from its bytecode, the vendored proof verifier's included.
2. **The factory.** Its constructor names the registry and refuses one with
   no code (`NotARegistry`), so the registry goes first. It also deploys the
   vault implementation every vault is a clone of, with the registry's address
   in its code, in the same transaction.
3. **The batcher.** Its constructor names only WETH. It is bound to no
   factory, so it needs nothing before it, and every release whose vaults take
   `rewardTo` shares it.

A release deploys only what its source moved. A change to the registry or its
vendored verifier moves the registry and the factory; to the vault or the
factory, the factory; to the batcher, the batcher alone. A contract already at
its address is skipped. Anyone may send any of them, from any account, and the
sender gets no rights over what it deploys: if someone else sends one first,
it lands at the same address with the same code.

**What it costs.** The current source's three, measured on a fork of Ethereum
on 2026-10-05: 1,781,553 gas for the registry, 4,122,976 for the factory and
539,274 for the batcher, about 6.44 million together: about 0.001 ETH at 0.15
gwei, 0.0064 ETH at 1 gwei. Base fees swing several-fold within a day, so wait
for a quiet hour.

**What can refuse it.** The registry: only an address already taken. The
factory: a registry with no code (`NotARegistry`), then SPX's market as it is
in that block: the Uniswap v3 pool and the Uniswap v2 pair must agree on the
price within 2% (`MAX_MARKET_GAP_BPS`), and the pool needs at least 10 WETH of
depth and 100 observations behind its average. The batcher: a WETH with no
code (`NoWeth`), which on Ethereum it never is. A refused deployment reverts;
step 4's dry run says so before you pay.

Figures in the comments below are the current source's; a new source's come
from its rehearsal (step 3).

### 1. Start from the release's source

```bash
git status --short                           # prints nothing
pnpm install --frozen-lockfile
pnpm --filter @spdex/vault check:artifacts   # the committed addresses are this source's
```

You need Foundry's `cast` (`docs/DEVELOPMENT.md`, "Installing Foundry") and
Node 22.15 or later.

### 2. Write out the three calls

```bash
export OUT=~/spdex-deploy && mkdir -p "$OUT"
node --experimental-transform-types --disable-warning=ExperimentalWarning \
  --import ./packages/vault/scripts/ts-hooks.mjs --input-type=module -e '
import { writeFileSync } from "node:fs";
const a = await import("./packages/vault/src/artifacts.ts");
const out = process.env.OUT;
const factory = a.factoryAddress(a.MAINNET_DEPLOYMENT);
const call = (salt, initCode) => salt + initCode.slice(2); // the deployer takes the salt, then the init code
writeFileSync(`${out}/registry.initcode`, a.registryInitCode());
writeFileSync(`${out}/registry.calldata`, call(a.REGISTRY_SALT, a.registryInitCode()));
writeFileSync(`${out}/factory.initcode`, a.factoryInitCode(a.MAINNET_DEPLOYMENT));
writeFileSync(`${out}/factory.calldata`, call(a.FACTORY_SALT, a.factoryInitCode(a.MAINNET_DEPLOYMENT)));
writeFileSync(`${out}/batcher.calldata`, call(a.BATCHER_SALT, a.batcherInitCode(a.MAINNET_DEPLOYMENT.weth)));
writeFileSync(`${out}/factory.args`, "0x" + a.factoryInitCode(a.MAINNET_DEPLOYMENT).slice(a.FACTORY_CREATION_CODE.length));
console.log("deployer      ", a.DETERMINISTIC_DEPLOYER);
console.log("registry      ", a.registryAddress());
console.log("factory       ", factory);
console.log("implementation", a.MAINNET_IMPLEMENTATION);
console.log("batcher       ", a.batcherAddress(a.MAINNET_DEPLOYMENT.weth));
console.log("WETH          ", a.MAINNET_DEPLOYMENT.weth);'
```

The registry and the factory it prints must be `deployments.json`'s last
release's, and the batcher its last batcher. Put the six in the shell:

```bash
DEPLOYER=0x4e59b44847b379578588920ca78fbf26c0b4956c
REGISTRY=0x…         # as printed
FACTORY=0x…
IMPLEMENTATION=0x…
BATCHER=0x…
WETH=0x…
```

Each `.calldata` file is the deployer's whole input, salt then init code: byte
for byte what the app's **Set up vaults on this network** and the keeper's
`--deploy-batcher` send. Other bytes would land at another address.

### 3. Rehearse on a fork

Start a fresh fork (`pnpm anvil:fork`; one that has run the test suite already
has the current source's contracts) and walk steps 4 to 8 against
`http://127.0.0.1:8545` with a throwaway key:

```bash
cast wallet new                 # an address and a private key, for the fork only
pnpm dev:fund 0xThatAddress
```

Add `--legacy` to each `cast send` there: a fork that has mined nothing passes
cast's fee-history request upstream, where an archive endpoint refuses it.
Don't use an anvil test key: those accounts pass on any ether they receive
(`docs/TRY-IT.md`). The app's path is rehearsed in `docs/TRY-IT.md`, "Set up
vaults on the fork".

The path that has deployed on Ethereum is `cast send` by hand with a keystore;
the app's and the keeper's `--deploy-batcher` have not, so rehearse whichever
you use.

### 4. Dry run, on Ethereum

```bash
read -rs RPC                    # paste your mainnet endpoint URL, then Enter

cast chain-id --rpc-url "$RPC"                                               # 1
cast code "$REGISTRY" --rpc-url "$RPC"                                       # 0x: nothing is there yet
cast code "$FACTORY" --rpc-url "$RPC"                                        # 0x
cast call "$DEPLOYER" "$(cat "$OUT/registry.calldata")" --rpc-url "$RPC"     # prints the registry's address
cast estimate "$DEPLOYER" "$(cat "$OUT/registry.calldata")" --rpc-url "$RPC" # about 1.8 million
REGISTRY_CODE=$(cast call --rpc-url "$RPC" --create "$(cat "$OUT/registry.initcode")")   # the code the registry will have
cast call "$DEPLOYER" "$(cat "$OUT/factory.calldata")" --rpc-url "$RPC" \
  --override-code "$REGISTRY:$REGISTRY_CODE"                                 # prints the factory's address
cast gas-price --rpc-url "$RPC"                                              # in wei; 150000000 is 0.15 gwei
```

Each `cast call` to the deployer runs the deployment without sending it. The
factory's needs the registry, which isn't there yet, so that call alone puts
the registry's code at its address (`--override-code`); nothing on chain
changes. If it prints the factory's address, the constructor's checks pass in
this block. If it reverts while nothing is at the address, a market check
failed: run the app against the same endpoint, where **Set and forget** shows
**Vaults aren't available right now** and names the check, and try later. If
`cast code` prints more than `0x`, the contract is already there: go to that
step's checks.

### 5. The registry

```bash
cast send "$DEPLOYER" "$(cat "$OUT/registry.calldata")" --rpc-url "$RPC" --ledger --priority-gas-price 0.1gwei
```

`--ledger` signs with a hardware wallet; `--account <name>` with a keystore
made by `cast wallet import`. Never put a private key on the command line: it
stays in the shell's history. Keep the transaction hash it prints.

Set the tip (`--priority-gas-price`). Without it cast tips what recent blocks'
cheapest fifth paid (about 0.0002 gwei on 2026-10-01), which can leave a
multi-million-gas transaction waiting; 0.1 gwei adds about 0.0006 ETH across
the three. Before anything is sent, the account must hold the gas limit at the
highest fee cast bids, twice the base fee plus the tip: at a 1.25 gwei base
fee, about 0.005 ETH for the registry, 0.010 ETH for the factory and 0.0013
ETH for the batcher.

```bash
REGISTRY_TX=0x…
cast receipt "$REGISTRY_TX" status --rpc-url "$RPC"          # true
cast receipt "$REGISTRY_TX" blockNumber --rpc-url "$RPC"     # the registry's block: write it down
cast code "$REGISTRY" --rpc-url "$RPC" | wc -c               # 15957: 7,977 bytes of code
cast call "$REGISTRY" "MIN_SPX()(uint256)" --rpc-url "$RPC"  # 69000000000: 690 SPX
cast call "$REGISTRY" "validUntil(address)(uint64)" 0x0000000000000000000000000000000000000001 --rpc-url "$RPC"   # 0: nobody has proven
```

### 6. The factory

With the registry there, the factory's dry run needs no override:

```bash
cast call "$DEPLOYER" "$(cat "$OUT/factory.calldata")" --rpc-url "$RPC"      # prints the factory's address
cast estimate "$DEPLOYER" "$(cat "$OUT/factory.calldata")" --rpc-url "$RPC"  # about 3.9 million
cast send "$DEPLOYER" "$(cat "$OUT/factory.calldata")" --rpc-url "$RPC" --ledger --priority-gas-price 0.1gwei
```

If the first line reverts, `cast call --rpc-url "$RPC" --create "$(cat
"$OUT/factory.initcode")"` runs the creation code without the deployer (whose
revert carries no reason) and shows the constructor's own.

```bash
FACTORY_TX=0x…
cast receipt "$FACTORY_TX" status --rpc-url "$RPC"                 # true
cast receipt "$FACTORY_TX" blockNumber --rpc-url "$RPC"            # the factory's block: write it down
cast code "$FACTORY" --rpc-url "$RPC" | wc -c                      # 11003: 5,500 bytes of code
cast code "$IMPLEMENTATION" --rpc-url "$RPC" | wc -c               # 23709: 11,853 bytes
cast call "$FACTORY" "vaultCount()(uint256)" --rpc-url "$RPC"      # 0
cast call "$FACTORY" "registry()(address)" --rpc-url "$RPC"        # the registry
cast call "$IMPLEMENTATION" "registry()(address)" --rpc-url "$RPC" # the registry
```

**Or from the app.** Run this same source (`pnpm dev:web`) on your mainnet
endpoint, connect the wallet that will pay, and open **Buy SPX** →
**Recurring** → **Set and forget** → **Set up vaults on this network**. It
runs step 4's dry runs before your wallet opens
(`factoryRefusalBeforeRegistry`), so a factory the market would refuse is
caught before the registry is paid for, then sends the registry's call (when
it isn't there) and the factory's, each confirmed before the next. The same
checks apply; each block is on the transaction's page. The batcher is step 7.

### 7. The batcher

Either with the keeper, which deploys it and waits for the receipt
(`docs/KEEPER.md`, "Deploying a batcher"), from `docker/keeper` once its key
is funded:

```bash
docker compose run --rm keeper --deploy-batcher
```

(without Docker, `pnpm keeper --deploy-batcher`, with the endpoint and key set
as `docs/KEEPER.md`'s "Without Docker" shows; the hash is on the log's
`batcher_deployed` line), or by hand:

```bash
cast call "$DEPLOYER" "$(cat "$OUT/batcher.calldata")" --rpc-url "$RPC"   # prints the batcher's address
cast send "$DEPLOYER" "$(cat "$OUT/batcher.calldata")" --rpc-url "$RPC" --ledger --priority-gas-price 0.1gwei
```

Then:

```bash
BATCHER_TX=0x…
cast code "$BATCHER" --rpc-url "$RPC" | wc -c                # 4439: 2,218 bytes of code
cast call "$BATCHER" "weth()(address)" --rpc-url "$RPC"      # WETH
cast receipt "$BATCHER_TX" blockNumber --rpc-url "$RPC"      # the batcher's block: write it down
```

### 8. Record the blocks

In `packages/vault/deployments.json`, replace the `null`s with the block
numbers, as numbers: the last release's `registryBlock` and `factoryBlock`,
and the last batcher's `batcherBlock`. Every earlier entry stays exactly as it
is.

```json
{
  "releases": [
    …,
    { "id": "…", "source": "…", "factory": "0x…", "registry": "0x…", "markets": [ … ],
      "factoryBlock": 26200004, "registryBlock": 26200000 }
  ],
  "batchers": [
    …,
    { "source": "…", "batcher": "0x…", "batcherBlock": 26200009 }
  ]
}
```

A registry shared with an earlier release keeps that release's block. The
registry's block is at or before the factory's; `build:artifacts` refuses
anything else. Then:

```bash
pnpm --filter @spdex/vault build:artifacts
git diff --stat                              # deployments.json and src/artifacts.ts: the new blocks in each
pnpm --filter @spdex/vault check:artifacts
git commit -am "Record where the contracts were deployed"
```

This is the only hand edit an entry ever gets, and it freezes the entry:
`check:artifacts` fails from then on if it changes. Never remove an entry:
keepers and the report serve every one, so a removed entry is a release whose
vaults nobody triggers.

### 9. Verify the source on explorers

Verified, explorers decode the contracts' events and show a vault's calls on
its page: the walkaway route in `docs/WALKAWAY.md`. The settings are
`packages/vault/foundry.toml`'s: solc 0.8.33, the optimizer at 200 runs, EVM
version `cancun`, no metadata hash and no CBOR trailer. Verify each contract
this release deployed, from the default profile, which builds `contracts/`:

```bash
cd packages/vault
V="--chain mainnet --verifier sourcify --compiler-version 0.8.33 --use $(which solc) --watch"

node scripts/forge.mjs verify-contract "$REGISTRY" contracts/SpxHolderRegistry.sol:SpxHolderRegistry $V

node scripts/forge.mjs verify-contract "$FACTORY" contracts/SpdexVaultFactory.sol:SpdexVaultFactory $V \
  --constructor-args "$(cat "$OUT/factory.args")"

node scripts/forge.mjs verify-contract "$IMPLEMENTATION" contracts/SpdexDcaVault.sol:SpdexDcaVault $V \
  --constructor-args "$(cast abi-encode 'constructor(address,address)' "$WETH" "$REGISTRY")"

node scripts/forge.mjs verify-contract "$BATCHER" contracts/SpdexVaultBatcher.sol:SpdexVaultBatcher $V \
  --constructor-args "$(cast abi-encode 'constructor(address)' "$WETH")"
```

The proof verifier vendored from Optimism (`contracts/vendor/optimism`:
`SecureMerkleTrie`, `MerkleTrie`, `RLPReader`, `RLPErrors` and `Bytes`) is
not a deployment of its own: every function the registry uses is `internal`,
compiled into the registry's code, so there is nothing to link and no fifth
address. Its source goes up with the registry's, each file under its own
licence header (MIT for Optimism's, AGPL for spDEX's): check that the explorer
shows all of them, and that they match `contracts/vendor/optimism/README.md`'s
hashes.

`--use` hands forge a solc of your own, which must be exactly 0.8.33 (`solc
--version`); leave it out to let forge fetch one, except on NixOS, where
forge's downloaded compilers don't run. For Etherscan, the same four with
`--verifier etherscan` and the key in `ETHERSCAN_API_KEY` (`read -rsp "key: "
ETHERSCAN_API_KEY; export ETHERSCAN_API_KEY`, which keeps it out of the shell's
history). An explorer that wants the input as a file takes what
`--show-standard-json-input` prints instead of submitting; check that it
carries the settings above.

Sourcify should answer `match` on both the creation code and the deployed
code, the highest it can give this build (its `exact_match` needs the
metadata hash left out on purpose), and Etherscan "Exact Match". Read what
each answers rather than trusting the exit code.

A vault is an EIP-1167 clone with its terms appended to its code. Once a new
factory's first vault exists, look at its explorer page and say in
`docs/WALKAWAY.md` whether it shows as a proxy of the verified
implementation. If it doesn't, the raw calls there still close any vault and
make a vault's due buy for its owner.

### 10. Afterwards

- Make the docs say what is true now (checklist, part 2).
- Start the keeper and prove its `rewardTo` (checklist, part 3).
- Go on to the build settings. The release is built from the commit that
  records the blocks, or a later one, and goes out the same day.

### Before the next release, freeze this one

What a change to the contracts takes depends on what it changes
(`docs/ARCHITECTURE.md`, "Upgradeability"):

- **Nothing on chain** — a new default fee or window, turns for new plans
  (decision 35), a new gas figure for batched buys: an app or keeper release.
- **The batcher alone**: freeze the source (below), change the batcher, and
  `build:artifacts` appends one `batchers` entry and no release. Deploy it and
  record its block. The app and the keeper send through the newest batcher
  from the next build; the old one's logs stay readable.
- **Another market list, or another registry, with the code unchanged**:
  append a release to `deployments.json` by hand, `{ "id": "<next id>",
  "source": "<its source>", "factory": null, "registry": "0x…", "markets":
  [ … ], "factoryBlock": null, "registryBlock": null }` (ids run `v1`, `v2`, …
  with no gap; a shared registry keeps its own block), run `build:artifacts`,
  which fills in the factory, and deploy it. No code changes anywhere:
  everything goes by the release's source.
- **The vault, the factory or the registry**: freeze the source (below), then
  change `contracts/`; `build:artifacts` appends the release, and a batcher
  only if the batcher changed.

Once a release built from `contracts/` has its blocks recorded,
`build:artifacts` refuses any build in which that source no longer gives the
addresses recorded for it. So before the first change to any contract, freeze
the current source (`<id>` is its row's id in `SOURCES`, `v2` today):

1. Copy `packages/vault/contracts/` verbatim to
   `packages/vault/releases/<id>/contracts/`, with a README like
   `releases/v1/README.md` giving its addresses and blocks. It is never edited
   again.
2. Add a `[profile.<id>]` to `packages/vault/foundry.toml`, as `[profile.v1]`
   is: its own `src`, `out` and `cache_path`, and the compiler settings
   repeated (a profile inherits nothing). Add its output directories to
   `packages/vault/.gitignore`.
3. In `packages/vault/scripts/build-artifacts.mjs`'s `SOURCES`, set its row to
   `frozen: true` with that profile, `out` and `dir`, and add a row for the
   next source, `contracts/`, with the default profile and the same salts
   (changed bytecode moves an address anyway, and an unchanged registry keeps
   its own).
4. Add the new source's row to `SOURCE_BUYS` in `packages/vault/src/fee.ts`
   (what a buy of its code costs a keeper, and the fee its plans are offered;
   the build won't compile without it), and its ABIs to the
   `AnyVaultAbi`/`AnyBatcherAbi` unions in `src/index.ts` and `src/batcher.ts`
   if they differ.

Nothing that reads vaults changes: each source's vaults are read through its
own `SOURCES` row. Then the contracts may change, and the build appends what
changed.

### If something goes wrong

- **The send sits unmined.** Send it again from the same account at a higher
  fee. A deployment is safe to repeat: if the first lands, the second's
  estimate reverts and `cast` sends nothing.
- **Something is at an address, and you didn't send it.** Anyone may deploy
  these. Check it the same way (`cast code`, `validUntil`, `vaultCount()`,
  `registry()`, `weth()`), and take its block from its transaction.
- **The factory's dry run reverts, with nothing at the registry's address.**
  Deploy the registry first: `NotARegistry` (`0x81d522f5`) is the
  constructor's refusal of a registry with no code.
- **The addresses step 2 prints are not the ones `deployments.json`
  records.** The checkout is not the release's source, or a contract changed
  without `build:artifacts`. Stop; nothing on chain is wrong yet.
- **You deployed from the wrong source.** What landed is a contract nothing
  points at. Leave it, fix the checkout, and deploy the right one: never edit
  `deployments.json` to match a mistake.
- **A fault is found in a deployed contract.** It can't be patched. The way
  out for owners is `close()`, and the fix is a new contract release listed
  beside the old one (`docs/SECURITY.md`, "Reporting a vulnerability"). For
  a fault in the registry, a build sets the notice prepared for it,
  `REGISTRY_ADVISORY` (`apps/web/src/lib/dca/advisory.ts`), while the fixed
  contracts ship (decision 31; what it costs and why vaults go on being
  created: `docs/THREAT-MODEL.md`, "The community window and the SPX holder
  registry").
