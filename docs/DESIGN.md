# Auto-buy vaults: the design

The design of spDEX's auto-buy vault contracts (the vault, its factory, the
shared batcher and the SPX holder registry) and of what the app and the keeper
do with them. Each choice is a numbered decision, cited by number from code
and docs. The contracts are on mainnet: the registry since block 26,134,915,
the factory since 26,134,916, the batcher since 26,134,918 (addresses in
`packages/vault/deployments.json`; how contracts are deployed and verified:
the runbook in `docs/RELEASE.md`). The earlier test deployment (release `v1`
there) predates this design: its `execute()` pays whoever calls, at any time,
and the app, the keeper and the report still serve it (decision 27).

For the first minutes after each buy falls due, its fee can be paid only to
the vault's owner or to a proven SPX holder; after that, to anyone. The
registry decides only who may be paid inside that window and never touches
funds. The 0.69% fee ceiling, the 0.5 ETH funding cap, the on-chain price
floor and the rule that only a vault's owner can move its money hold as
everywhere else (AGENTS.md rule 6).

## Why

Without a window, every buy whose fee covers a stranger's gas goes to whoever
is fastest, which in practice means searcher bots that collect public rewards
across many protocols: one made a smoke-test vault's buy three blocks after
the vault was created. The window gives SPX's community first claim on those
fees instead.

## Goals and non-goals

Goals:

- SPX holders who run a keeper, or Help run the network in a tab, get first
  claim on every buy's fee, the first one after a missed slot included
  (decision 10).
- Outside callers earn only what the community leaves: buys still unmade when
  the window closes.
- Eligibility stays in the holder's wallet: no deposit, lock, custody or admin.
- It scales to every SPX holder (49,232 on 2026-10-02) with constant-cost
  checks and no on-chain list.
- No buy stalls for good: the open fallback and the owner's own trigger
  remain, and a failing registry delays a buy at most until its window ends
  (decision 14).

Non-goals: turns among holders, for now (decisions 6, 29 and 35); resisting
flash borrows at buy time (decision 17); slashing, since nothing is staked;
fixing the fee level in contracts (decision 9).

## How a buy works

| | Inside the community window | After it, until the next buy is due |
|---|---|---|
| **SPX holders** (a keeper, or Help run) | May make the buy; the fee goes to their own wallet | The same |
| **The owner** (Trigger now) | May make the buy; the fee comes back to the owner | The same |
| **Anyone else**, outside bots included | Can send the call, but can't be paid: the vault refuses any other `rewardTo` | May make the buy; the fee goes to any address |

The window starts when the buy became due, `dueSince`, and lasts
`communityWindow` seconds: 30 minutes by default, a quarter of the interval for
short plans, never less than 60 seconds and never more than an hour. The first
successful call makes the buy and ends that buy's chances for everyone else.
Inside the window, eligible keepers race, sending privately so that a lost
race costs nothing.

**When a buy became due (decision 10).** A vault cuts time into slots of
`interval` seconds from `startAt`, allows one buy per slot, never makes up a
missed slot, and spaces buys at least half an interval apart. `_nextBuyAt` is
the start of the slot after the last buy (or half an interval after it, if
later), so it is already past once a slot has been missed: gas above the fee,
a floor that refused, a vault short of funds. Measured from it, the first buy
after a miss would be open to anyone at once, exactly when a bot is waiting.
So the window is measured from

```
slotStart = startAt + ((block.timestamp − startAt) / interval) × interval
dueSince  = max(_nextBuyAt, slotStart)
```

and every slot's buy gets its own first claim. `dueSince` is at most half an
interval into its slot and the window at most a quarter, so a window always
ends inside the slot it started in.

**The owner's exception.** `rewardTo == owner` is always allowed, so
**Trigger now** works inside the window. A caller that pays the fee back to the
owner gains nothing, so this opens no door.

