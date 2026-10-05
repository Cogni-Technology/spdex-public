# spDEX v2: the community keeper window

**Status: agreed design, 2 October 2026, revised the same day after a design
review (decisions 10–33). Nothing here is built yet.** The contracts, the app
and the keeper all work as v1 until the rollout below is done. This page is the
design to build from.

For the first minutes after each buy falls due, its fee can only be paid to an
SPX holder; after that, anyone can make the buy, exactly as in v1. A new vault
pays the address it's told to pay (`rewardTo`) instead of whoever calls. During
the community window that address must pass an ownerless registry's check: it
held at least 690 SPX at the end of a recent block, proven from Ethereum's own
state, and it holds that much at the moment of the buy. There is no list, no
admin and no deposit: the SPX stays in the holder's wallet. The check at the
moment of the buy can be met with borrowed SPX, so what the registry really
proves is past holding (see "What a flash loan can and can't do").

What stays as it is: v1's factory, batcher and every vault already made run
unchanged for good, the 0.69% fee ceiling, the 0.5 ETH funding cap, the
on-chain price floor, and the rule that nobody but a vault's owner can move its
money. The registry decides only who may be paid a fee during the window; it
never touches funds.

## Why

On 2026-10-02 a mainnet smoke run's Help run vault, a single 0.0097 ETH buy
paying the full 0.69% (0.0000672 ETH), was triggered three blocks after it was
created by an outside account: one of a chain of single-use EIP-7702 accounts,
400 of them since at least 2026-09-24, run by a pseudonymous searcher that
collects public rewards across many protocols. Nothing went wrong: the vault
paid the fee it advertises to whoever triggers it. But v1 gives every buy whose
fee covers a stranger's gas to whoever is fastest, and the goal is for SPX's
community to earn those fees instead.

## Goals and non-goals

Goals:

- SPX holders who run a keeper, or Help run the network in a tab, get first
  claim on every v2 buy's fee: every slot's buy, the first one after a missed
  slot included (decision 10).
- Outside callers earn only what the community leaves: buys still unmade when
  the window closes.
- Eligibility stays in the holder's wallet: no deposit, no lock, no custody,
  no admin.
- It scales to every SPX holder (49,232 on 2026-10-02) with constant-cost
  checks and no on-chain list.
- No buy ever stalls for good: the open fallback and the owner's own trigger
  remain, and a registry that fails can delay a buy only until its window ends
  (decision 14).

Non-goals:

- Changing v1. Its vaults stay open to anyone for life; its contracts can't be
  changed. The app offers no way to move a v1 plan to v2 (decision 27).
- Turns or rotation among holders. Within the window, eligible keepers race,
  sending privately so that a lost race costs nothing. A published figure
  says when to reconsider (decision 29).
- Resisting flash borrows at buy time. The registry proves that an address
  held SPX when a block closed; nothing on chain can prove that SPX held during
  a transaction isn't borrowed (decision 17).
- Slashing or penalties. Nothing is staked, so nothing can be taken.
- Fixing the fee level in contracts. It stays an app setting under the 0.69%
  ceiling (decision 9).

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

**When a buy became due (decision 10).** v1 cuts time into slots of `interval`
seconds from `startAt`, allows one buy per slot, never makes up a missed slot,
and spaces buys at least half an interval apart. Its `_nextBuyAt` is the start
of the slot after the last buy (or half an interval after it, if later), which
is in the past once a slot has been missed: gas above the fee, a floor that
refused, a vault short of funds until a top-up. Measured from `_nextBuyAt`, the
first buy after a miss would be open to anyone at once, exactly when a bot is
waiting. So the window is measured from

```
slotStart = startAt + ((block.timestamp − startAt) / interval) × interval
dueSince  = max(_nextBuyAt, slotStart)
```

and every slot's buy gets its own first claim. Because `dueSince` is at most
half an interval into its slot and the window at most a quarter, a window
always ends inside the slot it started in.

## Contract changes

Four contracts: three are v1's with changes, one is new. All are ownerless and
immutable, deployed at fixed addresses through the deterministic deployer as v1
was. Rows marked ▲ are the significant changes.

