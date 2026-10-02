# Contributing

spDEX is a community project, and a prototype: testing it and
saying what didn't work is as useful as code.

## Feedback

Open an issue with one of the two forms, **Something didn't work** or **An
idea** (`.github/ISSUE_TEMPLATE/`). The app records nothing about the people
who use it, so an issue is the only way we hear from you. Never paste a seed
phrase, a private key or a network service URL (those often hold an API key).

Security problems go to a private security advisory, never a public issue:
`docs/SECURITY.md`.

## Running it

- `README.md`, "Quick start": install, the gate, a local fork, the app.
- `docs/TRY-IT.md`: a walkthrough on the fork, wallet setup included.
- `docs/DEVELOPMENT.md`: Foundry, the archive endpoint the fork needs, and
  the contracts.

## Changing the code

**The gate is one command.** `pnpm verify --strict` runs every stage; read
`.verify/report.json` rather than the terminal. A skipped or empty stage is
not a pass. `AGENTS.md` says what each stage proves and which rules keep the
fork deterministic (never move the pinned block to make a test pass).

**Some rules aren't negotiable** (`AGENTS.md`, "Architectural rules"): no
telemetry, analytics or error reporting; no backend; every transaction goes
through the Guard, with no bypass; modules never touch the signer, the
network, storage or the DOM; no contract anyone controls. A change that needs
one of these to bend needs a different design.

**Modules** are how new venues, tip lists, trackers and schedulers arrive:
`docs/WRITING-MODULES.md`, and the conformance kit in `packages/module-sdk`.

**Copy is part of the product.** Short, plain sentences; say "buy" or "swap",
never "trade"; a figure spDEX doesn't know is "unknown", never 0.

## Licence

Contributions come in under the licence of the code they change:
AGPL-3.0-or-later for the repository, MIT for `packages/module-sdk`.