**`execute`'s one parameter (decision 11).** `execute(rewardTo)` names who
receives the caller's own fee, and nothing about the buy: the amount, the
token, the recipient of what's bought, the market and the floor are the
terms'. A forge fuzz test (`testFuzz_anyTwoAcceptedRewardTosMakeTheSameBuy`)
pins that any two `rewardTo` values the vault accepts make a byte-identical
buy (the same amount out, owner balance, slot and `buyNumber`), and only the
fee's recipient differs.

## The contracts

Four contracts, all ownerless and immutable, deployed at fixed addresses
through the deterministic deployer.

| Contract | What it does | Why |
|---|---|---|
| Vault (`SpdexDcaVault`), a clone of one implementation | `execute(address rewardTo)` pays the fee to `rewardTo`, never zero or the vault. Inside the window `rewardTo` must be the owner or pass `REGISTRY.isEligible`, asked with a fixed stipend (decisions 14 and 38), or the call reverts `NotEligible(rewardTo, windowEndsAt)`. `Bought` carries `rewardTo` and `dueSince`; `windowBuys` counts in-window buys not paid to the owner (decision 13). `status()` adds `dueSince`, `windowEndsAt`, `turnEndsAt` and `turn`. Turns, if a plan has them: `NotYourTurn` (decision 35). `close` falls back to WETH (decision 37). | Who is paid is a stated choice the vault can check, so a caller gains nothing by calling for someone else. |
| Vault terms (clone arguments) | 117 packed bytes: owner, market, amount, fee, start, interval, buys, slippage, `communityWindow` (4 bytes) and `turnBuckets` (1 byte). The registry's address is in the implementation's code, not in each clone. | Each plan's window, and whether it has turns, is fixed when it's made, like every other term. |
| Factory (`SpdexVaultFactory`) | Validates terms, clones, lists every vault. Requires `MIN_COMMUNITY_WINDOW ≤ communityWindow ≤ min(interval / 4, MAX_COMMUNITY_WINDOW)`, and `turnBuckets` 0 or 2 to `MAX_TURN_BUCKETS`. Names the registry in its constructor. | A window can't swallow the open fallback or the next buy, and can't be so short that first claim is nominal (decisions 4 and 12). `MIN_INTERVAL` is 300, so every plan allows at least a 75-second window. |
| Batcher (`SpdexVaultBatcher`), shared | Calls `execute(rewardTo)` on each address its caller lists; each vault pays `rewardTo` directly, so no WETH passes through it. `earned`, and `minRewards` against it, is the rise in `rewardTo`'s WETH during the call. Each vault gets the caller's `gasPerVault`, from `MIN_EXECUTE_GAS` (400,000) to `MAX_EXECUTE_GAS`. Bound to no factory (decision 34). | The window check sees the real recipient, and one batcher serves every release whose vaults take `rewardTo`. |
| SPX holder registry (`SpxHolderRegistry`) | `prove(holder, header, accountProof, storageProof)` records that `holder` held at least `MIN_SPX` at a recent block. `isEligible(holder)`: a proof still valid, the holder an account, and at least `MIN_SPX` held now. | Eligibility from the wallet itself, with nothing deposited. |
| `VaultLimits` | Caps and bounds, all constants: among them `MIN_COMMUNITY_WINDOW` (60 seconds, five blocks), `MAX_COMMUNITY_WINDOW` (an hour), `MAX_TURN_BUCKETS` (64), `MAX_REWARD_BPS` (69) and `MAX_FUNDING` (0.5 ETH). | — |

**Gas.** Inside the window a buy pays for one registry read and one SPX
`balanceOf`, about 9,000 gas, or 3,000 for a later buy paying the same
`rewardTo` in a batch (measured: `docs/ARCHITECTURE.md`, "The SPX holder
registry"). After the window the registry isn't asked.

## The SPX holder registry

An address is eligible when it held at least `MIN_SPX` at the end of a recent
block, proven once from Ethereum's own state; it is an account (no code, or
only an EIP-7702 delegation), since a contract can hand what it is paid to
whoever asks; and it holds `MIN_SPX` now. Nothing is deposited or locked, and
nobody keeps a list: the registry stores one `validUntil` time per address
that has proven.

