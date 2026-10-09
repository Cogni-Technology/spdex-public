# Uniswap v4: what is verified, and what is not built

v4 **quoting** is straightforward; v4 **execution** is not. Shipping the first
without the second would be worse than shipping neither: the router would
produce routes that fail when a transaction is built. This page records what
is verified and what the remaining work is.

## What is verified

Checked against mainnet at the pinned fork block:

| Contract | Address | Status |
|---|---|---|
| PoolManager | `0x000000000004444c5dc75cb358380d2e3de08a90` | code present |
| V4Quoter | `0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203` | code present |
| StateView | `0x7ffe42c4a5deea5b0fec41c94c136cf115597227` | code present |
| UniversalRouter | `0x66a9893cc07d91d95644aedd05d03f95e1dba8af` | code present |

Live pools with real liquidity at the pinned block, found by probing
`StateView.getLiquidity(poolId)` across fee/spacing pairs:

```
ETH/SPX    fee  3000  spacing  60
ETH/SPX    fee 10000  spacing 200
ETH/USDC   fee   100  spacing   1
ETH/USDC   fee   500  spacing  10
ETH/USDC   fee  3000  spacing  60
ETH/USDC   fee 10000  spacing 200
WETH/USDC  fee   500  spacing  10
WETH/USDC  fee  3000  spacing  60
```

So v4 has real SPX liquidity, but little of it. Measured at the pinned block,
in ETH terms so no price feed is involved:

| Pool | Reserve (ETH side) | Share of SPX liquidity |
|---|---|---|
| v2 SPX/WETH | 2,504 WETH | ~97.6% |
| v3 SPX/WETH 0.3% | 30.3 WETH | ~1.5% |
| **v4 SPX/ETH 1%** | **≤21.3 ETH** | **≤0.83%** |
| v3 SPX/USDC 1% | — | ~0.06% |
| v4 SPX/ETH 0.3% | 0.02 ETH | negligible |

The v4 figure is an upper bound: the in-range *virtual* reserve derived from
liquidity and price. A concentrated position holds less for the same
liquidity.

And it never wins a quote. Same trade, same block:

```
0.01 ETH →  v2 52.32   v3 52.31   v4 52.28 SPX
0.1  ETH →  v2 523.17  v3 522.31  v4 520.60
1    ETH →  v2 5229.85 v3 5143.19 v4 4998.49
10   ETH →  v2 52111.9 v3 45232.9 v4 38227.2
```

A 1% fee tier over a hundred-thousand-dollar pool loses to a 0.3% tier over a
twelve-million-dollar one at every size. The router would compute a v4 leg and
discard it, so building v4 execution would gain less still than the 0.83% of
liquidity suggests.

`packages/chain/test/integration/native-eth-survey.test.ts` pins this, so the
conclusion fails loudly if v4 becomes a serious venue for SPX, which is when
to revisit it.

Take these numbers from a *clean* fork. The e2e suite trades WETH→SPX against
v2 repeatedly, and a session of that moves v2's price by a few percent: enough
to make v4 look like it wins at small sizes, which it does not.

## What the PoolManager lends

Every v4 pool's tokens sit in the one `PoolManager`, and it lends any token it
holds within a transaction for no fee: `unlock`, then `take`, and `sync` and
`settle` to pay it back before `unlock` returns. spDEX doesn't route through
v4, but this matters to the vaults' community window: SPX borrowed this way
meets the SPX holder registry's balance check at the moment of a buy, though
never its proof, which reads a block's final state. Measured at the pinned
block, with nothing dealt to v4 (`packages/vault/test/forge/FlashBorrow.t.sol`):

