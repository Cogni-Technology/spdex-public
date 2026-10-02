# Uniswap v4: what is verified, and what is not built

Short version: v4 **quoting** is straightforward and v4 **execution** is not.
Shipping the first without the second would be worse than shipping neither,
because the router would produce routes that fail when it came time to build a
transaction. So this documents the groundwork that is done and verified, and
what the remaining work actually is.

## What is verified

All of this was checked against mainnet at the pinned fork block, not recalled:

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

So there is genuine v4 liquidity for SPX. **It is not worth much**, which was
asserted here before it was measured.

Measured at the pinned block, in ETH terms so no price feed is involved:

| Pool | Reserve (ETH side) | Share of SPX liquidity |
|---|---|---|
| v2 SPX/WETH | 2,504 WETH | ~97.6% |
| v3 SPX/WETH 0.3% | 30.3 WETH | ~1.5% |
| **v4 SPX/ETH 1%** | **≤21.3 ETH** | **≤0.83%** |
| v3 SPX/USDC 1% | — | ~0.06% |
| v4 SPX/ETH 0.3% | 0.02 ETH | negligible |

The v4 figure is an upper bound: it is the in-range *virtual* reserve derived
from liquidity and price, and a concentrated position holds less than that for
the same liquidity.

And it never wins a quote. Same trade, same block, against the pools that
actually exist:

```
0.01 ETH →  v2 52.32   v3 52.31   v4 52.28 SPX
0.1  ETH →  v2 523.17  v3 522.31  v4 520.60
1    ETH →  v2 5229.85 v3 5143.19 v4 4998.49
10   ETH →  v2 52111.9 v3 45232.9 v4 38227.2
```

A 1% fee tier over a hundred-thousand-dollar pool loses to a 0.3% tier over a
twelve-million-dollar one at every size. The router would compute a v4 leg and
discard it, so the realised benefit of building v4 execution is smaller still
than the 0.83% of liquidity suggests.

`packages/chain/test/integration/native-eth-survey.test.ts` pins this, so the
conclusion fails loudly if v4 ever becomes a serious venue for SPX — which is
the point at which it should be revisited.

**Note on measuring this yourself:** take the numbers from a *clean* fork. The
e2e suite trades WETH→SPX against v2 repeatedly, and a session's worth of that
moves v2's price by a few percent — enough to make v4 look like it wins at
small sizes, which it does not.

## Why discovery is harder than v3

v3 pools are enumerable without an indexer: the address is `CREATE2` over
`(token0, token1, fee)`, so you can ask the factory about each fee tier. v4
pools live inside a single `PoolManager` keyed by `keccak256(abi.encode(PoolKey))`,
where `PoolKey` includes a **tick spacing** and a **hooks address**. Nothing
enumerates them. You cannot ask "what pools exist for this pair" — only "does
*this exact* pool key exist".

That means a curated list of pool keys, plus a way for users to supply their
own. The curated list is a trust decision, which is why it belongs in a module
the user can replace rather than in the host.

It also means `poolId` cannot be computed inside the sandbox without keccak256,
which the module would have to ship. The workable alternative is to key pools by
their `PoolKey` fields rather than the hash, and let the host resolve.

## Why execution is the hard part

A v3 swap is one call: `exactInputSingle` with a static 7-word tuple. The module
hand-encodes it in a few lines, and a test proves those bytes match viem.

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

That is nested dynamic ABI encoding — a dynamic array of dynamic byte strings,
each containing a tuple that itself contains a dynamic member — written by hand,
in a sandbox with no ABI library. It is perfectly possible, but it is several
hundred lines of encoder whose failure mode is a transaction that encodes
*something*, and the something is wrong.

## The native-ETH prerequisite

What v4 SPX liquidity there is sits in **ETH/SPX**, using native ETH (the zero
address in a pool key) rather than WETH.

Worth separating from the numbers above, because the two arguments point
different ways. v2 and v3 have no native-ETH pools *and cannot* — both
factories are typed on two ERC-20 addresses, so every "ETH" pair in them is
WETH and the routers wrap at the edges. Scanning them for native ETH therefore
finds nothing at all.

So native-ETH support buys **no new liquidity outside v4**, and inside v4 it
buys a pool that never wins. The reason to do it anyway is that spDEX
currently cannot swap ETH *at all* — the token list is WETH/SPX/USDC and there
is no wrap button, so every user arriving with ether is stuck before they
start. That is a user-experience argument, not a routing one, and it is served
entirely by the v2 and v3 routers' existing ETH entry points. It does not need
v4. The Guard currently rejects any plan that moves
native value, because Phase 1 declined to account for ETH from simulation logs
when the emitter address was implementation-defined.

That question is now settled with evidence: `eth_simulateV1` with
`traceTransfers` reports native movement as an ordinary ERC-20 `Transfer` log
emitted by `0xeeee…eeee`, so the existing effects machinery would handle it
unchanged. `packages/chain/test/integration/constants.test.ts` pins that
behaviour, so a provider that differs fails CI rather than silently producing
swaps nobody checked.

## What would need to happen

1. Extend the Guard to account for native balances via the `0xeeee…eeee` logs,
   replacing the blanket static rejection with a real delta check. Red-team
   cases for native theft alongside the ERC-20 ones.
2. A `venue-uniswap-v4` module that carries a curated `PoolKey` list, quotes via
   `V4Quoter.quoteExactInputSingle`, and states plainly in the UI that its
   discovery is not exhaustive.
3. The UniversalRouter Actions encoder, with the same treatment v3 got: every
   encoding compared byte-for-byte against viem in a unit test, then a fork test
   that executes a real swap and asserts the received amount equals the quote.

Step 1 is useful on its own — it is what lets spDEX swap native ETH at all.
