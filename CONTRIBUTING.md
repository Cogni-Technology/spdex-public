# Contributing

spDEX is a community project and a prototype: testing it and saying what
didn't work is as useful as code.

## Feedback

Open an issue with one of the two forms, **Something didn't work** or **An
idea**. The app records nothing about the people who use it, so an issue is
the only way we hear from you. Never paste a seed phrase, a private key or a
network service URL (those often hold an API key).

Security problems go to a private security advisory, never a public issue:
`docs/SECURITY.md`.

## Running it

- `README.md`, "Quick start": install, the gate, a local fork, the app.
- `docs/TRY-IT.md`: a walkthrough on the fork, wallet setup included.
- `docs/DEVELOPMENT.md`: Foundry, the archive endpoint the fork needs, and
  the contracts.

## Changing the code

**The gate is one command.** `pnpm verify --strict` runs every stage; read
`.verify/report.json`, not the terminal. A skipped or empty stage is not a
pass. `AGENTS.md` says what each stage proves, and its "Determinism rules"
keep the fork deterministic: never move the pinned block to make a test pass.

**Some rules aren't negotiable** (`AGENTS.md`, "Architectural rules that are
not negotiable"): no telemetry, analytics or error reporting; no backend;
every transaction goes through the Guard, with no bypass; modules never touch
the signer, the network, storage or the DOM; no contract anyone controls. A
change that needs one of these to bend needs a different design.

**Deployed contracts never change.** `packages/vault/releases/v1`, the
earlier test deployment's source, is never edited, and the current source is
frozen the same way before anything under `packages/vault/contracts` changes:
a change there is a new contract release at new addresses (`AGENTS.md`, rule
6).

**Modules** are how new venues, tip lists, trackers and schedulers arrive:
`docs/WRITING-MODULES.md`, and the conformance kit in `packages/module-sdk`.

**Copy is part of the product.** Short, plain sentences; say "buy" or "swap",
never "trade"; a figure spDEX doesn't know is "unknown", never 0. Community
keeping is paid work: "Community keepers make other people's buys and are
paid for each one; holding 690 SPX is the entry bar." Never an APR, APY,
yield or projected earnings; only what was earned, after the fact.

## Licence

Contributions come in under the licence of the code they change:
AGPL-3.0-or-later for the repository, MIT for `packages/module-sdk`.
