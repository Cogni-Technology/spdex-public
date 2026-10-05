# Releasing spDEX

One page for whoever publishes a release: a checklist in the order things have
to happen, then the runbook for putting the vault contracts on Ethereum. The
details live where they already were (`docs/IPFS-RELEASE.md`,
`docs/RPC-RUNBOOK.md`, `docs/KEEPER.md`), and each step links to them.

## The order, and why

1. **Settle what no command can**: where the source lives, who reviewed the
   disclaimer, which domain serves the app.
2. **Deploy the contracts, then record the blocks they landed in.** From v2
   that is three deployments, in this order: the SPX holder registry, the
   factory (whose constructor refuses a registry with no code), then the
   batcher (whose constructor reads the factory). The blocks go into
   `packages/vault/src/artifacts.ts`, which the app bundles, so they are part
   of the release's CID. A release built before its contracts are deployed is
   a release that has to be built again.
3. **Start a keeper, eligible.** Without one, a vault's buys happen only when
   its owner triggers them, or once their community windows are over, when a
   stranger finds them worth the gas. The keeper you run proves its `rewardTo`
   and is a community keeper from release day, like anyone's.
4. **Set the build settings, run the gate, tag, build, publish.** Every source
   change above has to be in the tagged commit.

**All at once.** The contracts, the app and the keeper of a release go out on
the same day (`docs/V2_UPGRADE.md`, decision 28): the app built from the
release's commit creates vaults only on its factory, and goes on showing,
funding, triggering and closing every listed release's vaults; the keeper
built from it serves them all. Deploying the registry early, so that holders
could prove before v2 vaults exist, was considered and not chosen: holders
prove from release day, the developers' keeper among them, with no special
treatment. Nothing about an earlier release changes: v1's contracts and every
v1 vault run as they did.

Two things cannot be undone. A deployed registry, factory, vault or batcher
cannot be changed: a fix is a new address and a new entry in
`deployments.json`, beside the old one. And a pushed history is public:
decide what it says first.

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
- [ ] **The clone line names the public home.** `docs/KEEPER.md`'s quick
      start clones `https://github.com/Cogni-Technology/spdex-public.git`;
      `grep -n "git clone" docs/KEEPER.md` and `git remote -v` name the same
      repository. If the source moves, change both before the release.