`prove` checks a header against the block's real hash, follows two
Merkle-Patricia proofs from its state root to the holder's SPX balance,
requires at least `MIN_SPX` there, and sets `validUntil` to the block's time
plus `PROOF_TTL`. Anyone may prove any address: a proof states a fact. A proof
that would not move `validUntil` later reverts `NotNewer` (decision 16), so a
private relay drops it. The trie and RLP verification is Optimism's
`SecureMerkleTrie`, vendored under `contracts/vendor/optimism`, not written
fresh; it is the most complex piece of the contracts, and where review starts.
Step by step, with its constants (`MIN_SPX` and `PROOF_TTL` are decisions 1
and 2, in the registry rather than vault terms) and measured costs:
`docs/ARCHITECTURE.md`, "The SPX holder registry".

**Which block is proven (decision 15).** The app and the keeper prove the
`finalized` block, about 13 minutes old: no reorg can change its hash, and
EIP-2935's 8,191 blocks (about 27 hours) let a proof wait unsigned in a tab for
hours. `BLOCKHASH` covers the last 256 blocks, which keeps proving possible if
a hard fork moves EIP-2935.

**What a flash loan can and can't do (decision 17).** A proof reads a block's
final state, so SPX borrowed and repaid inside one transaction never appears
in one. The balance check at buy time is different: a flash borrow meets it,
for no fee and around a whole batch, from Uniswap v4's `PoolManager`
(measured in `test/forge/FlashBorrow.t.sol`; the figures:
`docs/UNISWAP-V4.md`, "What the PoolManager lends"). So what the registry
really filters for is "held 690 SPX at a block's end in the last 30 days",
and the docs say exactly that (what it lets an address do:
`docs/THREAT-MODEL.md`, "The community window and the SPX holder registry").
The balance check stays: it costs a few thousand gas, and it stops a holder
who sold, or a bag moved from address to address, from earning, unless they
write a contract for the purpose. The release notes publish the flash-borrow
figure.

**Cost and scale.** Checks cost the same for 10 holders or 49,232, and a proof
is one transaction every 30 days.

**The SPX stays in a cold wallet (decision 7).** Eligibility is checked on
`rewardTo`, the address paid, never on the key that signs. A keeper's server
holds only gas money. In a tab, Help run pays the connected wallet.

