# Writing a module

A module is the unit of extension in spDEX: a venue, a tip list, a tracker, a
scheduler. It is plain JavaScript, it ships with a manifest, and it must not
touch the signer, the network, storage, the DOM or the clock. In the QuickJS
sandbox it cannot. The native runtime runs first-party modules as ordinary
JavaScript in the page and does not stop one, so a module that reaches for any
of them works there and fails in the sandbox and in the conformance kit.

`packages/module-sdk` is MIT so writing one carries no obligation, even though
the rest of the repo is AGPL.

## The shape

```js
globalThis.spdexModule = {
  apiVersion: "1.0.0",
  async discoverPools(pair, ctx) { /* → WirePoolRef[] */ },
  async quoteBatch(requests, pools, ctx) { /* → WireVenueQuote[] */ },
  async buildCalls(quote, terms, ctx) { /* → { approvals, calls, ... } */ },
};
```

A plain script rather than an ES module, because QuickJS has no module loader:
the sandbox runs the source and reads `globalThis.spdexModule`. `apiVersion`
must match your manifest's and share the host's major version, or neither
runtime loads the module. The first-party modules also ship an `index.mjs` that
imports the script and exports the object, which is what the native runtime is
handed.

`modules/venue-uniswap-v2` is the smallest complete example and the one to read
first; `venue-uniswap-v3` covers fee tiers and a quoter contract.

## The four rules

**1. Everything crosses as a wire type.** Amounts are decimal strings, not
bigint. Shapes are JSON-safe throughout. This is not a concession to QuickJS —
it is what makes the parity gate mean anything. If the native runtime passed
rich values while the sandbox marshalled through JSON, the two would be running
genuinely different code and "identical output" would prove nothing.

**2. You get `ctx.multicall` and nothing else.** In the sandbox there is no
`fetch`, no `window`, no `localStorage` and no signer. Natively those globals
are all there, and a module that uses them is broken: it fails in QuickJS and in
the conformance kit. Batched reads are the entire capability surface. If
something seems to need more, that is a conversation about the broker, not a
workaround — and the broker is additive-only, so a v1 module keeps working on a
v3 host.

**3. No clock, no randomness.** The sandbox removes `Date` and `Math.random()`.
The native runtime does not, so a module that reads them appears to work on the
fast path and then fails in QuickJS, under `strictSandbox`, and in the
conformance kit. Identical inputs must produce byte-identical output; the
conformance kit asserts it for your kind's characteristic call, which for a
venue is `discoverPools`, not `buildCalls`. A module that could vary its
behaviour by time could behave one way in simulation and another when signed —
and a module that needs the time, as a scheduler does, is handed it.

**4. Never read an address you did not get from an allowlisted contract.** The
manifest declares every contract the module may touch, and a plan targeting
anything else is rejected before it costs an RPC round trip. Deriving a pool
address from a factory you declared is fine; following a pointer to somewhere
you did not is not.

## You do not author the promise

A module returns approvals, calls, and what it claims the user will receive. The
**host** builds the `SwapIntent` — recipient, minimum out, deadline, chain — from
what the user was actually shown, and attaches it. You cannot write the promise
you will be judged against: a `buildCalls` answer that carries an `intent` key
of its own is refused by name (`AuthoredIntentError`), and the conformance kit
fails it as `interface.noIntent`.

This is why a stranger's module is safe to run: whatever it claims, the Guard
simulates the plan and checks the observed effects against the host's intent. A
module that lies fails simulation. See `docs/THREAT-MODEL.md`.

## Kinds other than `venue`

A `venue` implements the three methods above. A **`tiplist`** implements one:

```js
globalThis.spdexModule = {
  apiVersion: "1.0.0",
  async listRecipients() {
    return [{ address: "0x…", label: "Someone", handle: "@someone", note: "…" }];
  },
};
```

`modules/tiplist-spx-community` is the whole thing, and it is the example to
copy for any data-shaped module. Note what it declares:

```json
"capabilities": [],
"contracts": [],
"limits": { "maxCallsPerQuote": 0 }
```

A registry is data. It has no reason to read the chain, and a zero call budget
is not a degenerate value — it is the strongest declaration available, and the
broker enforces it. A registry asking for `chain:read` would be worth a hard
look.

The host loads these through `runtime.loadRegistry()` — `loadKind("tiplist", …)`
under its older name — rather than as a venue. Kinds are not
interchangeable: asking a registry to quote fails at load with a message naming
what is missing, rather than at the first call with a `TypeError`.

A **`tracker`** implements `scanPools(pools, ctx)` and returns a
`WirePoolStats` per pool. `modules/tracker-pool-stats` is the example, and it
is worth reading for one trick: it reads pool reserves without the pool being
allowlisted, because the broker checks a call's *target* and `balanceOf(pool)`
targets the **token**. Declaring the tokens you care about is enough to read
any pool that holds them.

That shapes the module. It must filter out pools whose tokens it did not
declare *before* building its batch, because one denied target fails the whole
call and would cost every other pool its statistics — so `KNOWN_TOKENS` in the
code mirrors `contracts` in the manifest, and unreadable pools come back
`supported: false` rather than as zeroes.

Trackers are never in the path of a signature. That is why one is allowed to be
wrong in ways a venue is not, and why the host treats every figure as
optional rather than trusting it into a transaction.

A **`scheduler`** decides when a recurring buy is due and how large it is. It
implements one method:

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

The wire types are `WireScheduleRequest` and `WireScheduleDecision` in
`packages/core/src/scheduler.ts`. Amounts and times are decimal strings, as
everywhere else. A plan divides time into windows of `intervalSeconds` starting
at `startAt`, and `slot` is the window a buy is for, counting from 0. `due`
lists the buys to make now; `next` says when each plan's next buy could be, and
is only ever shown — the countdown on the plan — never acted on.