| | |
|---|---|
| SPX the `PoolManager` held | 119,766 (the registry asks for 690; `test_v4sPoolManagerHoldsEnoughSpxToLendAtThePinnedBlock`). Every v4 pool's SPX is held there; the pools found at that block are the two ETH/SPX pools above |
| v4's fee for lending 690 SPX within a transaction | 0: it ended holding exactly what it held before |
| A batch of five in-window vault buys, sent by a proven holder holding its own SPX | 831,336 gas |
| The same batch from the same holder holding none, its account delegated (EIP-7702) to a small contract that borrows 690 SPX from v4 around the batch | 873,984 gas, every buy made inside its community window and every fee paid to the holder (`test_aFlashBorrowFromV4MeetsTheBalanceCheckForAProvenHolderThatHoldsNothing`) |
| What the borrow adds | 42,648 gas a batch, about 8,500 a buy: about 0.0000064 ETH a batch at 0.15 gwei, against a fee whose network part alone is 0.0000189 ETH a buy |

The release notes publish this figure (decision 17 of `docs/DESIGN.md`).
What it lets an address do, and why the contracts don't try to stop it:
`docs/THREAT-MODEL.md`, "The community window and the SPX holder registry".

## Why discovery is harder than v3

v3 pools are enumerable without an indexer: the address is `CREATE2` over
`(token0, token1, fee)`, so you can ask the factory about each fee tier. v4
pools live inside a single `PoolManager` keyed by
`keccak256(abi.encode(PoolKey))`, where `PoolKey` includes a **tick spacing**
and a **hooks address**. Nothing enumerates them. You cannot ask "what pools
exist for this pair", only "does *this exact* pool key exist".

That means a curated list of pool keys, plus a way for users to supply their
own. The curated list is a trust decision, which is why it belongs in a module
the user can replace rather than in the host.

It also means `poolId` cannot be computed inside the sandbox without
keccak256, which the module would have to ship. The workable alternative is to
key pools by their `PoolKey` fields rather than the hash, and let the host
resolve.

## Why execution is the hard part

A v3 swap is one call: `exactInputSingle` with a static 7-word tuple. The
module hand-encodes it in a few lines, and a test proves those bytes match
viem.

A v4 swap goes through UniversalRouter as a command stream:

```
execute(commands, inputs, deadline)
  commands = 0x10                          V4_SWAP
  inputs[0] = abi.encode(actions, params)
    actions  = SWAP_EXACT_IN_SINGLE | SETTLE_ALL | TAKE_ALL
    params[0] = (PoolKey, zeroForOne, amountIn uint128, minOut uint128, hookData bytes)
    params[1] = (currency, amount)
    params[2] = (currency, amount)
```

That is nested dynamic ABI encoding (a dynamic array of dynamic byte strings,
each containing a tuple that itself contains a dynamic member) written by
hand, in a sandbox with no ABI library. It is possible, but it is several
hundred lines of encoder whose failure mode is a transaction that encodes
*something*, and the something is wrong.

## Native ETH

What v4 SPX liquidity there is sits in **ETH/SPX**, with native ETH (the zero
address in a pool key) rather than WETH. Uniswap v2 and v3 have no native-ETH
pools and cannot: both factories take two ERC-20 addresses, so every "ETH"
pair in them is WETH and the routers wrap at the edges.

spDEX already swaps native ETH, through the v2 and v3 routers' ETH entry
points, so v4 is not needed for that. `eth_simulateV1` with `traceTransfers`
reports native movement as an ordinary `Transfer` log from `0xeeee…eeee`, and
the Guard's delta accounting covers it like any token's (red-team cases in
`packages/guard/test/redteam/attacks.test.ts`, "Native ETH").
`packages/chain/test/integration/constants.test.ts` pins that behaviour, so a
provider that differs fails CI rather than producing swaps nobody checked.
Native ETH in v4 would add only a pool that never wins.

## What would need to happen

1. A `venue-uniswap-v4` module that carries a curated `PoolKey` list, quotes
   via `V4Quoter.quoteExactInputSingle`, and states plainly in the UI that its
   discovery is not exhaustive.
2. The UniversalRouter Actions encoder, held to v3's standard: every encoding
   compared byte for byte against viem in a unit test, then a fork test that
   executes a real swap and asserts the received amount equals the quote.
