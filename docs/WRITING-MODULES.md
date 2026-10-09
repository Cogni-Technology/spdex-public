# Writing a module

A module is how spDEX is extended: a venue, a tip list, a tracker or a
scheduler. It is plain JavaScript with a manifest, and it never touches the
signer, the network, storage, the DOM, the clock or randomness. The QuickJS
sandbox has none of them. The native runtime, which runs first-party modules
as ordinary JavaScript in the page, doesn't stop a module reaching for them,
so one that does works natively and fails in the sandbox and in the
conformance kit.

`packages/module-sdk` is MIT, so writing a module carries no obligation; the
rest of the repo is AGPL.

## The shape

```js
globalThis.spdexModule = {
  apiVersion: "1.0.0",
  async discoverPools(pair, ctx) { /* → WirePoolRef[] */ },
  async quoteBatch(requests, pools, ctx) { /* → WireVenueQuote[] */ },
  async buildCalls(quote, terms, ctx) { /* → { approvals, calls, ... } */ },
};
```

A plain script, not an ES module, because QuickJS has no module loader: the
sandbox runs the source and reads `globalThis.spdexModule`. `apiVersion` must
equal the manifest's and share the host's major version, or neither runtime
loads the module. First-party modules also ship an `index.mjs` that imports
the script and exports the object, which is what the native runtime is handed.

Read `modules/venue-uniswap-v2` first: it is the smallest complete example.
`venue-uniswap-v3` adds fee tiers and a quoter contract.

## The four rules

**1. Everything crosses as a wire type.** Amounts are decimal strings, not
bigint, and every shape is JSON-safe. That is what makes the parity gate mean
something: if the native runtime passed rich values while the sandbox
marshalled JSON, "identical output" would compare two different programs.

**2. `ctx` is all you get.** Chain reads of your declared contracts
(`ctx.call`, `ctx.multicall`, under `chain:read`) and `ctx.log` (under `log`).
No `fetch`, `window`, `localStorage` or signer. If something seems to need
more, that is a change to the capability broker, not a workaround, and the
broker is additive-only: a module written against an older API keeps loading
on a newer host.

**3. No clock, no randomness.** The sandbox removes `Date` and
`Math.random()`. Identical inputs must give byte-identical output; the
conformance kit checks it on your kind's characteristic call (for a venue,
`discoverPools`, not `buildCalls`). A module that could vary with time could
behave one way in simulation and another when signed. A module that needs the
time, as a scheduler does, is handed it.

**4. Never read an address you did not get from an allowlisted contract.** The
manifest declares every contract the module may touch, and a plan targeting
anything else is refused before it costs a network round trip. Deriving a
pool address from a factory you declared is fine; following a pointer to
somewhere you didn't declare is not.

## You do not author the promise

A venue returns approvals, calls and what it claims the user will receive. The
**host** builds the `SwapIntent` (recipient, minimum out, deadline, chain) from
what the user was shown, and attaches it. A `buildCalls` answer carrying an
`intent` key of its own is refused by name (`AuthoredIntentError`), and the
conformance kit fails it as `interface.noIntent`.

That is why a stranger's module is safe to run: the Guard simulates every plan
and checks the observed effects against the host's intent, so a module that
lies fails simulation (`docs/THREAT-MODEL.md`).

## Other kinds

### Tip lists

A **`tiplist`** implements one method:

```js
globalThis.spdexModule = {
  apiVersion: "1.0.0",
  async listRecipients() {
    return [{ address: "0x…", label: "Someone", handle: "@someone", note: "…" }];
  },
};
```

`modules/tiplist-spx-community` is the whole thing, and the example to copy
for any data-shaped module. Its manifest declares no capabilities, no
contracts and `"maxCallsPerQuote": 0`: a list is data with no reason to read
the chain, and a zero call budget is the strongest declaration available,
enforced by the broker. A list asking for `chain:read` deserves a hard look.

**Your list is not trusted.** It decides which address a name points at, as a
token list decides which contract "USDC" means. So the user sees the full
address when they pick, the *address* goes into their config, and the Guard
checks and simulates every transfer before signing. A stranger's list is safe
to install because nothing it says is believed.

### Trackers

A **`tracker`** implements `scanPools(pools, ctx)` and returns a
`WirePoolStats` per pool. `modules/tracker-pool-stats` reads reserves without
allowlisting any pool: the broker checks a call's *target*, and
`balanceOf(pool)` targets the **token**, so declaring the tokens is enough.
It must drop pools whose tokens it didn't declare *before* building its
batch, because one denied target fails the whole call. `KNOWN_TOKENS` in the
code mirrors `contracts` in the manifest, and an unreadable pool comes back
`supported: false`, never as zeroes.

Trackers are never in the path of a signature: one may be wrong in ways a
venue may not, and the host treats every figure as optional.

### Schedulers

A **`scheduler`** decides when a recurring buy is due and how large it is:

```js
globalThis.spdexModule = {
  apiVersion: "1.0.0",
  async dueBuys(request) {
    // request.now       unix seconds as a decimal string: the host's clock
    // request.plans     [{ id, sell, buy, amountPerBuy, intervalSeconds,
    //                      startAt, maxBuys }]
    // request.progress  [{ planId, buysDone, lastSlot }]
    return {
      due: [{ planId: "…", slot: 3, amountIn: "1000000000000000" }],
      next: [{ planId: "…", at: "1790003600" }], // null once a plan has finished
    };
  },
};
```