| Contract | v1 | v2 | Why |
|---|---|---|---|
| ▲ Vault (`SpdexDcaVault`) | `execute()` pays `keeperReward` to `msg.sender`; anyone, any time the buy is due. | `execute(address rewardTo)` pays `rewardTo`, which may not be zero or the vault itself. While `block.timestamp < dueSince + communityWindow`, `rewardTo` must be the owner or pass `REGISTRY.isEligible`, called in a `try` with a fixed gas stipend: a call that reverts or runs out counts as not eligible (decision 14), and the refusal is `NotEligible(rewardTo, windowEndsAt)`. After the window, any address. `Bought` adds `rewardTo` (indexed) and `dueSince` (decision 13). `execute` returns the reward paid as well as what the owner received. A `windowBuys` counter, packed into the slot that already holds `_buysDone`, `_lastBuyAt` and `_closed`, counts buys inside the window paid to someone other than the owner; `status()` also returns `dueSince` and `windowEndsAt`. Turns, unused at launch (decision 35): a plan with `turnBuckets` holds the window's first half to the eligible addresses in the slot's bucket (`NotYourTurn`), and `status()` returns `turnEndsAt` and `turn`. `close` pays the budget as WETH if unwrapping it fails (decision 37); `ELIGIBILITY_GAS` is 100,000 (decision 38). | Who is paid becomes a stated choice the vault can check, so a caller gains nothing by calling for someone else. |
| ▲ Vault terms (clone arguments) | 112 packed bytes: owner, market, amount, fee, start, interval, buys, slippage. | 117 bytes: adds `communityWindow` (seconds, 4 bytes) and `turnBuckets` (1 byte). The registry's address is in the implementation's code, not in each clone. | Each plan's window, and whether it has turns, is fixed when it's made, like every other term. |
| Factory (`SpdexVaultFactory`) | Validates terms, clones, lists every vault. | Also requires `MIN_COMMUNITY_WINDOW ≤ communityWindow ≤ min(interval / 4, MAX_COMMUNITY_WINDOW)`, and `turnBuckets` 0 or 2 to `MAX_TURN_BUCKETS`. A new address with its own list. | A window can't swallow the open fallback or the next buy, and can't be so short that first claim is nominal (decisions 4 and 12). `MIN_INTERVAL` is 300, so every interval allows at least a 75-second window and the 5-minute plan survives. |
| ▲ Batcher (`SpdexVaultBatcher`) | Bound to its factory. Calls `execute()`, collects the WETH, forwards it to `rewardTo`, sweeps strays. | Bound to no factory (decision 34): built for WETH, it calls `execute(rewardTo)` on each address its caller lists, each vault paying `rewardTo` directly. No WETH passes through it, so the sweep and its accounting go. `earned`, and the `minRewards` held against it, is the rise in `rewardTo`'s WETH during the call, so it trusts no vault's answer. Each vault gets the gas its caller names (`gasPerVault`, at least `MIN_EXECUTE_GAS`, 400,000). | Simpler; the window check sees the real recipient, not the batcher; and one batcher serves every later release whose vaults take `rewardTo`, so none ships its own. |
| ▲ SPX holder registry (new) | — | `prove(holder, header, accountProof, storageProof)` records that `holder` held at least `MIN_SPX` at a past block. `isEligible(holder)`: a proof still valid, and `SPX.balanceOf(holder) ≥ MIN_SPX` now. | Eligibility from the wallet itself, with nothing deposited. |
| `VaultLimits` | Caps and bounds. | Adds `MIN_COMMUNITY_WINDOW` (60 seconds, five slots), `MAX_COMMUNITY_WINDOW` (1 hour) and `MAX_TURN_BUCKETS` (64). `MAX_REWARD_BPS` stays 69. | — |

**Gas.** Inside the window a buy pays for one registry read and one SPX
`balanceOf`: about 7,000–9,000 gas more, at most two cold reads, and less for
later vaults in a batch that pays the same `rewardTo`, since both accounts are
then warm. After the window there's no extra check. `windowBuys` is written in
a slot every buy already writes. The batcher's per-vault cap (400,000) keeps
ample room. `BATCHED_BUY_GAS` in the fee model (122,000 in v1) is measured
again on the fork.

**The owner's exception.** `rewardTo == owner` is always allowed, so
**Trigger now** works inside the window. A caller that pays the fee back to the
owner gains nothing, so this opens no door.

**`execute`'s one parameter (decision 11).** AGENTS.md rule 6 says never to
give `execute` a parameter, and forbids a keeper's fee routed anywhere but the
caller of `execute`; the vault's NatSpec says the caller decides only *when*.
v2 amends both, narrowly: `execute` takes exactly one argument, who receives
the caller's own fee, and nothing about the buy. The amount, the token, the
recipient of what's bought, the market and the floor stay fixed by the terms. A
forge fuzz test pins it: for any two `rewardTo` values the vault accepts, the
buy is byte-identical (the same amount out, the same owner balance, the same
slot and `buyNumber`), and only the fee's recipient differs.

## The SPX holder registry

An address is eligible when two things are true: it held at least `MIN_SPX` at
the end of a recent block, proven once from Ethereum's own state, and it holds
that much now. Nothing is deposited or locked, and nobody keeps a list: the
registry stores one timestamp per address that has proven, and nothing else.

```solidity
/// Ownerless and immutable. Proves, from Ethereum's own state, that an address held SPX.
interface ISpxHolderRegistry {
    /// `holder` held at least MIN_SPX at the end of the block `header` describes, one of
    /// the last 8,191. Anyone may submit any holder's proof: it states a fact.
    /// Reverts with NotNewer when the proof would not move `validUntil`.
    function prove(address holder, bytes calldata header, bytes[] calldata accountProof,
        bytes[] calldata storageProof) external returns (uint64 validUntil);

    /// A proof is still valid, and the holder has at least MIN_SPX right now.
    function isEligible(address holder) external view returns (bool);

    function validUntil(address holder) external view returns (uint64);

    event Proven(address indexed holder, uint256 indexed blockNumber, uint256 balance, uint64 validUntil);

    error NotNewer(uint64 validUntil);
}
```