**What proving makes public (decision 24).** That an address held 690 SPX,
for good, and, through a keeper's buys, which hot key keeps for it: hence the
warning before a first proof (`docs/THREAT-MODEL.md`, "The community window
and the SPX holder registry").

**Why not a deposited bond (decision 8).** A deposit is simpler to check and
could be slashed, but it takes custody, adds a lock and an exit delay, and
breaks the in-wallet requirement.

**What it doesn't stop.** A bot can buy 690 SPX and prove it: the registry
filters for addresses that held SPX recently, not for people, and inside the
window the fastest eligible keeper wins. Turns would share buys out instead.
They ship in the vault unused, as address-hash buckets that need no keeper
list (decision 35), and a published figure decides when the app starts
creating plans with them (decision 29).

## The fee

Decision 9 sets the app's default for new vaults, an app setting rather than a
contract term (`packages/vault/src/fee.ts`):

```
buy fee = BATCHED_BUY_GAS × FEE_NETWORK_REFERENCE  +  0.25% of the buy,  at most 0.69% of the buy
```

`BATCHED_BUY_GAS` is 126,000 and `FEE_NETWORK_REFERENCE` 0.15 gwei. The fee is
fixed in each vault when it's made and is the same inside the window as after
it (decision 5). An app release changes it for new vaults only; only a fee
above 0.69%, or another way of paying it, would need new contracts. A larger
fee is also a larger prize for a bot that becomes eligible; the concentration
figure in `keeper:report` (decision 29) is how that shows up.

At that reference and ETH at $2,667, gas included (the keeper pays gas out of
the fee), a $6.90 buy pays $0.048 (the 0.69% cap), a $69 buy $0.2225 (0.33%),
and a $690 buy $1.775 (0.26%).

### What comparable products charged on 2026-10-02

Pool fees are left out; every on-chain route pays them. "Own page" means the
figure was read on the provider's own documentation.

| Product | Kind | Fee | Network fee | Source |
|---|---|---|---|---|
| [fomo](https://help.fomo.family/en/articles/14436214-trading-fees-on-fomo) | Mobile app | 0.50% (0.45% with a referral) | On top, on Ethereum | Own page |
| [MetaMask Swaps](https://support.metamask.io/trade/swap/user-guide-swaps/) | Wallet | 0.875% | On top | Own page |
| [Phantom](https://help.phantom.com/hc/en-us/articles/5985106844435) | Wallet | 0.85% | On top | Own page |
| [Zerion](https://help.zerion.io/en/articles/4813752) | Wallet | 0.67% (0.25% with Premium) | On top | Own page |
| [Rabby](https://x.com/Rabby_io/status/1809154330622140734) | Wallet | 0.25% | On top | Own post (2024) and a 2026 review |
| [Uniswap app](https://blog.uniswap.org/unification) | Swap site | 0% since 2025-12-27 | On top | Own blog |
| [CoW Swap](https://docs.cow.fi/governance/fees) | Swap site | 0.02%, plus half of any price improvement | In the quote | Own docs |
| [Banana Gun](https://bananagun.io), [Maestro](https://docs.maestrobots.com/sniper/monetization.md) | Bots | 0.5–1% | On top | Own pages |
| [Jupiter recurring](https://docs.jup.ag/user-docs/trade/spot/recurring-orders) | Recurring buys (Solana) | 0.1%, plus up to 0.5% routing; $10 minimum a buy | Not stated | Own docs |
| [DeFi Saver DCA](https://help.defisaver.com/features/exchange/what-is-dca) | Recurring buys, Ethereum | 0.3% | On top; a run is skipped when gas is over 5% of it | Own docs |
| Brahma | Recurring buys, Ethereum | 0.30% | On top | Own docs |
| [Glider](https://blog.glider.fi/glider-vs-bamboo/) | Automated portfolios | 0.30% | Included | Own blog |
| Mean Finance (Balmy) | Recurring buys, Ethereum | 0.6%, shared with the keeper | Included | Docs offline; no longer running |
| [Kraken](https://kraken.com/features/fee-schedule) | Exchange | 1%, plus spread | — | Own page |
| [Robinhood](https://robinhood.com/us/en/support/articles/crypto-order-routing/) | Exchange | 0.95%, inside the spread | — | Own page |
| Coinbase | Exchange | About 2.9% measured on a $200 buy | — | Third party (NerdWallet) |
| [Cash App](https://cash.app/bitcoin/fees), [Strike](https://strike.me/buy/) | Exchanges, bitcoin only | 0% on recurring buys | — | Own pages |

Wallets charge 0.67–1% plus gas and bots 0.5–1% plus gas, while Uniswap's app
and CoW Swap are nearly free for one-time swaps. On-chain recurring-buy tools
charge 0.1–0.6%, mostly 0.3% plus gas; the one service that ran on "the keeper
keeps the rest of a full fee" (Mean Finance, 0.6%) has shut down. Almost
nothing serves a $6.90 recurring buy on Ethereum: CoW's TWAP needs $5,000 a
part, Jupiter $10 a buy, and DeFi Saver skips runs when gas is high. spDEX's
fee sits under DeFi Saver's and Brahma's 0.3% plus gas, covers its own gas on
small buys, and leaves community keepers a margin.

## In the app and the keeper

| Area | What it does |
|---|---|
| Community keeping (in Help run the network) | Shows the connected wallet's eligibility, until when, and its SPX against `MIN_SPX`. **Prove my SPX** builds the proof in the browser from `eth_getProof` and the `finalized` block, and sends only if the rebuilt header hashes to the block's real hash. **Prove another address** does the same for any address (decision 22), so a hot browser wallet can prove a keeper's cold `rewardTo`. A warning before a wallet's first proof (decision 24). When the service refuses `eth_getProof`, a "paste a proof" box (`docs/RPC-RUNBOOK.md`, "Proving SPX held: `eth_getProof`"); the app never fetches from anywhere else (rule 4). Lapse reminders (decision 25). |
| Recurring → Set and forget | One line says who may earn the plan's fee and for how long (decision 3); Expert alone can change the window (decision 26). |
| Help run the network | Offers only buys of vaults that take `rewardTo` (decision 27), and pays the connected wallet. Buys still inside their window are offered only to an eligible wallet. An ineligible one sees "SPX holders have first claim until 14:32", its shortfall ("You hold 120 of the 690 SPX") and a plain link explaining community keeping, with no buy button (decision 23). Buys past their window are offered to anyone. |
| Vault cards, Trigger now | Trigger now sends `execute(owner)`, allowed at any time, and the card shows the window: "Community window until 14:32, then open to anyone." |
| Your activity, "I bought" card | Records each buy's caller, `rewardTo` and `dueSince`, and says who made it: you, a community keeper, or anyone after the window. |
| Collective DCA, find my vaults | Reads every listed factory's list; the app lists, funds and closes vaults from all of them and creates only on the latest. Collective DCA shows the share of buys made by SPX holders inside their window, from each vault's `windowBuys` read at one block. Display only; unknown when unreadable, never zero. |
| Guard, red-team suite | `prove` is `VaultGuard`'s sixth transaction (decision 21): refused unless it goes to the release's registry with no ether and a header whose hash the app matched; simulated, and may be signed `unverified`, since it moves no money and a false proof only reverts. Red-team cases: `prove` sent elsewhere, with ether or against the wrong block; a Help run batch paying anyone but the connected wallet; a Trigger now paying anyone but the owner. |
| Keeper (Docker image, `pnpm keeper`) | Serves every listed release, one batch per batcher. Takes buys inside their window only while its `rewardTo` is eligible, and otherwise waits for the window to close. Sends with the patient tip inside a window, the urgent one only in its tail (decision 19). Logs when its proof lapses; `SPDEX_KEEPER_PROVE=1` proves again before then (decision 20). With a cold `rewardTo` it reports its runway and warns when low (decision 18). `docs/KEEPER.md` runs it. |
| `keeper:report` | Splits buys by who made them: this keeper, other community keepers, owners, and outside callers after the window. Publishes the share of window buys won by the top 1 and top 5 `rewardTo` addresses over a rolling 30 days, decision 29's figure. |

## How it is tested

- **Forge, on the pinned block.** The registry against real proofs recorded
  from mainnet (`packages/vault/test/fixtures/proofs`, by
  `scripts/record-proofs.mjs`) for blocks within 8,191 of `FORK_BLOCK`, false
  proofs, and fuzzing of the header and both trie proofs. Every edge of the
  window to the second, with `vm.warp`: `dueSince` after a missed slot and
  after the spacing rule, the window's last second, the first second after it,
  and the 60-second and quarter-interval bounds. A registry that reverts or
  burns its stipend counts as not eligible. The `rewardTo` fuzz invariant
  (decision 11). Gas against the budgets. A flash-borrowed batch (decision 17).
- **Fork integration.** Exactly one case waits in real time: a vault with a
  60-second window, and an ineligible keeper that waits it out before buying.
  No test moves the shared fork's clock (decision 32).
- **Eligibility on the fork.** anvil can't prove a block it mined (its state
  root is zero), so every proof a test sends is a real mainnet one. An
  eligible address that never signs (a keeper's or a batch's `rewardTo`) is a
  real holder, proven from its recorded proof by a fresh key; one that must
  sign (Help run's connected wallet) is a fresh key that buys 690 SPX on the
  fork and is written eligible with `anvil_setStorageAt` (AGENTS.md,
  "Determinism rules"). Fresh keys create every vault and send everything
  else; only the eligible address is borrowed.
- **E2E** checks the copy, proving (real mainnet holders, the page's
  `finalized` pinned to a forked block) and the in-window paths, and waits out
  no window.
- **Mainnet smoke** (`docs/MAINNET-SMOKE.md`, not a gate stage): a holder
  agent proves once, Help run is paid inside a window while an outside caller
  is refused, and a 5-minute plan runs with its 75-second window (decision 33).

## Risks and failure modes

Every row ends, at worst, in a delayed buy or a fee paid to the wrong person;
none reaches a vault's funds.

| Risk | What it would cost | Mitigation |
|---|---|---|
| A bug in the proof verifier accepts a false proof | Non-holders could earn window fees, as anyone can after a window. | A vendored, widely used verifier; forge tests with real `eth_getProof` fixtures; fuzzing; review focused here. After deploy: decision 31. |
| The registry reverts or runs out of gas | A buy inside its window fails as if `rewardTo` weren't eligible. | It counts as "not eligible" (decision 14), so the buy waits at most until its window ends, or for the owner. |
| No eligible keeper is online, or none has proven | Buys wait out their windows, then go to whoever is fastest. | The window is short and bounded; the owner can always trigger; the developers' keeper runs eligible like any holder (decision 28). |
| A holder sells after proving | Fails the current-balance check, unless they flash-borrow SPX for each batch (next row). | Proving again needs the SPX back. |
| A flash borrow meets the current-balance check | Real and cheap: holding for one block every 30 days keeps an address eligible. | None in the contracts beyond the balance check, which still stops casual sellers (decision 17). |
| One bag of SPX proven for many addresses | Each address is proven while the bag passes through it, one block each. The balance is checked only at the buy, so the bag can be moved into whichever address a buy needs inside that buy's own transaction, and taken back after. One bag serves every address: with turns, every bucket, so turns share first claims out among addresses, not necessarily among holders (decision 35). Spread over many `rewardTo`s, its wins don't reach decision 29's count of one `rewardTo`. | None in the contracts: a balance check can't tell whose SPX it is. Each address costs a proof every 30 days. Before decision 29 relies on the report's concentration figure, the report should also count wins by sending address. |
| A bot buys `MIN_SPX` and proves it | It keeps like any holder and, being fastest, may win most races inside the window. A larger fee (decision 9) makes that worth more. | `keeper:report` publishes how concentrated window wins are (decision 29). |
| The developers' keeper wins most window buys | Holders see the developers earning most window fees. | It counts towards decision 29's trigger like anyone else. |
| Holders bid against each other inside the window | Through private relays, the race can become a tip auction that hands the margin to block builders. | The stock keeper escalates only in the window's last minutes (decision 19). A keeper that bids higher can still win. |
| A cold-wallet keeper runs out of gas money | It stops sending; buys fall to other keepers, or open after their windows. | Runway in logs and the report, and a warning below a threshold (decision 18). |
| The person's network service refuses `eth_getProof` | That person can't prove from the app. | The paste-a-proof path, checked against their own service's block hash (decision 22). |
| Proving links a holder's wallet to their keeper | Their SPX holding and their hot key become publicly linked. | A warning before the first proof; `docs/KEEPER.md` suggests a wallet kept for the SPX (decision 24). |
| A hard fork removes or moves EIP-2935 | New proofs fail; existing ones last their 30 days; then windows lapse to open. | The `BLOCKHASH` path covers the last 256 blocks, which include the `finalized` block the app proves; a new registry is a new contract release. |
| A header format adds fields | None: the registry hashes the header as given and reads only fields 3, 8 and 11 (state root, number, timestamp), which no fork has moved. | Fork tests on a header with every current field (21 on 2026-10-02). |
| The SPX token migrates, or its storage layout changes | Proofs fail, and windows lapse to open as above. | A new registry, and so a new contract release. |
| `MIN_SPX` turns out wrong once SPX's price moves | Too high shuts out holders; too low lets bots buy in cheaply. | Fixed in the registry: changing it means a new contract release ("Considered and not chosen"). |
| The registry and the window add code | A larger risk surface, unaudited. | The 0.5 ETH per-vault cap, and the app labels every vault "Unaudited" (decision 30). |

## Decisions

The numbers never change. Decisions 34–38 move the changes most likely to be
wanted off the path of a new deployment (every change in the contracts'
behaviour needs new contracts, AGENTS.md rule 6), or ship them unused.

| # | Decision | Agreed |
|---|---|---|
| 1 | `MIN_SPX`, the holding that makes an address eligible | 690 SPX, fixed in the registry: within reach of ordinary holders; a bot can carry it too |
| 2 | `PROOF_TTL`, how long a proof lasts | 30 days: about 0.00007 ETH a month per keeper at 0.1 gwei, and a seller drops out at once anyway |
| 3 | The community window | Per vault, chosen by the app: 30 minutes by default, a quarter of the interval for short plans, between 60 seconds and an hour |
| 4 | Whether a vault may have no window | Not allowed: every vault gives holders first claim |
| 5 | The fee inside the window | Flat: the same inside the window as after it |
| 6 | Turns among holders | None for now: holders race, privately. Reopened by decision 29's figure; decision 35 puts turns in the vault, unused |
| 7 | Who must hold SPX | `rewardTo`, the address paid, so SPX never sits on a keeper's server |
| 8 | Proofs or a deposit | Proofs, which keep eligibility in the holder's wallet; a deposited bond only had proofs failed in fork tests |
| 9 | The fee level, the app's default for new vaults (an app setting, not fixed in code) | Batched network cost plus 0.25% of the buy, at most 0.69% |
| 10 | When the window starts | At `dueSince = max(_nextBuyAt, the start of the current slot)`, so the first buy after a missed slot has a window too |
| 11 | `execute`'s parameter | Exactly one, `rewardTo`: who receives the caller's fee, and nothing about the buy (AGENTS.md rule 6). A fuzz test pins that any two accepted `rewardTo` values give identical buys |
| 12 | The shortest window | `MIN_COMMUNITY_WINDOW` = 60 seconds, in `VaultLimits` and enforced by the factory |
| 13 | What a buy records | `Bought` carries `rewardTo` and `dueSince`; the vault counts `windowBuys` in a slot it already writes |
| 14 | A registry call that fails inside the window | Counts as not eligible, so a broken registry delays a buy only until its window ends |
| 15 | Which block is proven | `finalized`, checked through EIP-2935, with `BLOCKHASH` as the fallback |
| 16 | A proof that would change nothing | `prove` reverts with `NotNewer` |
| 17 | Flash borrows at buy time | Accepted and documented as a limit; the balance check stays; a flash-borrowed batch is measured and published |
| 18 | Keeping a cold-wallet keeper in gas | The operator tops up; the keeper reports its runway and warns below 7 days (`SPDEX_KEEPER_MIN_RUNWAY_DAYS`) |
| 19 | The keeper's tip inside the window | Patient, never escalating against other holders; urgent only in the window's last 2 minutes (the last quarter of a window under 8 minutes) |
| 20 | The keeper proving | Opt-in (`SPDEX_KEEPER_PROVE=1`); a fifth signing shape, `prove` for the configured `rewardTo` to a listed registry, with no ether |
| 21 | `prove` and the Guard | A sixth `VaultGuard` transaction; simulated; may be signed `unverified` |
| 22 | Whom the panel proves | The connected wallet, or any address typed in; a paste-a-proof path when the service refuses `eth_getProof` |
| 23 | Ineligible wallets, and how keeping is described | Show the shortfall and a plain link, never a buy button. Keeping is paid work ("Community keepers make other people's buys and are paid for each one; holding 690 SPX is the entry bar."), with no APR or projected earnings anywhere, and past earnings only after the fact |
| 24 | What proving makes public | A warning before a wallet's first proof; KEEPER.md suggests a wallet kept for the SPX |
| 25 | Proof-lapse reminders | A banner from 5 days before, and the buy-due notification path (no icon fetch) while the app is open |
| 26 | Changing the window | Expert only: presets of 1, 5, 15, 30 and 60 minutes and "a quarter of the interval", any above a quarter of the interval disabled, beside one line: "Shorter: your buy happens sooner when no holder is online. Longer: holders have more time to earn your fee." |
| 27 | Vaults without a window, and Help run | The app lists, funds, closes and triggers them as they are, with no way to move a plan. Help run offers only buys of vaults that take `rewardTo` |
| 28 | Launch | Everything at once. The developers' keeper is eligible like anyone, with no special treatment or disclosure |
| 29 | When to reopen turns | When one `rewardTo` wins over 50% of window buys for a rolling 30 days, the developers' keeper included |
| 30 | The review gate | Self-review, the strict gate and fuzzing, and a bug bounty paid in credit; an outside review is welcome, not required. Every vault is labelled "Unaudited" |
| 31 | A registry bug after deploy | Keep creating vaults, with a notice (`REGISTRY_ADVISORY`) on vault cards, above the form and in the community keeping panel, and ship a fixed registry, vault, factory and batcher as a new contract release |
| 32 | Testing the window's edges | In forge to the second; one real-time case on the fork, whose clock no test moves. On the fork, eligibility rests on real mainnet proofs, since anvil can't prove its own blocks |
| 33 | SPX for the mainnet smoke suite | The owner transfers 690 SPX to a holder agent once, and the holder agent's SPX never moves. One exception: `1-swap` sells back the SPX the owner agent just bought, after approving a router for no more than it holds, so the suite goes on testing a sale on mainnet. The suite refuses any other SPX leaving an agent |
| 34 | The batcher | Bound to no factory: built for WETH, `earned` is the rise in `rewardTo`'s WETH, the per-vault gas is the caller's (`gasPerVault`, at least `MIN_EXECUTE_GAS`). One batcher serves every release whose vaults take `rewardTo`; a fixed batcher ships alone, and `deployments.json` lists batchers apart from releases. The caller, not the batcher, checks that what it lists are vaults: the keeper takes them from listed factories' lists, and the Guard checks a batch the app sends |
| 35 | Turns among holders | In the vault, unused: a term `turnBuckets` (0, or 2 to `MAX_TURN_BUCKETS`, 64). With turns, a window's first half goes to the eligible addresses in the slot's bucket (`keccak256(rewardTo) mod k` equal to `keccak256(vault, slot) mod k`), the rest of the window to any eligible address. The app creates every plan with none (`DEFAULT_TURN_BUCKETS`) until decision 29 trips; then an app release, not a deployment, turns them on for new plans |
| 36 | Releases in the app and the keeper | Data, not names: `build-artifacts` writes every source's ABIs and `SOURCES` with what each can do (`features`, read from its ABIs), and code branches on features. A release built from an existing source (another market list, another registry) is one entry in `deployments.json` |
| 37 | `close` if unwrapping fails | Pays the budget as WETH: WETH sends a withdrawal with a 2,300-gas stipend, and a fork that repriced what a clone's `receive` costs would otherwise make every `close` revert, for good |
| 38 | `ELIGIBILITY_GAS` | 100,000, about nine times an honest answer: no vault can ever be given more, and a fork that repriced cold reads past a tighter stipend would turn every window into one only owners can be paid in |

### Considered and not chosen

- **The registry as a per-vault term**, so a fixed or new registry would need
  no new factory. Every vault of a factory asking the one registry it was
  deployed with is what lets the factory promise that every vault it made
  gives SPX holders first claim; and with releases as data (decision 36), a
  new factory built from the same code costs a deployment and a
  `deployments.json` entry, little more.
- **An open market list**, a factory accepting any market that passes its
  checks, so a new token needs no new factory. It was closed for good reasons
  ("The market list" in ARCHITECTURE.md); a new list is a release built from
  an existing source (decision 36) instead.
- **A per-vault `minSpx` term**, with the registry storing the proven balance,
  so a release could move the bar without new contracts. Decision 1 stands.
- **A smaller share than 0.25%**, to make the window a smaller prize for bots.
  Decision 9 stands.
- **The batcher refunding its caller's gas** from the rewards, so a keeper with
  a cold `rewardTo` funds itself. It would put WETH back through the batcher.
- **`BLOCKHASH` only**, dropping EIP-2935: a smaller registry, but a proof
  would have to land within about 30 minutes of being built.
- **A courtesy delay, a published address or a sunset date** for the
  developers' keeper.
- **A shorter `PROOF_TTL`** to raise the prove-then-sell cost, and **making
  flash resistance a release gate**.
- **A required outside review or audit**, and a paid bounty.
