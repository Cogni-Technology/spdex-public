# spDEX

spDEX is a web app for buying SPX on Ethereum through Uniswap pools that
already exist. You can think of it as a **dedicated router** guiding your
swaps towards the best pools out there. This project contains a small
number of **currently unaudited** smart contracts which enable auto-buy
features promoting the idea of "Set and Forget" dollar-cost averaging (DCA).
Should this project garner enough positive feedback during the current
prototype phase, we will raise for consideration getting the underlying
smart contracts audited for the community's peace of mind. See [Status](#status)
for more information.

The core of this project contains four pieces: **your signer** (the wallet
you choose), **your network service** (the RPC URL you use to connect to Ethereum),
**your storage** (your local browser storage, this project does not maintain
any servers with user data), and **your screen** (the device you use to connect
to spDEX). Everything else like which venues, liquidity providers, token lists, and
how transactions land on chain are programmed as **individual modules**. The app
ships with a default **Simple mode** which picks all the basic settings
for you. If you're a true cypherpunk and want to customize spDEX to your liking,
we have an **Expert mode** in settings that will do the trick for you.

## What you can do

- **Swap** between ETH, WETH, USDC and SPX. spDEX test-runs each swap before
  you sign and won't let you sign one whose result doesn't match what you were
  shown. If your network service can't test-run, the swap is marked unchecked.
- **Choose your pools.** See each pool's liquidity, fee and recent volume, and
  limit your swaps to the pools you pick (Expert mode).
- **Auto-buy SPX** on a schedule, in one of two ways:
  - **Confirm each buy myself.** Your wallet asks you at each buy time, so
    spDEX has to be open. This mode is for those that like to press the swap
    button themselves each day.
  - **Set and forget.** A vault, a small contract you create for one plan,
    holds the budget (prototype caps at 0.5 ETH) and buys on schedule without spDEX
    open. Only you can withdraw from it.
- **Tip** A portion of your swaps (up to 5%) to people you choose. Tips are off 
    unless you turn them on.
- **Type amounts in your currency.** Dollars or 16 others. What you sign is
  always the token amount shown next to it.
- **Keep your records.** Your swaps, tips and buys as a list, a CSV or a
  printable statement, stored only in your browser.
- **Help the community.** **Collective DCA** shows what every vault has
  bought, displaying the power of Collective DCA.
  **Help run the network** lets you make other people's due vault
  buys and earn their fees.

## Fees

- **Swaps:** On one-time swaps, spDEX charges nothing. You pay the Uniswap fee 
  and the Ethereum network fee, as with any swap.
- **Vault buys:** each buy pays a fee from the vault to whoever makes the buy.
  It is an estimate of the network cost plus 0.25% of the buy, and never more
  than 0.69%. The vault contract enforces that limit.
- **SPX holders first:** for a short time after each buy is due, the fee can
  only go to you or to an SPX holder who makes the buy. A wallet qualifies by
  proving it holds 690 SPX, once every 30 days. See `docs/KEEPER.md`,
  "Becoming a community keeper".

## Get started

1. Open **<https://www.spdex.io>**.
2. Read the disclaimer.
3. Choose a network service. We recommend your own free key from an RPC
   provider, and the first screen shows how to get one. Though you can click
   "Continue with spDEX's built-in service" on the **Connect to Ethereum**
   page to use an RPC URL courtesy of the spDEX team.
4. Connect your wallet on Ethereum.

New to this? The **Welcome** tile walks you through a first buy. To practice
with play money first, see `docs/TRY-IT.md`.

## How it keeps you safe

- **Transactions are test-run first,** on any network service that supports
  it. spDEX checks that you receive at
  least the minimum shown, spend no more than shown, and that nothing else
  leaves your wallet. A module, even one written by a stranger, can't get you
  to sign something else.
- **A second opinion, if you want one.** Add a second network service in
  Settings (Expert mode) and every test-run happens on both. If they
  disagree, you can't sign.
- **No servers and no tracking.** spDEX is a static website. It only talks to
  the network service you choose.
- **Nobody controls the contracts.** The vaults, the factory, the batcher and
  the SPX holder registry have no owner, admin key or upgrade path. Nobody,
  including spDEX's developers, can change a vault or take what is in it.
- **You can check the build.** Anyone can rebuild spDEX from source and
  compare it with the published copy. See `docs/WALKAWAY.md`, "Verify this
  build".

The details, and what spDEX does not protect against, are in
`docs/THREAT-MODEL.md`.

## Status

spDEX is a working prototype on Ethereum mainnet, using Uniswap v2 and v3
pools.

- The smart contracts are **unaudited**. That is why one vault holds at most
  0.5 ETH.
- The disclaimer has **not been reviewed by a lawyer**.
- A vault only buys when someone makes the buy. A buy time nobody makes is
  skipped.
- Your network service can see everything you do. Running your own is the
  most private option.
- A swap split across several pools is several transactions. A later one can
  fail after earlier ones went through, and the app warns you when a route is
  split.

More limits, and the reasons behind them, are in `docs/THREAT-MODEL.md`.

## Quick start

For developers. You need Node, pnpm, and for the local fork, Foundry and an
archive RPC URL (`docs/DEVELOPMENT.md`).

```bash
pnpm install
pnpm verify                 # all checks; some skip until the fork is set up (AGENTS.md)

echo 'SPDEX_FORK_RPC_URL=https://<an archive endpoint>' >> .env.local
pnpm anvil:fork             # terminal 1: a local copy of mainnet
pnpm dev:web                # terminal 2: http://localhost:5173
pnpm dev:fund 0xYourAddress # play money on the fork
```

## Docs

| Doc | What it covers |
|---|---|
| `docs/TRY-IT.md` | A walkthrough on a local fork |
| `docs/WALKAWAY.md` | Checking your copy of spDEX, and using your vaults without it |
| `docs/KEEPER.md` | Running a keeper, and becoming a community keeper |
| `docs/ARCHITECTURE.md` | How spDEX is built |
| `docs/THREAT-MODEL.md` | What spDEX protects against, and what it doesn't |
| `docs/DESIGN.md` | How the vault contracts work, decision by decision |
| `docs/WRITING-MODULES.md` | Writing a module |
| `docs/DEVELOPMENT.md` | Setup, the fork and the tests |
| `docs/RPC-RUNBOOK.md` | Network services |
| `AGENTS.md` | Rules for changing the code, and what each check proves |

## Feedback and security

- Bugs and ideas: open an issue on GitHub. spDEX records nothing about its
  users, so GitHub issues are the only way we hear what works.
- Security problems: report them privately, as `docs/SECURITY.md` explains.
  Never in a public issue.
- Changing the code: start with `CONTRIBUTING.md`.

## License

AGPL-3.0-or-later. `packages/module-sdk` is MIT, so writing a module carries
no obligations.

The fonts (Orbitron, Space Mono, Bebas Neue) are under the SIL Open Font
License 1.1, each with its `OFL.txt` in `apps/web/src/assets/fonts/`. The
SPX6900 logo in the backdrop is SPX6900's mark and is not covered by the
AGPL; `apps/web/src/assets/backdrop/README.md` says how the picture was made.