**You may not read the clock, so the host passes one.** `now` is the host's
time, read once per look. Answer from the request and nothing else: identical
requests must give identical bytes, which is also what lets the host and the
Guard check your answer against the same inputs you were given. Sort what you
return — `modules/scheduler-dca` answers in plan-id order — so the order plans
arrive in cannot change a byte.

**It is capability-free.** Declare what the tip list declares — no
capabilities, no contracts, a call budget of zero. The conformance kit's
`scheduler.noChainRead` check fails a scheduler that declares `chain:read`,
declares a contract, or reads the chain at all. A strategy that needs market
data — buying less after a run-up, say — is a conversation about what the host
puts in the request, not about a capability.

**What the host enforces whatever you answer.** Your answer is a proposal.
Before quoting anything the host refuses (`vetScheduleDecision`) a buy for a
plan it did not ask about, a second buy for one plan, a buy for any window but
the one open now or for a window that already had its buy, an amount that is
zero or larger than the plan's `amountPerBuy`, and a buy for a plan with none
left. The conformance kit's `scheduler.withinPlan` check runs the same vetting
on your answers, so a scheduler that makes up missed windows or oversizes a buy
fails it by name. Then, when each buy is signed, `ScheduledBuyGuard` checks it
again without assuming the vetting ran: pair, chain, signer, delivery to the
owner, one buy's worth, the budget, the window, a five-minute interval floor,
and a simulation that must come back `verified`. So a scheduler that is wrong,
or lies, can make the app skip a buy or buy less. It cannot make it spend more,
more often, or anywhere else. Buying less still costs: the host buys the amount
you propose as it stands, so a scheduler that proposes dust makes each buy pay
a whole network fee and use up one of the plan's buys.

`modules/scheduler-dca` is the example: one buy of the plan's fixed amount per
window, only ever for the window open now, so a window missed while spDEX was
closed is skipped rather than made up.

`tokenlist`, `oracle` and `submitter` are admitted kinds — `isImplementedKind`
accepts them, and not the reserved `panel` and `policy`, though a manifest
declaring any of the nine parses — but none has a runtime path yet. Adding one
is the pattern above: an interface and wire schema in `core`, a view in
`packages/host/src/runtimes/types.ts`, and a row in `KIND_SPECS`
(`packages/host/src/runtimes/kinds.ts`) naming the interface, its methods and
the schema each answer is parsed with. Both runtimes build their view from that
one row. The conformance kit needs a row too, and its type insists on one for
every kind in the table, so a kind cannot become loadable without the kit
learning how to check it. The app then needs a list of the shipped modules of
that kind and an Engine method that loads and calls one, as `dueBuys` does for
the scheduler.

## Your list is not trusted, and that is what makes it safe to ship

A registry decides which address a name points at, which is the same power a
token list has over which contract the word "USDC" means. So the host treats
the answer as untrusted: the user sees the full address when they pick, the
*address* is written to their config, and every resulting transfer is checked
and simulated by the Guard before signing.

This is why a stranger's registry is safe to install. Not because we vetted
it — because nothing it says is believed.

## The manifest

```json
{
  "id": "venue-uniswap-v2",
  "version": "1.0.0",
  "kind": "venue",
  "contracts": ["0x…factory", "0x…router"]
}
```

`contracts` is the allowlist the static layer checks every call and every
approval spender against. Declare the minimum: it is the bound on what your
module can do even if it is wrong.

One contract cannot be allowed by declaring it: Uniswap's Permit2. A swap
that calls Permit2, or approves it as a spender, is refused
(`PERMIT2_TARGET`), whatever the manifest or the user's trusted list says.
Permit2 keeps allowances of its own that outlive the swap, and spDEX gives
Permit2 an unlimited permission for batched tips, so an allowance a venue
left there could take the user's tokens later. A venue built on Permit2 (the
Universal Router, say) needs the Guard to learn to bound those allowances
first.

`kind` has to be what your code implements. The conformance kit, and the host
wherever it checks (`assertLoadable`), refuse a module whose manifest declares
one kind and is asked to load as another.

The schema also has `sha256`, `publicKey` and `signature` fields. Nothing
produces or checks them yet — every first-party manifest carries zeros there —
so a manifest is a declaration, not a signed one, and nothing about a module's
safety rests on those fields. What bounds a module is the broker and the Guard.

## Checking your work

`runConformance` from `@spdex/module-sdk` is the check to run on your module.
Hand it your manifest, your source and a deterministic chain stub, and it
parses the manifest, refuses a kind it cannot check, loads the module in the
QuickJS sandbox, makes your kind's characteristic call, requires byte-identical
output from a repeat, holds you to your call budget, and runs your kind's own
checks — for a venue a quote and a build, for a scheduler
`scheduler.withinPlan` and `scheduler.noChainRead`. Call it from your own unit
tests. The scheduler calls it from its own; the tip list, the tracker and the
venues do not yet, which is a gap.

For parity, do what the tip list, tracker and scheduler do: run the same source
natively and in QuickJS, and compare the bytes. The scheduler's
`test/unit/scheduler.test.ts` is the shortest example of both.

```bash
pnpm verify --only=conformance
pnpm verify --only=parity
```

These two stages run the repo's own suites: the kit against fixture modules,
hostile ones included, plus capability-escape attempts that must fail; and both
runtimes against fixtures of every kind. They pin what the kit and the runtimes
do, and they do not load your module unless you add it to them. The kit is
meant to be the bar for code that ships in the repo as much as for yours, and
it is not yet applied to all of it: of the five first-party modules, only the
scheduler runs it.