`prove`:

1. Decodes the block header (RLP) for its number, state root and timestamp
   (fields 8, 3 and 11), and requires its hash to equal the block's real hash,
   read from the EIP-2935 history contract (`BLOCKHASH` for the last 256
   blocks).
2. Follows `accountProof` from the state root to the SPX contract's account and
   reads its storage root.
3. Follows `storageProof` from there to slot
   `keccak256(abi.encode(holder, 1))`, the holder's SPX balance.
4. Requires at least `MIN_SPX`, and sets `validUntil[holder]` to the block's
   time plus `PROOF_TTL`. If that is not later than what is stored, it reverts
   with `NotNewer` (decision 16), so a private relay drops a proof that would
   change nothing, as it drops the batcher's `NothingBought`. The app and the
   keeper read `validUntil` first anyway.

Steps 2 and 3 use a widely used Merkle-Patricia proof verifier, vendored rather
than written fresh: Optimism's MIT-licensed `SecureMerkleTrie` (with its RLP
reader) is the candidate, pinned to a named commit and kept under
`contracts/vendor/` with its licence header. It's the one complex piece of v2,
and where review starts.

**Which block is proven (decision 15).** The app and the keeper prove the
`finalized` block, about 13 minutes old: no reorg can change its hash, so a
proof never fails for that reason, and EIP-2935's 8,191 blocks (about 27 hours)
let a proof wait unsigned in a tab for hours. `BLOCKHASH` stays as the fallback
for the last 256 blocks, which is what keeps proving possible if a future hard
fork moves EIP-2935.

Parameters, fixed in the registry's code:

| Constant | Value | Basis |
|---|---|---|
| `SPX` | `0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C` | Checked 2026-10-02: a plain contract, not a proxy; 8 decimals; 1,000,000,000 supply |
| `BALANCE_SLOT` | 1 | Checked against two holders' `balanceOf` |
| History | EIP-2935, `0x0000F90827F1C53a10cb7A02335B175320002935` | Checked: live on mainnet; the last 8,191 blocks, about 27 hours |
| `MIN_SPX` | 690 SPX (`690e8`) | Agreed (decision 1), and kept in the registry rather than made a vault term: about $293 at $0.4243 on 2026-10-02 |
| `PROOF_TTL` | 30 days | Agreed (decision 2) |