- [ ] **The disclaimer's legal review is decided.**
      `apps/web/src/lib/disclaimer.ts` carries a `NOT REVIEWED BY A LAWYER`
      note: the community prototype is published without a review, a risk
      its publisher accepted on 2026-10-02. Before a release beyond the
      prototype, have a lawyer read the text, then remove the note, its test
      in `apps/web/src/lib/disclaimer.test.ts` and the sentence in
      `docs/ARCHITECTURE.md` that repeats it, in one commit. A text that has
      never been released keeps its version: v2's is `2026-10b`, since
      `2026-10` shipped with v1, so a browser that saw v1's text is shown
      v2's once.
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

      It also rebuilds v1 from its frozen copy (`packages/vault/releases/v1`)
      and refuses unless that still gives v1's deployed addresses. A contract
      change after this release is deployed is the next release (`v3`), never
      an edit to this one, and v2 has to be frozen first
      ([Before the next release](#before-the-next-release-freeze-this-one)).
- [ ] **The self-review is done, and the bounty is published.** Contracts are
      released after self-review, the strict gate and fuzzing; an outside
      review is welcome, not required. `docs/SECURITY.md` carries the bug
      bounty, paid in credit (there and in the release notes), not money, and
      the app labels every vault **Unaudited** (`docs/V2_UPGRADE.md`, decision
      30). Review starts at the vendored proof verifier,
      `packages/vault/contracts/vendor/optimism` (its README names the commit
      and each file's hash).
- [ ] **The buy fee's reference still fits the network.** The default fee is
      one batched buy's network cost, `BATCHED_BUY_GAS` (126,000) priced at
      `FEE_NETWORK_REFERENCE` (0.15 gwei), plus 0.25% of the buy, at most
      0.69%; `FEE_CHEAP_REFERENCE` (0.083 gwei) judges which buys may never be
      made. All are in `packages/vault/src/fee.ts`; the two references are
      derived from one week of base fees. Look at a recent week before
      publishing. Changing them is a source change, not a contract change: no
      address moves, the 0.69% ceiling stays where the contract holds it, and
      only plans created after the release pay the new figure.
- [ ] **What the registry was built on still holds.** Its constants can't
      change after deployment, so check them against the chain on the day,
      with your mainnet endpoint in `RPC`:

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
      contract, not a proxy, so its storage layout can't move. Then check that
      `MIN_SPX` (690 SPX) is still within ordinary holders' reach at the day's
      price, and record one proof of a recent block:
      `node packages/vault/scripts/record-proofs.mjs --out /tmp/proofs 0xAHolder@<block>`
      (through `SPDEX_FORK_RPC_URL`, as the fork reads it).
      It refuses to write unless the header it rebuilds hashes to the block's
      hash, so it also says whether a hard fork has added a header field the
      proof builders don't know. If one has, add it to both builders
      (`FORK_FIELDS` in `packages/chain/src/header.ts`, `TRAILING_FIELDS` in
      the script) in this release: until then the app and the keeper prove
      only because they try the fields the service names beyond the ones they
      know (`checkedHeaderOf`), and a change other than a field appended stops
      them. A constant that no longer fits means a new registry, and with it a
      new factory; the batcher, bound to no factory, stays.
- [ ] **The flash-borrow figure is current.** A proof can't be met with
      borrowed SPX, but the balance check at the moment of a buy can, and the
      release publishes what that costs (`docs/V2_UPGRADE.md`, decision 17).
      `test/forge/FlashBorrow.t.sol` measures it at the pinned block: 42,648
      gas a batch of five and no fee, with 119,766 SPX in Uniswap v4's
      `PoolManager` to lend. Check that the `PoolManager` still holds at least
      690 SPX (it held about 162,298 on 2026-10-03):
      `cast call "$SPX" "balanceOf(address)(uint256)" 0x000000000004444c5dc75cB358380D2e3dE08A90 --rpc-url "$RPC"`.

### 2. The contracts

The runbook below has the commands.

- [ ] Rehearsed on a fork, start to finish.
- [ ] The SPX holder registry is deployed: there is code at its address, and
      `validUntil` answers `0` for any address.
- [ ] The factory is deployed: there is code at its address, `vaultCount()`
      answers `0`, and its `registry()` is the registry.
- [ ] The batcher is deployed, and its `weth()` is WETH.
- [ ] The three blocks are in `packages/vault/deployments.json` (the
      release's `registryBlock` and `factoryBlock`, the batcher's
      `batcherBlock`), `artifacts.ts` is rebuilt, `check:artifacts` passes,
      and the change is committed. From then on both entries are frozen.
- [ ] The registry, the factory, the vault implementation and the batcher are
      verified on Sourcify and Etherscan.
- [ ] The docs say what is true now: that the release's addresses are live
      (until now they are the addresses the source deploys to), where
      `README.md` says which networks have the factory ("Stats count vaults
      only"), and what `docs/WALKAWAY.md` says about the explorer route to a
      vault's calls.

### 3. A keeper

`docs/KEEPER.md` is the guide; its quick start is five steps with Docker.

- [ ] A keeper built from the release's commit is running against Ethereum
      with a key of its own, and its fees go to an address whose key is not on
      that machine (`SPDEX_KEEPER_REWARD_TO`). It serves every listed release:
      v1's vaults in batches to v1's batcher, every later release's to the
      shared one.
- [ ] **It is a community keeper from release day**, like anyone's
      (`docs/V2_UPGRADE.md`, decision 28): its `rewardTo` is an ordinary
      account, kept for the SPX, holding at least
      690 SPX, proven once the registry is deployed, from the app's **Prove
      another address** or with `SPDEX_KEEPER_PROVE=1`. Its log's
      `eligibility` record says it may be paid inside windows. It gets no
      special treatment, and it counts in the report's concentration figure
      like any other keeper.
- [ ] Its runway is watched: with a cold `rewardTo` the hot key earns nothing
      back, so someone tops it up by hand before
      `SPDEX_KEEPER_MIN_RUNWAY_DAYS` (7) runs out.
- [ ] It sends privately (`secrets/send_url`). Without that it says so at
      every start, and its batches can be copied or sandwiched.
- [ ] **Whether it has a subsidy is decided.** A v2 vault's fee is one batched
      buy's network cost plus 0.25% of the buy, never above 0.69%; above about
      0.0043 ETH a buy it pays its own gas in a batch of ten at most blocks.
      v1 vaults keep v1's
      fee, one batched buy's network cost and a tenth more, which pays for a
      buy only in a shared transaction at a cheap block; small v2 buys held at
      the ceiling are the same. A keeper with no subsidy never plans a loss, so
      it skips those. To have them made anyway, uncomment the four subsidy
      lines in `docker/keeper/.env` (`SPDEX_KEEPER_MAX_LOSS_PER_BUY_ETH` and
      the three caps under it) and set them to what you will pay a day. "How
      it earns, and what it costs" in `docs/KEEPER.md` has the figures.
- [ ] Something tells you when it stops ("Watching it"), and
      `pnpm keeper:report` prints what it did.
- [ ] A small v2 vault of your own, created in the app, gets its first buy
      from the keeper inside its community window, paid to the keeper's
      `rewardTo` and not to you: the check that the keeper is eligible.

### 4. The network service

`docs/RPC-RUNBOOK.md`, "Alchemy setup", steps 1 to 5.

- [ ] A separate account holds the key, its Domains allowlist is exactly the
      canonical origins, and it has a spending cap and alerts.
- [ ] Step 5's checks pass from a shell: 200 with the origin, 403 without,
      `eth_simulateV1` answers, and so does `eth_getProof` for SPX at the
      `finalized` block, which **Prove my SPX** needs. When a service refuses
      it, the app falls back to a pasted proof, which works but is the long
      way round (`docs/RPC-RUNBOOK.md`, "Proving SPX held: `eth_getProof`").

### 5. Build settings

In `.env.local` or the environment, each an `https://` address on a public
name. Every one is written into the bundle, so every one is part of the CID.

| Setting | What it gives the release | Unset |
|---|---|---|
| `VITE_SPDEX_SOURCE_URL` | The `git clone` in Verify this build, the footer's Source link, and two doc links built from it as GitHub browses a repository (`<source>/blob/HEAD/<path>#<anchor>`, so the source should be a GitHub or GitLab address): "Becoming a community keeper" in Help run the network and Community keeping, and the list of services that answer `eth_getProof` beside Paste a proof | "This build doesn't say where its source is published." The two doc links are left out |
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
      the registry's, the factory's and the batcher's addresses and blocks,
      the flash-borrow figure (checklist part 1), what a proof costs (about
      655,000 to 685,000 gas, `test/forge/Registry.t.sol`), and the bug
      bounty's terms (`docs/SECURITY.md`): credit, not money.
- [ ] The build is pinned, and DNSLink points at it
      (`docs/IPFS-RELEASE.md`, "Pinning"). Moving DNSLink is the moment the
      release reaches people: the app at the domain creates v2 vaults from
      then on.
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
      "Vaults aren't set up on this network yet", and the plan has its one
      line on who may earn its fee and for how long.
- [ ] **Collective DCA** reads both factories, v1's and v2's, and **Trust and
      exits** → **Verify this build** shows the source address and the
      commands.
- [ ] **Help run the network** → **Community keeping**, opened with the
      keeper's `rewardTo` connected, says it is eligible and until when.
- [ ] The footer has **Feedback**, and it opens the issue forms.
- [ ] The keeper's log shows it found both factories, that its `rewardTo` is
      eligible, and that it is waiting.
- [ ] `pnpm mainnet:smoke` passes against the published address
      (`docs/MAINNET-SMOKE.md`), Help run the network included, with its
      holder agent proven: run it at a quiet hour, or it is skipped for the
      gas.

## Runbook: deploying the contracts

This is v2's runbook: three contracts. v1's two went out the same way on
2026-10-01 ("What happened: v1", at the end).

### What gets deployed

Three transactions, each to the standard deterministic deployer
(`0x4e59b44847b379578588920ca78fbf26c0b4956c`), each carrying a fixed salt and
the contract's creation code, in this order:

1. **The SPX holder registry.** It has no constructor arguments and no owner,
   so its address follows from its bytecode alone, the vendored proof
   verifier's included.
2. **The factory.** Its constructor names the registry and refuses one with
   no code (`NotARegistry`), so the registry goes first. It also deploys the
   vault implementation every vault is a clone of, with the registry's address
   in its code, so one transaction puts both on chain.
3. **The batcher**, bound to no factory: its constructor names only WETH,
   so it needs nothing before it, and every later release whose vaults take
   `rewardTo` shares it. It goes last here only to keep one order.

The salts are `keccak256("spdex.vault.registry.v2")`,
`keccak256("spdex.vault.factory.v2")` and `keccak256("spdex.vault.batcher.v2")`
(`REGISTRY_SALT`, `FACTORY_SALT` and `BATCHER_SALT` in
`packages/vault/src/artifacts.ts`). The addresses follow from the source
alone, which is why `packages/vault/deployments.json` lists them before
anything is deployed. Until step 8 records their blocks, they are the
addresses this source deploys to, not contracts anyone can use:

| Contract | Address this source deploys to |
|---|---|
| SPX holder registry | `0x2c7f732a453fe0a4a65f36ac564ff16007b5610d` |
| Factory | `0xbf40f0fb41e5ee1194173545749d80c4651bac32` |
| Vault implementation (the factory's first creation) | `0xeba51b96621f0fce83e017c0a46330c8cde323db` |
| Batcher | `0xd1f8327aa8398997bd88165f420412c703ebfed0` |

A change to any byte of the registry or its vendored verifier moves the
registry and the factory; a change to the batcher moves the batcher alone.
Step 2 prints what the checkout in front of you builds to. Anyone may
send any of the three, from any account, and the sender gets no rights over
what it deploys. If someone else sends one first, it lands at the same address
with the same code, and yours has nothing left to do.

**What it costs.** Measured on a fork of Ethereum on 2026-10-05: 1,781,553
gas for the registry, 4,122,976 for the factory and 539,274 for the batcher,
about 6.44 million together. That is about 0.001 ETH at 0.15 gwei, 0.0064 ETH
at 1 gwei and 0.0135 ETH at 2.1 gwei, the base fee that day. Base fees swing
several-fold within a day, so a quiet hour is worth waiting for.

**What can refuse it.** The registry's constructor does nothing, so only an
address already taken refuses it. The factory's refuses a registry with no
code (`NotARegistry`), then checks SPX's market as it is in that block: the
v3 pool and the v2 pair must agree on the price within 2%
(`MAX_MARKET_GAP_BPS`), and the pool must have at least 10 WETH of depth and
100 observations behind its average. The batcher's refuses a WETH with no
code (`NoWeth`), which on Ethereum it never is. A refused deployment reverts; step 4's dry run tells you
before you pay for it.

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

It prints the six addresses the rest of this page calls the deployer, the
registry, the factory, the implementation, the batcher and WETH. The
registry and the factory must be the ones in `packages/vault/deployments.json`'s
last release, and the batcher its last batcher. Put them in the shell:

```bash
DEPLOYER=0x4e59b44847b379578588920ca78fbf26c0b4956c
REGISTRY=0x…         # as printed
FACTORY=0x…
IMPLEMENTATION=0x…
BATCHER=0x…
WETH=0x…
```

Each `.calldata` file is the deployer's whole input, the salt and then the
init code, so it is byte for byte what anything else that deploys these
contracts sends, the app's **Set up vaults on this network** and the keeper's
`--deploy-batcher` included: other bytes would land at another address.

### 3. Rehearse on a fork

Start a fresh fork (`pnpm anvil:fork`; one that has run the test suite already
has all three contracts) and walk steps 4 to 8 against
`http://127.0.0.1:8545` with a throwaway key:

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

Each `cast call` to the deployer is the deployment run without sending it.
The factory's needs the registry, which isn't there yet, so that call alone
puts the registry's code at its address (`--override-code`); nothing on chain
changes. If it prints the factory's address, the constructor's checks pass in
this block. If it reverts while nothing is at the address, a market check
failed: run the app against the same endpoint, where **Set and forget** shows
**Vaults aren't available right now** and names the check, and try again
later. If a call reverts because its contract is already there (`cast code`
prints more than `0x`), someone deployed it: go to that step's checks.

### 5. The registry

```bash
cast send "$DEPLOYER" "$(cat "$OUT/registry.calldata")" --rpc-url "$RPC" --ledger --priority-gas-price 0.1gwei
```

`--ledger` signs with a hardware wallet; `--account <name>` signs with a
keystore made by `cast wallet import`. Don't put a private key on the command
line: it stays in the shell's history. Keep the transaction hash it prints.

`--priority-gas-price` is the tip, and it matters. Without it cast tips what
recent blocks' cheapest fifth paid: about 0.0002 gwei on 2026-10-01, which may
leave a multi-million-gas transaction waiting. 0.1 gwei adds about 0.0006 ETH
across the three deployments. The account must hold the gas limit at the
highest fee cast bids, twice the base fee plus the tip, before anything is
sent: at a 1.25 gwei base fee, about 0.005 ETH for the registry, 0.010 ETH for
the factory and 0.0013 ETH for the batcher.

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
"$OUT/factory.initcode")"` runs the creation code without the deployer, whose
revert carries no reason, and shows the constructor's own.

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

**Or from the app.** Run this same source (`pnpm dev:web`), give it your
mainnet endpoint, connect the wallet that will pay, and open **Buy SPX** →
**Recurring** → **Set and forget** → **Set up vaults on this network**. It
runs the same dry runs before your wallet opens, the factory's with the
registry's code put at its address as step 4 does
(`factoryRefusalBeforeRegistry`), so a factory the market would refuse is
said before the registry is paid for. Then it sends the same calls, the
registry's first when it isn't there, each confirmed before the next, and
the same checks apply afterwards; each block is on the transaction's page in
your wallet or an explorer. The batcher is not among them: step 7.

### 7. The batcher

Either with the keeper you are about to run, which deploys it and waits for
the receipt (`docs/KEEPER.md`, "Deploying a batcher"), from `docker/keeper`
once its key is funded:

```bash
docker compose run --rm keeper --deploy-batcher
```

(without Docker: `pnpm keeper --deploy-batcher`, with the keeper's endpoint and
key set as `docs/KEEPER.md`'s "Without Docker" shows), or by hand, as the
others were:

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

When the keeper deployed it, the transaction's hash is in the keeper's log, on
the `batcher_deployed` line.

### 8. Record the blocks

Open `packages/vault/deployments.json` and replace the `null`s with the block
numbers, as numbers: the last release's `registryBlock` and `factoryBlock`,
and the last batcher's `batcherBlock`. v1's entry stays exactly as it is.

```json
{
  "releases": [
    { "id": "v1", … },
    {
      "id": "v2",
      "source": "v2",
      "factory": "0x…",
      "registry": "0x…",
      "markets": [ … ],
      "factoryBlock": 26200004,
      "registryBlock": 26200000
    }
  ],
  "batchers": [
    { "source": "v2", "batcher": "0x…", "batcherBlock": 26200009 }
  ]
}
```

The registry's block is at or before the factory's; `build:artifacts` refuses
anything else. Then:

```bash
pnpm --filter @spdex/vault build:artifacts
git diff --stat                              # deployments.json and src/artifacts.ts: the three blocks in each
pnpm --filter @spdex/vault check:artifacts
git commit -am "Record where v2's registry, factory and batcher were deployed"
```

This is the only hand edit an entry ever gets, and it freezes the entry:
`check:artifacts` fails from now on if it changes. Never remove an entry.
Keepers and the report serve every one, so a removed entry is a release whose
vaults nobody triggers. What comes next depends on what changes
([Before the next release, freeze this one](#before-the-next-release-freeze-this-one)).

### 9. Verify the source on explorers

Verified, explorers decode the contracts' events and show a vault's calls on
its page, which is the walkaway route `docs/WALKAWAY.md` describes. The
settings are `packages/vault/foundry.toml`'s: solc 0.8.33, the optimizer at
200 runs, EVM version `cancun`, no metadata hash and no CBOR trailer. Four
contracts, all from the default profile, which builds v2's `contracts/` (v1's
contracts of the same names are under `releases/v1`, and were verified on
2026-10-01):

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

The registry takes no constructor arguments. The proof verifier vendored from
Optimism (`contracts/vendor/optimism`: `SecureMerkleTrie`, `MerkleTrie`,
`RLPReader`, `RLPErrors` and `Bytes`) is not a deployment of its own: every
function the registry uses is `internal`, compiled into the registry's code,
so there is nothing to link and no fifth address. Its source goes up with the
registry's, each file under its own licence header (MIT for Optimism's files,
AGPL for spDEX's); check that the explorer shows all of them, and that they
match `contracts/vendor/optimism/README.md`'s hashes.

`--use` hands forge a solc of your own, which must be exactly 0.8.33 (`solc
--version`). Leave it out to let forge fetch one. NixOS needs it: forge's
downloaded compilers don't run there. For Etherscan, the same four with
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
*unverified*: v1's contracts were verified before any vault existed, and v2's
will be too. Look at the first v2 vault's page and say what it shows in
`docs/WALKAWAY.md`. If it isn't recognised, the raw calls there still close
any vault, and make a v2 vault's due buy for its owner.

### 10. Afterwards

- Make the docs say what is true now (checklist, part 2), and in
  `docs/WALKAWAY.md` say what the explorers showed.
- Start the keeper and prove its `rewardTo` (checklist, part 3).
- Go on to the build settings. The release is built from the commit that
  records the blocks, or a later one, and goes out the same day.

### Before the next release, freeze this one

What the next change to the contracts takes depends on what it changes
(`docs/ARCHITECTURE.md`, "Upgradeability"):

- **Nothing on chain** — a new default fee or window, turns for new plans
  (decision 35), a new gas figure for batched buys: an app or keeper release.
- **The batcher alone**: freeze the source (below), change the batcher, and
  `build:artifacts` appends one `batchers` entry and no release. Deploy it,
  record its block. The app and the keeper send through the newest batcher
  from the next build; the old one's logs stay readable.
- **Another market list, or another registry, with the code unchanged**:
  append a release to `deployments.json` by hand, `{ "id": "v3", "source":
  "v2", "factory": null, "registry": "0x…", "markets": [ … ], "factoryBlock":
  null, "registryBlock": null }` (a shared registry keeps its own block), run
  `build:artifacts`, which fills in the factory, and deploy it. No code
  changes anywhere: everything goes by the release's source.
- **The vault, the factory or the registry**: freeze the source (below), then
  change `contracts/`; `build:artifacts` appends the release, and a batcher
  only if the batcher changed.

Once a release built from `contracts/` has its blocks recorded,
`build:artifacts` refuses any build in which that source no longer gives the
addresses recorded for it, so the source must be frozen before the first
change to any contract:

1. Copy `packages/vault/contracts/` verbatim to
   `packages/vault/releases/v2/contracts/`, with a README like
   `releases/v1/README.md` that gives v2's addresses and blocks. It is never
   edited again.
2. Add a `[profile.v2]` to `packages/vault/foundry.toml`, as `[profile.v1]`
   is: its own `src`, `out` and `cache_path`, and the same compiler settings
   repeated. Add its output directories to `packages/vault/.gitignore`.
3. In `packages/vault/scripts/build-artifacts.mjs`'s `SOURCES`, set v2's row
   to `frozen: true` with that profile, `out` and `dir`, and add a `v3` row for
   `contracts/` with the default profile and its salts (the factory's and the
   batcher's may stay `…v2`: changed bytecode moves an address anyway).
4. Add the new source's row to `SOURCE_BUYS` in `packages/vault/src/fee.ts`
   (what a buy of its code costs a keeper, and the fee its plans are offered;
   the build will not compile without it), and add its ABIs to the
   `AnyVaultAbi`/`AnyBatcherAbi` unions in `src/index.ts` and `src/batcher.ts`
   if they differ.

Nothing that reads vaults changes: v2's vaults go on being read through
`SOURCES.v2`, and the new source's through its own row. Then contracts may
change, and the build appends what changed. A release that leaves the
registry's source untouched builds the same registry address, and shares
v2's registry.

### If something goes wrong

- **The send sits unmined.** Send it again from the same account at a higher
  fee. A deployment is safe to repeat: if the first lands, the second's
  estimate reverts and `cast` sends nothing.
- **Something is at an address, and you didn't send it.** Anyone may deploy
  these. Check it the same way (`cast code`, `validUntil`, `vaultCount()`,
  `registry()`, `factory()`), and take its block from its transaction.
- **The factory's dry run reverts, with nothing at the registry's address.**
  Deploy the registry first: `NotARegistry` (`0x81d522f5`) is the
  constructor's refusal of a registry with no code.
- **The addresses printed in step 2 are not the ones `deployments.json`
  records.** The checkout is not the release's source, or a contract changed
  without `build:artifacts`. Stop; nothing on chain is wrong yet.
- **You deployed from the wrong source.** What landed is a registry or a
  factory nothing points at. Leave it, fix the checkout, and deploy the right
  one: never edit `deployments.json` to match a mistake.
- **A fault is found in a deployed contract.** It cannot be patched. The way
  out for owners is `close()`, and the fix is a new release listed beside the
  old one: `docs/SECURITY.md`, "Reporting a vulnerability". A fault in the
  registry can cost a window's fees, never a vault's funds: while a fixed
  registry, vault, factory and batcher ship as the next release, the app goes
  on creating v2 vaults, and a build sets `REGISTRY_ADVISORY`
  (`apps/web/src/lib/dca/advisory.ts`), the notice prepared for this, which
  shows on v2 cards, above the form and in the community keeper panel
  (`docs/V2_UPGRADE.md`, decision 31).

### What was rehearsed

**v2**, on 2026-10-03, on a fork of block 26,000,000 of its own (not the
shared one on :8545): step 2's script; step 4's dry runs, the factory's
refused with `NotARegistry` until the registry was there; steps 5, 6 and 7 by
hand with `cast send --legacy` from a fresh key, each contract landing at the
address `deployments.json` records, with the gas, code sizes and answers given
above; and a second send of the registry and of the factory, each refused at
estimation. The same day, against Ethereum itself at block 26,109,736, the
registry's dry run printed its address, and the factory's, with the
registry's code put in place for the call, printed the factory's: SPX's
markets passed the factory's checks that day. Not rehearsed for v2: step 6
through the app and step 7 through the keeper, step 8 with real blocks,
signing with `--ledger` or `--account`, the explorer uploads, and the hosting
header in checklist part 6.

**v1**, when its version of this runbook was written: its calls were run on a
fork of block 26,000,000, byte for byte what the app and the keeper send; both
contracts landed at the addresses `deployments.json` records, a second send
was refused at estimation, and `build:artifacts` and `check:artifacts`
accepted the filled-in blocks. Its dry run also passed against Ethereum itself
that day.

### What happened: v1

v1 has two contracts, the factory and the batcher, and no registry. Deployed
on Ethereum on 2026-10-01, the dry run and both sends with `cast send
--keystore` from a fresh account that holds no rights over either contract,
each sent with a 0.1 gwei tip at a base fee of about 0.37 gwei:

| | Block | Transaction | Gas |
|---|---|---|---|
| Factory (and the vault implementation) | 26,100,366 | `0x783002e161fe11c64e695fa0e36bd63da2f8fc73ab2913dbc3b9fda1e63fef3b` | 3,562,597 |
| Batcher | 26,100,368 | `0x9e53999cec0a0ae14f12d2d085513795f3ac697da3549201d1af8200631e6b2e` | 601,283 |

Both together cost about 0.0019 ETH. Checked after: the factory's code is
4,832 bytes and the implementation's 10,211, `vaultCount()` answered `0`, the
batcher's `factory()` is the factory, and neither address had code in the
block before its own. Both blocks were recorded, and the source verified the
same day, through `scripts/forge.mjs` with `--use`. Sourcify matched all three
on creation and deployed code, and Etherscan shows "Exact Match" for each:
factory, implementation and batcher. How an explorer shows a vault is still
unseen: no vault existed yet.