The wire types are `WireScheduleRequest` and `WireScheduleDecision`
(`packages/core/src/scheduler.ts`). A plan divides time into windows of
`intervalSeconds` from `startAt`; `slot` is the window a buy is for, counting
from 0. `due` lists the buys to make now; `next` says when each plan's next
buy could be, and is only shown (the plan's countdown), never acted on.

- **The host passes the clock.** `now` is read once per look. Answer from the
  request alone, so the host and the Guard can check your answer against the
  same inputs, and sort what you return (`modules/scheduler-dca` answers in
  plan-id order) so the order plans arrive in can't change a byte.
- **It is capability-free.** Declare what the tip list declares. The kit's
  `scheduler.noChainRead` fails a scheduler that declares `chain:read` or a
  contract, or reads the chain at all. A strategy that needs market data is a
  question of what the host puts in the request, not of a capability.
- **Your answer is a proposal.** Before quoting, the host
  (`vetScheduleDecision`) refuses a buy for a plan it didn't ask about, a
  second buy for one plan, a buy for any window but the one open now or for
  one that already had its buy, an amount that is zero or above the plan's
  `amountPerBuy`, and a buy for a plan with none left. The kit's
  `scheduler.withinPlan` runs the same vetting, so a scheduler that makes up
  missed windows or oversizes a buy fails it by name. Then, at signing,
  `ScheduledBuyGuard` checks each buy again without assuming the vetting ran:
  pair, chain, signer, delivery to the owner, one buy's worth, the budget,
  the window, a five-minute interval floor, and a simulation that must come
  back `verified`.

So a wrong or lying scheduler can make the app skip a buy or buy less, never
spend more, more often, or anywhere else. Buying less still costs: a
scheduler that proposes dust makes each buy pay a whole network fee and use
up one of the plan's buys. `modules/scheduler-dca` is the example: one buy of
the plan's fixed amount per window, only for the window open now, so a window
missed while spDEX was closed is skipped, not made up.

### Kinds without a runtime yet

`tokenlist`, `oracle` and `submitter` are admitted (`isImplementedKind`; the
reserved `panel` and `policy` are not, though a manifest naming any of the
nine kinds parses), but none has a runtime path. Adding one takes an interface
and wire schema in `packages/core`, a view in
`packages/host/src/runtimes/types.ts`, and a row in `KIND_SPECS`
(`packages/host/src/runtimes/kinds.ts`: the interface, its methods, the schema
each answer is parsed with), from which both runtimes build their view. The
conformance kit's type demands a row for every kind in that table, so no kind
becomes loadable before the kit can check it. The app then needs a list of the
shipped modules of that kind and an Engine method that loads and calls one,
as `dueBuys` has for schedulers.

## The manifest

```json
{
  "id": "venue-uniswap-v2", "version": "1.0.0", "apiVersion": "1.0.0", "kind": "venue",
  "displayName": "Uniswap v2", "description": "Routes swaps through Uniswap v2 pairs on Ethereum mainnet.",
  "capabilities": ["chain:read", "log"],
  "contracts": ["0x…factory", "0x…router"],
  "limits": { "maxFuel": "5000000", "maxMemory": "16777216", "maxCallsPerQuote": 64 },
  "sha256": "00…00", "publicKey": "0x00", "signature": "0x00"
}
```

- **`contracts`** is the allowlist the Guard's static layer checks every call
  and every approval spender against. Declare the minimum: it bounds what the
  module can do even when it is wrong.
- **Permit2 can't be declared.** A swap that calls Permit2 or approves it as a
  spender is refused (`PERMIT2_TARGET`), whatever the manifest or the user's
  trusted list says: Permit2 keeps allowances that outlive the swap, and spDEX
  gives it an unlimited permission for batched tips, so an allowance a venue
  left there could take the user's tokens later. A venue built on Permit2 (the
  Universal Router, say) needs the Guard to bound those allowances first.
- **`kind`** must be what the code implements. The kit, and the host wherever
  it checks (`assertLoadable`), refuse a module asked to load as another kind
  than its manifest declares; one missing a method of its kind fails at load,
  naming what is missing.
- **`sha256`, `publicKey` and `signature`** are produced and checked by
  nothing yet; every first-party manifest carries placeholders. A manifest is
  a declaration, not a signed one: what bounds a module is the broker and the
  Guard.

## Checking your work

Run `runConformance` from `@spdex/module-sdk` in your own unit tests. Hand it
your manifest, your source and a deterministic chain stub; it parses the
manifest, refuses a kind it can't check, loads the module in QuickJS, makes
your kind's characteristic call, requires byte-identical output from a
repeat, holds you to your call budget, and runs your kind's own checks (for a
venue a quote and a build, for a scheduler `scheduler.withinPlan` and
`scheduler.noChainRead`).

For parity, run the same source natively and in QuickJS and compare the
bytes. `modules/scheduler-dca/test/unit/scheduler.test.ts` is the shortest
example of both.

```bash
pnpm verify --only=conformance
pnpm verify --only=parity
```

These stages run the repo's own suites (the kit against fixture modules,
hostile ones and capability-escape attempts included; both runtimes against
fixtures of every kind) and don't load your module unless you add it. The kit
is meant to be the bar for the repo's own modules too, but of the five
first-party modules only the scheduler runs it yet: a known gap.