**What a flash loan can and can't do (decision 17).** A proof reads a block's
final state, and a flash loan is borrowed and repaid inside one transaction, so
it never appears in one: to prove, an address must really have held `MIN_SPX`
when a block closed. The balance check at buy time is different: a flash
borrow meets it. An earlier draft of this page said that would add a loan to
every buy and cost more than a fee is worth. It doesn't. One borrow can wrap a
whole batch, and Uniswap v4's `PoolManager` lends within a transaction for no
fee (v2 and v3 flash swaps charge 0.3%, about 2 SPX for 690). At the pinned
block v4 already held SPX in two SPX/ETH pools (`docs/UNISWAP-V4.md`), and 690
SPX is only about 0.11 ETH; whether the `PoolManager` holds that much at
release is part of the measurement below. So an address can buy 690 SPX, hold it past one block's end, prove, sell it
back for about the cost of a round trip (about $2 at 2026-10-02's pools), and
then meet the balance check with borrowed SPX for 30 days, paying only gas.
What the registry really filters for is "held 690 SPX at a block's end in the
last 30 days", and the docs say exactly that. The balance check stays anyway:
it costs a few thousand gas, and it stops a holder who sold, or a bag moved
from address to address, from earning, unless they write a contract for the
purpose. A flash-borrowed batch is measured in the forge tests (rollout step
3), and the figure is published with the release.

**Cost and scale.** A proof measured at a mainnet block on 2026-10-02 is about
6 KB (the account part 3,759 bytes in 9 nodes, the balance part 2,220 bytes in
6) plus a 624-byte header of 21 fields; rebuilding that header from
`eth_getBlockByNumber` hashed to the block's real hash. Estimated cost:
250,000–300,000 gas, about 0.00003 ETH at 0.1 gwei, once every 30 days. Checks
cost the same for 10 holders or 49,232, and nothing on chain is enumerated.

**The SPX stays in a cold wallet.** Eligibility is checked on `rewardTo`, the
address paid, never on the key that signs (decision 7). A keeper's server holds
only gas money; the SPX and every fee stay in the holder's own wallet. In a
tab, Help run pays the connected wallet.

**What proving makes public (decision 24).** A `Proven` event says, forever,
that an address held at least 690 SPX. Anyone may prove any address, so the
event says nothing about whether that address keeps. A keeper's buys do,
though: each puts its cold `rewardTo` in calldata beside the hot key that sent
it, linking the two in public. The panel says so before a wallet's first proof,
and KEEPER.md suggests a wallet kept for the SPX rather than a main one.

**Why not a deposited bond.** A deposit is simpler to check and could be
slashed, but it takes custody, adds a lock and an exit delay, and breaks the
in-wallet requirement. It is the fallback only if fork tests show proofs don't
work (decision 8).

**What it doesn't stop.** A bot can buy 690 SPX and prove it, or hold it for
one block, prove and sell (above): the registry filters for addresses that held
SPX recently, not for people or for long-term holders, and inside the window
the fastest eligible keeper wins. Turns among holders would share buys out
instead of rewarding speed. They ship in the vault unused (decision 35):
address-hash turns, which need no keeper list, as a term every plan the app
creates sets to none. Whether to start creating plans with them is decided by
a published figure rather than by complaint (decision 29), and needs only an
app release.

## The fee

Decision 9 sets the app's default for new v2 vaults, an app setting rather than
a contract term (`packages/vault/src/fee.ts`):

```
buy fee = BATCHED_BUY_GAS × FEE_NETWORK_REFERENCE  +  0.25% of the buy,  at most 0.69% of the buy
```

v1's tenth on top of the network cost goes. The fee stays flat for the whole
window (decision 5), fixed in each vault when it's made. Vaults made before a
change keep their fee for good; an app release changes it for new vaults, and
only a fee above 0.69% or a different way of paying it would need new
contracts. A larger fee is also a larger prize for a bot that becomes eligible
(above); the concentration figure in `keeper:report` (decision 29) is how that
shows up.

What a buy pays at a 0.15 gwei reference and ETH at $2,667, gas included (the
keeper pays gas out of the fee). The figures use v1's 122,000 gas; the
remeasured `BATCHED_BUY_GAS` will move them slightly.

| Buy | v1 today | v2 |
|---|---|---|
| $6.90 | $0.048 (the 0.69% cap) | $0.048 (the cap) |
| $69 | $0.054 | $0.22 (0.32%) |
| $690 | $0.054 | $1.77 (0.26%) |

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

In short: wallets charge 0.67–1% plus gas and bots 0.5–1% plus gas, while
Uniswap's app and CoW Swap are nearly free for one-time swaps. On-chain
recurring-buy tools charge 0.1–0.6%, mostly 0.3% plus gas; the one service that
ran on "the keeper keeps the rest of a full fee" (Mean Finance, 0.6%) has shut
down. Almost nothing serves a $6.90 recurring buy on Ethereum: CoW's TWAP needs
$5,000 a part, Jupiter $10 a buy, and DeFi Saver skips runs when gas is high.
v2's fee sits under DeFi Saver's and Brahma's 0.3% plus gas, covers its own gas
on small buys, and leaves community keepers a margin.

## App and keeper changes

The app makes v2 vaults from the release that ships them, and keeps showing,
funding, triggering and closing v1 vaults as they are. Rows marked ▲ are new
features rather than updates.

| Area | Change |
|---|---|
| ▲ Community keeper panel (in Help run the network) | Shows whether the connected wallet is eligible, until when, and how much SPX it holds against `MIN_SPX`. **Prove my SPX** builds the proof in the browser and sends one transaction: the app reads `eth_getProof` and the `finalized` block, rebuilds the header, and refuses to send unless it hashes to the block's real hash. **Prove another address** does the same for any address (decision 22), so a hot browser wallet can pay the gas to prove a keeper's cold `rewardTo` without the cold wallet touching a browser. Before a wallet's first proof the panel says what proving publishes (decision 24). When the person's network service refuses `eth_getProof`, the panel says so, points to services that support it (in the docs), and offers a "paste a proof" box: it shows the exact requests to run against another service, then checks the pasted header's hash against the person's own service before sending. It never fetches from anywhere else (rule 4). Lapse reminders (decision 25): a banner in the panel from 5 days before a proof lapses, and the existing buy-due notification path (no icon fetch) while the app is open. |
| Recurring → Set and forget | Creates v2 vaults. One line in the plan says who may earn its fee and for how long. The default window is 30 minutes, or a quarter of the interval when that is shorter (decision 3). Expert alone can change it (decision 26): presets of 1, 5, 15, 30 and 60 minutes, any above a quarter of the interval disabled, plus the "a quarter of the interval" choice, beside one line: "Shorter: your buy happens sooner when no holder is online. Longer: holders have more time to earn your fee." |
| Help run the network | Offers v2 buys only (decision 27); v1 buys are left to keepers and outside callers. Pays the connected wallet as `rewardTo`. Buys still inside their window are offered only to an eligible wallet. An ineligible one sees "SPX holders have first claim until 14:32", its shortfall ("You hold 120 of the 690 SPX") and a plain link explaining community keeping, with no buy button (decision 23). Buys past their window are offered to anyone, as now. |
| Vault cards, Trigger now | On a v2 card, Trigger now sends `execute(owner)`, allowed at any time, and the card shows the window: "Community window until 14:32, then open to anyone." v1 cards are unchanged: no move to v2, and funding stays available (decision 27). |
| Your activity, "I bought" card | Records the caller, `rewardTo` and `dueSince` of each v2 buy, and says who made it: you, a community keeper, or anyone after the window. |
| Collective DCA, find my vaults | Read both factories' lists, which builds what AGENTS.md describes as intent: the app lists, funds and closes vaults from every listed factory and creates only on the latest. Totals cover v1 and v2 together. ▲ Collective DCA shows the share of v2 buys made by SPX holders inside their window, from each vault's `windowBuys` read with its other figures at one block, never from log searches. Display only; unknown when unreadable, never zero. |
| ▲ Guard, red-team suite | New intents: `execute(rewardTo)` and `prove(...)`. `prove` is a sixth `VaultGuard` transaction (decision 21): refused unless it goes to the release's registry, carries no ether and has a header whose hash the app matched. It is simulated like any transaction but may be signed `unverified` (checked on one service), since it moves no money and a false proof only reverts; the paths AGENTS.md lists as never signed unchecked are unchanged. Refusals: `prove` sent anywhere but the release's registry or with ether, a Help run batch whose `rewardTo` isn't the connected wallet, and a Trigger now whose `rewardTo` isn't the vault's owner. A red-team case for each, and for a proof built against the wrong block. The second-opinion structural test learns no new class. |
| ▲ Keeper (Docker image, `pnpm keeper`) | Handles v1 and v2 vaults, in separate batches per batcher. For v2 it checks `isEligible(rewardTo)`: if eligible it takes buys inside their window, if not it waits until the window closes. Inside a window it sends with the patient tip (`FEE_TIP_REFERENCE`) and never escalates just to beat another holder; in the window's last 2 minutes (the last quarter of a window under 8 minutes) it switches to v1's urgent tip, since the window's end is a deadline after which bots can take the buy (decision 19). It logs when its proof will lapse whether or not it proves. A new `SPDEX_KEEPER_PROVE=1`, off by default, proves `rewardTo` again before a proof lapses, against the `finalized` block (decision 20): `assertKeeperMaySign` gains a fifth shape, a 0-value `prove` to a listed deployment's registry whose `holder` is the configured `rewardTo`, and nothing else. The hot key pays the gas; the SPX never leaves the cold wallet. With a cold `rewardTo` the hot key earns nothing back, so the keeper logs and reports its runway (days of sends its balance covers at its recent spend), warns below a threshold (`SPDEX_KEEPER_MIN_RUNWAY_DAYS`, 7 by default), and the operator tops it up by hand (decision 18). |
| `keeper:report` | Splits buys by who made them: this keeper, other community keepers, owners, and outside callers after the window. Publishes the share of v2 window buys won by the top 1 and top 5 `rewardTo` addresses over a rolling 30 days. Top 1 above 50% for 30 days formally reopens decision 6; the developers' own keeper counts like anyone (decision 29). |
| Fee model (`fee.ts`) | The decision 9 formula above. `BATCHED_BUY_GAS` measured again with the window check. |
| Deployment record, artifacts | A `v2` entry in `deployments.json`: factory, batcher, registry and their blocks. `build:artifacts` and `check:artifacts` cover all three. |
| Mainnet smoke suite | The wallets' owner sends a holder agent 690 SPX once, outside the suite; the suite never buys SPX, and a new `wallet.ts` check refuses any SPX transfer or approval out of an agent (decision 33). The holder agent proves once. Help run passes inside the window, and an outside caller must lose to it. The 5-minute spec runs on a v2 vault (a 75-second window). Outside triggers after the window are reported, not failed. |
| Docs | ARCHITECTURE; THREAT-MODEL (flash borrows, what proving publishes, a registry bug after deploy); KEEPER (becoming a community keeper, a wallet kept for the SPX, runway and top-ups); WALKAWAY (a v2 vault's two calls, `execute(owner)` and `close`); RELEASE (three deployments); SECURITY (the credit-only bounty, decision 30). Everywhere, community keeping is described as paid work: "Community keepers make other people's buys and are paid for each one; holding 690 SPX is the entry bar." No APR or projected earnings anywhere, only past earnings after the fact (decision 23). Set and forget's "Anyone can make its due buys" becomes true only after the window, so it changes for v2; the disclaimer is checked against the code again, as every sentence is. |
| AGENTS.md | Rule 6: `execute` takes exactly one argument, who receives the caller's fee; the fee goes to the `rewardTo` the caller names (decision 11). The app trusts both factories' `isVault`, and the Layout lists the registry. Rule 2: `prove` as `VaultGuard`'s sixth transaction, which may be signed `unverified`; Help run is v2-only; the keeper's fifth signing shape. |

## How it is tested

- **Forge, on the pinned block.** The registry against real proofs recorded
  from mainnet for blocks within 8,191 of `FORK_BLOCK` (the fork's EIP-2935
  contract holds their hashes), false proofs, and fuzzing of the RLP header and
  both trie proofs. Every edge of the window to the second, with `vm.warp`:
  `dueSince` after a missed slot and after the spacing rule, the window's last
  second, the first second after it, and the 60-second and quarter-interval
  bounds. A registry that reverts or burns its stipend counts as not eligible.
  The `rewardTo` fuzz invariant (decision 11). Gas against the budgets. And a
  flash-borrowed batch through v4's `PoolManager` (decision 17), whose cost is
  published.
- **Fork integration.** Exactly one case waits in real time: a vault with a
  60-second window, and an ineligible keeper that waits it out before buying.
  No test moves the shared fork's clock (decision 32).
- **Eligibility on the fork.** If rollout step 2 finds that anvil serves
  `eth_getProof` and header hashes that match the state roots of the blocks it
  mines, and runs EIP-2935's system call, a fresh key buys SPX on the fork and
  proves a block anvil mined. If not, tests use `anvil_impersonateAccount` on a
  real mainnet SPX holder, proven with a recorded mainnet proof. Fresh keys
  still create every vault and send everything else; only the eligible address
  is borrowed. In Help run's tests that address is the connected wallet.
- **E2E** checks the copy and the in-window paths, and waits out no window.

## Risks and failure modes

Every row ends, at worst, in a delayed buy or a fee paid to the wrong person;
none reaches a vault's funds.

| Risk | What it would cost | Mitigation |
|---|---|---|
| A bug in the proof verifier accepts a false proof | Non-holders could earn window fees, as anyone earns every fee in v1. No funds at risk. | A vendored, widely used verifier; forge tests with real `eth_getProof` fixtures; fuzzing; review focused here. If it happens after deploy, the app keeps creating v2 vaults (the worst case is v1's behaviour), shows a notice on v2 cards and in the panel, and a fixed registry, vault, factory and batcher ship as v3 (decision 31). |
| The registry reverts or runs out of gas | A buy inside its window fails as if `rewardTo` weren't eligible. | The vault treats a failed check as "not eligible" (decision 14), so the buy waits at most until its window ends, or for the owner. |
| No eligible keeper is online | Buys wait until their window closes, then run as in v1. | The window is short and bounded (60 seconds to an hour, at most a quarter of the interval); the owner can always trigger. |
| No holder has proven at launch | Every v2 buy waits its whole window, then goes to whoever is fastest. | The developers' keeper runs eligible from release day like any holder (decision 28); the invitation goes out at release. |
| A holder sells after proving | Fails the current-balance check, so isn't eligible, unless they flash-borrow SPX for each batch (next row). | Proving again needs the SPX back. |
| A flash borrow meets the current-balance check | Real and cheap: one fee-free v4 borrow covers a whole batch, so holding for one block every 30 days, at about a round trip's cost, is enough to stay eligible. | None in the contracts beyond the balance check, which still stops casual sellers. Measured in forge, published, and stated plainly in the docs (decision 17). |
| One bag of SPX proven for many addresses, moved block by block | Each address gets a proof, but only the one holding the bag now passes. | The current-balance check; fees too small to make rotating a bag pay. |
| A bot simply buys `MIN_SPX` and proves it | It becomes a community keeper like any holder, and being fastest, may win most races inside the window. A larger fee (decision 9) makes that worth more. | `keeper:report` publishes how concentrated window wins are; top 1 above 50% for 30 days reopens turns (decision 29). |
| The developers' keeper wins most window buys | Holders see the developers earning most early window fees. | It counts towards decision 29's trigger like anyone else. |
| Holders bid against each other inside the window | Through private relays, competing keepers can turn the race into a tip auction that hands the margin to block builders. | The stock keeper sends with the patient tip and escalates only in the window's last minutes (decision 19). A keeper that bids higher can still win. |
| A cold-wallet keeper runs out of gas money | It stops sending; buys fall to other keepers or open after their windows. | Runway in logs and the report, and a warning below a threshold (decision 18). |
| The person's network service refuses `eth_getProof` | That person can't prove from the app. | The panel's paste-a-proof path, checked against their own service's block hash (decision 22). |
| Proving links a holder's wallet to their keeper | Their SPX holding and their hot key become publicly linked. | A warning before the first proof; KEEPER.md suggests a wallet kept for the SPX (decision 24). |
| A future hard fork removes or moves EIP-2935 | New proofs fail; existing ones last until their 30 days end; then windows lapse to open. | The `BLOCKHASH` path covers proofs of the last 256 blocks, and the app proves the `finalized` block, inside that range; a new registry is a new release. |
| A future header format adds fields | None: the registry hashes the header as given and reads only fields 3, 8 and 11, which no fork has moved. | Fork tests on a header with every current field (21 on 2026-10-02). |
| The SPX token migrates, or its storage layout differs | Proofs fail, and windows lapse to open as above. | `BALANCE_SLOT` is checked against live balances again before deployment. |
| `MIN_SPX` turns out wrong once SPX's price moves | Too high shuts out holders; too low lets bots buy in cheaply. | It's fixed in the registry: changing it means a new registry, factory and release. A per-vault term was considered and turned down. |
| More code | A larger risk surface than v1. | The 0.5 ETH per-vault cap stays, and the app labels v2 "Unaudited" as it does v1. |

## Rollout

v1 keeps running throughout; nothing here touches its contracts or vaults.

1. **The decisions are settled** (below). `MIN_SPX`, `PROOF_TTL` and the
   window bounds are fixed in code from step 3 on; changing one later means new
   contracts.
2. **Check that the fork can test it.** The gate's fork is pinned at block
   26,000,000. Check whether anvil answers `eth_getProof` with proofs that
   match the state roots of blocks it mines, and keeps EIP-2935's history for
   them. If not, forge tests take recorded mainnet proofs as fixtures, and fork
   tests impersonate a real holder (see "How it is tested").
3. **Write the contracts and their forge tests.** The registry first, with the
   vendored verifier, real proofs, false proofs and fuzzing. Then vault,
   factory and batcher v2, with the window's edges tested to the second, the
   `rewardTo` invariant, the flash-borrowed batch measured, and gas measured
   against the budgets.
4. **App, keeper and Guard**, with unit, red-team and browser tests on the
   fork; the strict gate green.
5. **Review the contracts** (decision 30). The gate is self-review, the strict
   gate and fuzzing; an outside review or audit is welcome but not required.
   A bug bounty is published in SECURITY.md, paid in credit (SECURITY.md and
   the release notes) rather than money, and v2 is labelled "Unaudited" as v1
   is.
6. **Deploy** the registry, factory v2 and batcher v2 with `deploy.sh`'s
   checks, record their blocks, and verify the source on Sourcify and
   Etherscan, as for v1 (`docs/RELEASE.md`).
7. **Release**, all at once (decision 28). A new build and CID, and the
   DNSLink moves; the app makes v2 vaults from then on, and the keeper serves
   both. The developers' keeper proves and runs eligible from this day.
8. **Invite the community.** A post on becoming a community keeper, written as
   paid work, not yield (decision 23): hold 690 SPX, prove it once a month, run
   Help run or the Docker keeper. Then a mainnet smoke run with a holder agent.

## Decisions

Decisions 1–9 were agreed on 2 October 2026; 10–33 in the design review the
same day.

| # | Decision | Agreed |
|---|---|---|
| 1 | `MIN_SPX`, the holding that makes a keeper eligible | 690 SPX, fixed in the registry: within reach of ordinary holders; a bot can carry it too |
| 2 | `PROOF_TTL`, how long a proof lasts | 30 days: about 0.00003 ETH a month per keeper, and a seller drops out at once anyway |
| 3 | The community window | Per vault, chosen by the app: 30 minutes by default, a quarter of the interval for short plans, between 60 seconds and an hour |
| 4 | Whether a v2 vault may have no window | Not allowed: every v2 vault gives holders first claim |
| 5 | The fee inside the window | Flat, as in v1: it doesn't change while the window runs |
| 6 | Turns among holders | None for now: holders race, privately. Reopened by decision 29's figure; turns need an on-chain keeper list |
| 7 | Who must hold SPX | `rewardTo`, the wallet paid, so SPX never sits on a keeper's server |
| 8 | If proofs prove too costly in testing | Keep proofs, which meet the in-wallet requirement; a deposited bond only if fork tests show a problem |
| 9 | The fee level, the app's default for new vaults (an app setting, not fixed in code) | Batched network cost plus 0.25% of the buy, at most 0.69% |
| 10 | When the window starts | At `dueSince = max(_nextBuyAt, the start of the current slot)`, so the first buy after a missed slot has a window too |
| 11 | `execute`'s parameter, against AGENTS.md rule 6 | Amend the rule: exactly one argument, who receives the caller's fee. A fuzz test pins that any two accepted `rewardTo` values give identical buys |
| 12 | The shortest window | `MIN_COMMUNITY_WINDOW` = 60 seconds, in `VaultLimits` and enforced by the factory |
| 13 | What a buy records | `Bought` adds `rewardTo` and `dueSince`; the vault counts `windowBuys` in a slot it already writes |
| 14 | A registry call that fails inside the window | Counts as not eligible, so a broken registry delays a buy only until its window ends |
| 15 | Which block is proven | `finalized`, checked through EIP-2935, with `BLOCKHASH` as the fallback |
| 16 | A proof that would change nothing | `prove` reverts with `NotNewer` |
| 17 | Flash borrows at buy time | Accepted and documented as a limit; the balance check stays; a flash-borrowed batch is measured and published |
| 18 | Keeping a cold-wallet keeper in gas | The operator tops up; the keeper reports its runway and warns below 7 days |
| 19 | The keeper's tip inside the window | Patient, never escalating against other holders; urgent only in the window's last 2 minutes (the last quarter of a window under 8 minutes) |
| 20 | The keeper proving | Opt-in (`SPDEX_KEEPER_PROVE=1`); a fifth signing shape, `prove` for the configured `rewardTo` to a listed registry, with no ether |
| 21 | `prove` and the Guard | A sixth `VaultGuard` transaction; simulated; may be signed `unverified` |
| 22 | Whom the panel proves | The connected wallet, or any address typed in; a paste-a-proof path when the service refuses `eth_getProof` |
| 23 | Ineligible wallets, and how keeping is described | Show the shortfall and a plain link, never a buy button; keeping is paid work, with no APR or projected earnings anywhere |
| 24 | What proving makes public | A warning before a wallet's first proof; KEEPER.md suggests a wallet kept for the SPX |
| 25 | Proof-lapse reminders | A banner from 5 days before, and the buy-due notification path |
| 26 | Changing the window | Expert only: presets of 1, 5, 15, 30 and 60 minutes and "a quarter of the interval", capped at a quarter of the interval |
| 27 | v1 vaults and Help run | v1 left as it is: no move to v2, funding still offered. Help run offers v2 buys only |
| 28 | Launch | Everything at once. The developers' keeper is eligible like anyone, with no special treatment or disclosure |
| 29 | When to reopen turns | When one `rewardTo` wins over 50% of v2 window buys for a rolling 30 days, the developers' keeper included |
| 30 | The review gate | Self-review, the strict gate and fuzzing, and a bug bounty paid in credit; an outside review is welcome, not required |
| 31 | A registry bug after deploy | Keep creating v2 vaults with a notice, and ship v3 |
| 32 | Testing the window's edges | In forge to the second; one real-time case on the fork; impersonate a real holder if anvil can't prove its own blocks |
| 33 | SPX for the mainnet smoke suite | The owner transfers 690 SPX to a holder agent once; the suite refuses any SPX leaving an agent |

Decisions 34–38 were agreed on 5 October 2026, before v2's deployment, to cut
how often the contracts must be deployed again: every behaviour change needs
new contracts (rule 6 allows no other way), so the changes most likely to be
wanted were moved off that path, or shipped unused.

| # | Decision | Agreed |
|---|---|---|
| 34 | The batcher | Bound to no factory: built for WETH, `earned` is the rise in `rewardTo`'s WETH, the per-vault gas is the caller's (`gasPerVault`, at least `MIN_EXECUTE_GAS`). One batcher serves every release whose vaults take `rewardTo`; a fixed batcher ships alone, and `deployments.json` lists batchers apart from releases. Amends AGENTS.md rule 6's "bound to one factory". The caller, not the batcher, checks that what it lists are vaults: the keeper takes them from listed factories' lists, and the Guard checks a batch the app sends |
| 35 | Turns among holders | In the vault now, unused: a term `turnBuckets` (0, or 2 to `MAX_TURN_BUCKETS`, 64). With turns, a window's first half goes to the eligible addresses in the slot's bucket (`keccak256(rewardTo) mod k` equal to `keccak256(vault, slot) mod k`), the rest of the window to any eligible address. The app creates every plan with none (`DEFAULT_TURN_BUCKETS`) until decision 29 trips; then an app release, not a deployment, turns them on for new plans. Revises decision 6's "none for now" |
| 36 | Releases in the app and the keeper | Data, not names: `build-artifacts` writes every source's ABIs and `SOURCES` with what each can do (`features`, read from its ABIs), and code branches on features. A release built from an existing source (another market list, another registry) is one entry in `deployments.json` |
| 37 | `close` if unwrapping fails | Pays the budget as WETH: WETH sends a withdrawal with a 2,300-gas stipend, and a fork that repriced what a clone's `receive` costs would otherwise make every `close` revert, for good |
| 38 | `ELIGIBILITY_GAS` | 100,000, about nine times an honest answer, for the same reason: a fork that repriced cold reads past 30,000 would have turned every window into one only owners can be paid in |

### Considered and not chosen

- **The registry as a per-vault term**, so a fixed or new registry would need
  no new factory. Every vault of a factory asking the one registry it was
  deployed with is what lets the factory promise that every vault it made
  gives SPX holders first claim; and once releases are data (decision 36), a
  new factory built from the same code costs a deployment and a
  `deployments.json` entry, little more.
- **An open market list**, a factory accepting any market that passes its
  checks, so a new token needs no new factory. The phase-5a reviews closed the
  open choice for good reasons ("The market list" in ARCHITECTURE.md); a new
  list is a release built from an existing source (decision 36) instead.
- **A per-vault `minSpx` term**, with the registry storing the proven balance,
  so a release could move the bar without new contracts. Decision 1 stays.
- **A lower 0.25%** to make the window a smaller prize for bots. Decision 9
  stays.
- **The batcher refunding its caller's gas** from the rewards, so a keeper with
  a cold `rewardTo` funds itself. It would put WETH back through the batcher.
- **`BLOCKHASH` only**, dropping EIP-2935: a smaller registry, but a proof
  would have to land within about 30 minutes of being built.
- **A "Move to v2" flow** for v1 vaults, and stopping v1 top-ups.
- **Help run offering v1 buys** beside v2's, in a second transaction.
- **Deploying the registry first** so holders prove before v2 vaults exist.
- **A courtesy delay, a published address or a sunset date** for the
  developers' keeper.
- **A shorter `PROOF_TTL`** to raise the prove-then-sell cost, and **making
  flash resistance a release gate**.
- **A required outside review or audit**, and a paid bounty.
