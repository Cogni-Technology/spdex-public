# Threat model

What spDEX defends against, what it does not, and how to tell which is which,
including why a module written by a stranger can't get you to sign something
other than what you were shown.

## The assets

1. **The user's tokens.** Everything else is instrumental.
2. **The user's approvals.** An allowance outlives the session that granted it.
3. **The user's intent.** What they are about to trade, and for how much:
   worth something to a front-runner before the transaction lands, and to
   anyone building a profile after.
4. **The user's configuration.** It names their endpoint and their pools; a
   config an attacker controls is an endpoint an attacker controls.
5. **The user's standing orders.** An auto-buy plan the owner confirms spends
   on a schedule, one click per buy, on fixed terms. The terms are config;
   what it has spent is a record in this browser, which stops it spending
   twice.
6. **A vault's budget.** On chain, in neither spDEX nor the browser: at most
   0.5 ETH put in per vault, spent only by buys on the terms and buy fee fixed
   at creation, returned only to the owner. Its terms and record of buys are
   on chain too.
7. **The user's records.** This browser's record of their swaps, tips and
   buys, with addresses and transaction hashes. It leaves only in a file they
   download.
8. **A keeper operator's key and earnings.** A hot key with ether for gas, and
   buy fees paid to an address the operator chooses: their asset, not a vault
   owner's, but signed for by software spDEX ships. Someone helping run the
   network from the app is the same case without a keeper: their own wallet
   pays the network fee and receives the fees. A community keeper's paid
   address also holds the 690 SPX that makes it eligible inside a community
   window, and its proof says so in public.

## The trust boundaries

```
  user + wallet          ← signs. spDEX never holds *your* key.
  ──────────────────
  the host               ← trusted. Guard, router, broker, config, UI.
  ──────────────────
  modules                ← UNTRUSTED, first-party ones included.
  ──────────────────
  the RPC endpoint       ← semi-trusted: can lie and can watch, cannot sign.
  (and a second opinion,   With a second opinion set, a test-run the Guard
   when one is set)        relies on must be the same on both.
  ──────────────────
  the chain              ← the source of truth the Guard measures against —
                           and where a vault plan's rules are enforced.
```

The line that matters is the one under the host. **A first-party module is
faster, never more trusted.** Both runtimes reach the signer through the same
Guard, which never learns which runtime produced a plan.

spDEX never holds *your* key; a keeper holds its operator's. Nothing buys from
a key this browser generated: a config from before version 8 that names an
"autopilot" plan opens with it as a paused wallet plan.

A vault plan sits lower in the diagram, not higher. Whoever sends a buy signs
it, a stranger's keeper included, directly or through the batcher, so the
vault trusts none of them and enforces its terms on chain. The owner trusts
the vault's **unaudited** code instead, with at most 0.5 ETH per vault. The
vault asks one other contract one question, the SPX holder registry: may this
address be paid during a buy's community window? The registry never touches a
vault's money, and any failure of it counts as "no", so at worst it costs a
fee paid to someone who should have waited, or a buy that waits out its
community window.

## Adversaries, and what stops them

### A malicious module

A module is arbitrary code from anyone.

| It tries to | It is stopped by |
|---|---|
| Call a contract it never declared | `UNDECLARED_TARGET`, static |
| Grant an allowance to an undeclared spender | `APPROVAL_UNDECLARED_SPENDER`, static |
| Request an infinite approval | `APPROVAL_EXCEEDS_INTENT`, static — bounded to `maxAmountIn` |
| Approve a token that is not the one being sold | `APPROVAL_EXCEEDS_INTENT`, static |
| Send ETH alongside an ERC-20 sale | `UNEXPECTED_ETH_TRANSFER`, static |
| Rewrite the promise it will be judged against | Impossible by construction: the host authors the `SwapIntent`, not the module. `INTENT_MISMATCH` catches a substituted one |
| Send the proceeds somewhere else | `RECIPIENT_MISMATCH` — output is measured at the recipient, not in aggregate |
| Deliver less than promised | `MIN_OUT_NOT_MET`, simulated |
| Spend more of the input than agreed | `MAX_IN_EXCEEDED`, simulated |
| Drain a *different* token in the same transaction | `UNEXPECTED_TOKEN_TRANSFER`, simulated |
| Sneak an approval past the static layer | `UNEXPECTED_APPROVAL`, simulated from logs |
| Leave an allowance inside Permit2 (its own `approve`, or `permit` from a signature), which lets its holder take the token later with no signature once Permit2 holds the ERC-20 permission a batched tip asks for | `PERMIT2_TARGET`, static: no swap may call Permit2 or approve it, whoever declared or trusted it. `UNEXPECTED_APPROVAL`, simulated: Permit2's own `Approval` and `Permit` events are read as approvals, and none is ever declared |
| Emit effects the Guard cannot decode | `UNDECODABLE_EFFECTS` — unknown is refused, never waved through |
| Read the signer, the network, storage or the DOM | In the QuickJS sandbox, the capability broker: nothing else is reachable, and the conformance suite attempts the escape. The native runtime is ordinary JavaScript in the page, where all four are; it refuses source code, and the app hands it only the first-party modules it was built with |
| Behave differently under the sandbox than natively | Parity: the same source run both ways must give identical bytes or the build fails — in the `parity` stage for fixtures of every kind, and in each first-party module's own tests for its code. Those compare whole outputs for the tip list, tracker and scheduler; for the venues only pool discovery and quotes, not the calls that get signed, and only when the fork-backed `integration` stage runs |
| Use a clock or randomness to misbehave selectively | The sandbox has neither. Natively they exist, and relying on them fails in QuickJS and in the conformance kit, whose determinism check repeats each kind's characteristic call — `discoverPools` for a venue, not `buildCalls` |

The load-bearing layer is simulation. Static checks bound what a plan may
*reference*; simulation establishes what it *does*. **A module can claim
anything; it cannot make a simulated transfer appear that does not happen, nor
hide one that does.**

An allowance can also live in a contract's own books rather than the token's,
as Permit2's do, and a contract already holding your ERC-20 permission can be
armed that way by a call that moves nothing. The Guard reads Permit2's books,
since spDEX itself gives Permit2 that permission ("Batched tips"). It does not
recognise every contract with books of its own: one you gave an unlimited
permission elsewhere, and that a module declares, is a risk it cannot see.
Read a module's declared contracts.

### A malicious RPC endpoint

It can lie about state, so it can lie about a simulation.

- It **cannot** sign, and for a manual swap or an auto-buy you confirm it
  cannot cause a signature: both wait for you.
- It **can** make a good swap look bad: denial of service, which is loud.
- It **can** make a bad swap look good by faking simulation results. Within
  one endpoint there is no defence: ask one party for both the price and the
  proof, and you trust that party. A second opinion (Settings → Safety,
  optional) makes faking a test-run take two services the person chose ("A
  second opinion").
- It **supplies the nonce, fees and gas** to a keeper's key, which signs with
  nobody looking ("A keeper and its hot key").
- It **can** delay or hold auto-buys (high fees, no simulation, a price the
  oracle warns about): loud, and costing time, not money. It **cannot**
  redirect one: the host writes the owner into every buy's intent.
- It **supplies the tip** spDEX suggests to the wallet, signs a private
  transaction with, and quotes as the network fee (`readWalletFees`,
  `privateGasPrice`, `lib/fees.ts`), from its fee history. Too low, the tip is
  the floor, 0.05 gwei, and a transaction may wait; too high, the ceiling, 0.5
  gwei: at most 0.00008 ETH added to a swap of about 160,000 gas. The wallet
  shows the figure before signing, and its user can change it.
- It **can** make an amount typed in money come to a different token amount,
  since it answers the rates that size it ("A wrong price for money"). The
  token amount on screen is the check.
- It **can** tell a `#receipt=` view anything about a transaction. The view
  reads only through the viewer's own service, so it is as good as that
  service; a card's claim is never taken on its own word.

So the endpoint is disclosed, never hidden. The built-in service is never used
without asking: it is offered, last, on the first screen, only on the origins
its publisher hosts (its key is allowlisted to them), once the person has
continued past the disclaimer, which names it and says it sees their IP
address. Elsewhere, first-run asks. It shows in the status panel and Settings
→ Network service, one click from another. The privacy notice says what the
operator sees, the app never moves anyone to another operator by itself (a
failing built-in service gets a notice and a button, not a switch), and the
honest answer to "how do I close this hole" is **run your own node**.

### A second opinion

A second network service, run by someone else, that test-runs every
transaction too (config `guard.secondOpinion.url`, saved in Settings → Safety
only after it passes a test). Every Guard that simulates runs through it:
swaps, tips and the Permit2 permission, scheduled buys, the four vault
transactions, a batch of vault buys and a proof of SPX held
(`packages/guard/src/second-opinion.ts`; a red-team test fails when the
Engine builds a Guard it doesn't know).

**How the two are made comparable.** Two services asked about "the latest
block" answer about different blocks, with headers each fills in itself. So
each is asked for its latest block, then both for the header of the lower
one, and they must agree on its hash, time and gas limit. Both then test-run
the identical request on top of that block, named by its hash, with the next
block's whole header pinned (its time from the agreed header, never from the
main service alone) and an explicit gas limit per call. Compared: the
outcome, every real log in order, and each account's ether gained or lost.
Not compared: gas used and revert strings, which differ between honest
clients.

**The rule it keeps.** The second opinion is *unavailable* only when the
second service itself fails: an error, a timeout (8 s a request, 12 s for all
of one check's requests to it, which a slow main service can't use up), no
`eth_simulateV1`, no answer for a block it must have. That is the one state
that can leave something signable on one service's word ("Checked on one
service", `unverified`, `SECOND_OPINION_UNAVAILABLE`). If anything the main
service said could produce it, a lying main service would turn every
disagreement it expected into something signable.

| A service tries to | What stops it |
|---|---|
| Show a clean test-run where the second shows a theft, an extra outflow, a shortfall or a revert | `SECOND_OPINION_DISAGREES`. A disagreement comes back as a *reverted* test-run, so every path refuses it whatever `requireSimulation` says, even one that forgot the second opinion; the Guard then names it |
| Report its latest block far ahead of or behind the second's, so nothing can be compared | A service up to 3 blocks behind the other, either one, is given a moment to catch up (two re-reads, 500 ms apart). Still more than 1 block apart after that and one 2 s retry is a disagreement (reason `heads`) whichever is behind, never "unavailable": a main service reporting itself behind would be choosing an older block to be checked on |
| Report a different block at the agreed height, or a different time or gas limit for it | A disagreement (reason `block-hash`) after one retry, which absorbs a one-block reorg at the tip |
| Test-run at an early time, where a contract built to behave only before some moment looks honest | The time is the agreed header's plus 12 s, pinned on both |
| Fail its own reads, or say it can't test-run, so no comparison happens | The second service is asked anyway. The main service's unpinned test-run is compared with the second's, and any difference is a disagreement; when the main service gives no test-run at all, the second's is judged in its place. A pass is only ever "Not checked" (`SIMULATION_UNAVAILABLE`), never "Checked on one service", and is refused wherever a path never signs unchecked. The main service's word stands alone only when the second fails as well, and then because of the second's own failure |
| Be the second service and lie | A disagreement: refused, loudly. Denial of service, not theft. The refusal names the setting (Settings → Safety) and says either service could be wrong, the main one included; it never tells the person to drop the second opinion, since that is the advice a lying main service would want given |
| Be the second service and stay silent | "Checked on one service" on a one-time swap, tips or a proof of SPX held; refused where nothing is ever signed unchecked: under "refuse anything unsimulated", a Permit2 permission, a vault transaction that sends ether, a batch of vault buys, and every scheduled buy (skipped, and said so) |
| Be the same service twice, or one operator under two names | The same address (after normalising it) is not a second opinion: it is ignored, and the strip says it doesn't count. The same host, or the same last two labels of it, gets a warning that it is probably one operator; that is a heuristic, not a check |
| Switch the second opinion off from an older tab or copy | A tab running an older spDEX saves a config without it. A newer tab open at the time never adopts that save: it writes its own config back and says so. With no newer tab open, the next newer load finds the older save below the version it last saved itself (kept under a second key, `spdex.config.newest.v1`, that no older spDEX touches) and asks, "Restore my settings" (the ones it saved last) or "Keep these", rather than migrating the older save silently. A config link that removes it says so in its summary. Not defended: on a gateway that serves copies under a path, every other site there shares the browser's storage and can change settings, which an open tab takes up as if the person had; Trust and exits says so on such a copy |

With a second opinion set, typed money is sized only from rates both services
agree on: the 10-minute average and every Chainlink currency answer are read
through both, and a difference over 1% in any rate used turns money input off
("type ETH instead"). If the second service doesn't answer those reads, money
is sized from the main service alone, as a test-run is.

Not defended:

- **Anything but the test-run.** It checks nothing else the main service says:
  prices and the Guard's 10-minute price check (not cross-read; it stays a
  warning from the main service alone), balances, allowances, which contract
  sits at an address (such as Permit2's), vault state, whether an address is
  eligible as a community keeper, or fees (including the gas price a batch of
  vault buys is signed at). A proof of SPX held is built from the main
  service's header and `eth_getProof` alone; the registry checks both against
  the chain, and a false proof only reverts. A check can run one block behind
  the main service's newest, the lag two honest services commonly have, so a
  change in that block isn't seen. No test-run, on one service or two, catches
  a contract built to behave differently a few seconds later.
- **Two services that collude,** or one operator under names that don't look
  alike. The person chooses both; spDEX can only warn about the obvious case.
- **What the second service learns.** It sees every transaction before it is
  signed, as the main one does, and the checks name the account. Choose it as
  carefully as the first.
- **An honest but different second service.** A client that leaves out
  ether-transfer records, or fills in state overrides differently, would
  disagree about every swap that moves ether. The setting's test catches that
  before saving; a service that changes later refuses rather than lets
  anything through.

### A hostile configuration link

A config in a URL fragment is the cheapest attack surface in the app: it sets
the RPC endpoint and the pool policy, so a config an attacker chooses is a
swap an attacker routes.

It is **staged, never applied**: the app shows a diff against the config you
run now (not the shipped preset) and applies nothing until you accept. Above
the diff, the prompt names in words any change of these kinds: the network
service; trading limited to fewer markets; tips; auto-buys added, removed,
changed under the same id, or paused; a wider price tolerance; contracts
trusted beyond the modules' own; the safety test made optional or its price
warning widened; the way of sending; plug-ins from outside spDEX. Anything
else (the router's split settings, the deadline) is only in the diff, which
is why the diff stays open.

Any config from outside this browser arrives with every auto-buy plan paused.
The rule lives in `importConfig`, which a link and a pasted file both go
through (a pasted file is applied without staging, so a review-step rule would
miss it). A plan in a shared link can sit in the diff but not start; starting
it is the owner's deliberate act.

### A front-runner

A public broadcast puts a transaction in the mempool, where it can be traded
ahead of. `submitter.mode = "private"` has the wallet sign without
broadcasting (`eth_signTransaction`) and posts the signed transaction to a
relay. spDEX first reads the signed bytes back
(`apps/web/src/lib/signedTx.ts`) and posts nothing unless the recipient, call
data, value, chain and nonce are the ones the Guard checked, and the gas limit
and price too where those were exact: a wallet that fills in its own fees has
signed a different transaction.

What matters is the **failure** case: many wallets refuse
`eth_signTransaction`, and spDEX then stops and asks rather than broadcasting
publicly under a label that promised privacy. A protection that silently does
nothing is worse than none, because the user sizes their trade believing they
have it.

Auto-buys get no fallback at all: a wallet-mode buy that cannot be sent
privately is skipped with that reason, even right after **Confirm buy**. The
runner does not enforce this itself; it relies on the page building its
wallet sender with `onPublicFallback: () => false`, as its interface
documents.

### A tip split that pays the wrong person

A tip is a standing instruction to send a share of every swap to somebody
else, the shape of every attack on this page, and it is defended as one.

No module composes a tip. A registry module answers "which address does this
name point at", untrusted, like a token list. The user resolves it to an
address *once*, when they pick someone (or save one of their own), and the
config keeps the **address**, so a registry that later changes its mind, or is
swapped for a hostile one, cannot redirect an agreed tip. The full address is
shown beside the name at the moment of choosing, when it can still be checked.

The host builds the transfers and the Guard checks them anyway: "we wrote it"
is no exemption, and a host bug, a corrupted config or a hostile shared link
looks like malice at signing.

| It tries to | It is stopped by |
|---|---|
| Send to an address other than the one in the intent | `TIP_MALFORMED`, static — calldata is compared byte-for-byte against a fresh encoding |
| Send more than the intent says | `TIP_MALFORMED`, static |
| Transfer a token the user was not tipping | `TIP_MALFORMED`, static |
| Attach ether to a token transfer | `TIP_MALFORMED`, static |
| Take a large share via a config or UI bug | `TIP_EXCEEDS_LIMIT` — a hard 5% ceiling, a constant rather than a setting |
| Evade that ceiling by splitting across recipients | Checked on the total, not per transfer |
| Pay out of the quote when the swap underdelivered | The share is computed from the *delivered* balance, read after the swap |
| Have the token quietly not deliver | `TIP_NOT_DELIVERED`, simulated at the recipient's address |
| Move some other token in the same transaction | `UNEXPECTED_TOKEN_TRANSFER`, simulated |
| Grant an allowance while pretending to transfer | `UNEXPECTED_APPROVAL`, simulated |
| Pay the token's own contract, Permit2 or `0x…dEaD` | `TIP_MALFORMED`, static, `detail.reason` `token-contract`, `permit2`, `burn` |
| Pay a public development account (anvil's, whose keys anyone has) on a real network | `TIP_MALFORMED`, static, `public-dev-account` |
| Pay a listed token, any listed release's vault factory or implementation, a listed batcher or SPX holder registry, or a venue's contract | `TIP_MALFORMED`, static, `known-contract` (the host's `refuseRecipients`) |

The ceiling is a constant, so the worst a bug or a hostile import can do is
5% of one swap, disclosed before signing with every recipient named: an
annoyance, not a loss.

Not defended: a recipient you chose. spDEX will not stop you tipping someone
who turns out not to deserve it; the registry is not a reputation system.

#### Who can be picked: the shipped list, "My tip list", and a settings link

Three things name an address, and the host decides from the address alone. A
recipient's tag (LISTED, MINE, UNLISTED, RETIRED) comes from matching it
against the shipped list and this browser's own list, never from what a
config says about itself. One function, `tippableRecipients`, decides whom a
swap pays, and the transfers, the counts and the Tip row all take its answer.
What it skips is not sent, and its share goes to nobody else.

- **Address poisoning** (dust from an address that starts and ends like one
  you use, hoping you copy it from your history). Every address is shown in
  full, checksummed, in groups of four, wherever it is chosen or confirmed. A
  new address sharing its first or last four hex digits with a listed, saved
  or chosen one is warned about before saving; both ends matching is a danger
  banner ("Looks like Maria's address but isn't"), and an imported file can't
  bring one in at all. A mixed-case paste must be its EIP-55 checksum. Names
  are cleaned of invisible and right-to-left characters, may not look like an
  address (full-width, Cyrillic and spaced-out disguises included), and are
  compared with lookalike letters folded, so "Example Artist" in Cyrillic
  reads as the listed name it imitates, whether typed, given by a settings
  link or brought by a file (an imported entry with a listed or saved name at
  another address is left out). The first tip to an address the shipped list
  doesn't vouch for waits on the Tip row until the person checks it, with the
  lookalike and name results shown again. Until the shipped list has been
  read, the page says it hasn't compared with it rather than reporting no
  lookalike. An imported file's ENS names are dropped: nothing checked them
  against the addresses beside them.
- **ENS.** A name is read through the person's own network service only: the
  registry's resolver for that exact name, then its `addr`. spDEX follows
  neither CCIP-Read (`OffchainLookup`), which would send the name, and that
  this browser wants it, to a URL the resolver picks, nor wildcard resolution,
  which lets a parent's resolver answer for any subname. The resolved address
  is shown in full before saving and is what is kept: the name is never looked
  up again, so a name that changes hands cannot redirect a tip. The endpoint
  could lie about the answer, and no test-run catches that: a transfer to the
  wrong address runs like one to the right address. With a second opinion
  set, the name and the code at the address are read through both services,
  and a name they resolve differently is refused. Otherwise the full address,
  the lookalike check and the first-tip confirmation are the checks.
- **A malicious default in an app update** (a maintainer tricked, or the
  repository compromised). The list's tests hold every entry to a checksum, a
  unique id, ends unlike every other entry's, no public test account, and an
  https link to the person's own post of the address; a signed claim is
  checked offline against its address. None of that proves the person is who
  the list says. What limits the damage is that an update never changes a
  chosen recipient silently: an entry is retired and replaced, never edited,
  and a retired entry is skipped until the person chooses again after seeing
  why, with both addresses shown. A confirmation from before the retirement (a
  "My tip list" save, or the first load's migration stamp) doesn't count. An
  entry edited in place would show on the Tip row as a new address, since the
  config holds the address picked, not the entry's name. The tests also hold
  every id to the address it first shipped with (`shipped-ids.json`,
  append-only), and refuse a token contract, Permit2, a router or another
  known contract as an entry. Whether to trust a new app build at all is
  "Us".
- **"My tip list" is local only.** It lives in this browser's storage, not the
  config, so settings files and share links carry the addresses chosen
  (labelled "My tip list"), never your names for them. Anything else that can
  read this site's storage can read it, as can anyone with the device.
  Clearing site data loses it; export is the backup and the only way it
  leaves. A settings link bringing tip addresses lists each, in full with its
  lookalike result, before "Apply these settings", and they still wait for the
  first-tip confirmation.

#### Batched tips: a signature, and a standing permission

Two or more recipients are paid in one transaction through Uniswap's Permit2:
you sign a `PermitBatchTransferFrom` (these amounts of this token, this nonce,
this deadline, you as spender), then send `permitTransferFrom` yourself. That
adds two things a plain transfer lacks.

**The standing permission.** Permit2 moves only a token you approved it for,
so the first batched tip asks for `approve(PERMIT2, max)` on that token:
unlimited, Permit2's convention, until you revoke it (Settings → Tips →
**Revoke**, which also stops any other app using Permit2 with that token). It
is asked for only in a tip to two or more people, and never on static checks
alone: without a simulation the grant is refused and the tips go as separate
transfers, whatever `requireSimulation` says. It is asked for after the
signature, which costs nothing, needs no permission, and shows whether the
wallet can sign typed data at all, so a wallet that can't is never left
holding an unused permission. The Guard checks the permission before the
signature, so a grant it would refuse costs no signature either.

**A signature left unused.** Decline the permission and the signature just
given is never used. It moves nothing by itself, names you as the only
spender (so only a transaction you send could spend it), and expires within
20 minutes; the status says so. A permission can be left unused too, but only
after a signature: when the batch then reverts for your account, the Guard
refuses it, or you decline it; the status says so, with where to revoke.

**A signature is worth as much as a transaction.** Permit2 moves a token for
either of two things: a signature (a permit), or an allowance inside Permit2,
which a transaction of yours (`Permit2.approve`) or one signed `PermitSingle`
can set, and which lets its spender pull again and again until it expires.
spDEX's own requests are only permits whose spender is you, and its Guard
refuses any plan that would set an allowance inside Permit2 ("A malicious
module"). But while the permission stands, any valid Permit2 signature for
that token lets someone take the amounts it names: a permit with another
spender moves them anywhere with no transaction from you, and a signed
allowance keeps doing it. Every Permit2 user carries this signature-phishing
risk; spDEX cannot remove it, and checks only the requests it makes itself. A
site asking you for a Permit2 signature is asking to move your money; a
wallet that shows the spender, the token and the amounts shows the whole
promise.

**What Revoke does not do.** `approve(PERMIT2, 0)` stops Permit2 moving the
token at all, for every app, but does not erase allowances other sites set up
inside Permit2: useless while the permission is gone, they work again, if
unexpired, the next time it is given, as the next batched tip does. spDEX
does not list them.

What spDEX's own requests are held to, before the wallet is asked:

| It tries to | It is stopped by |
|---|---|
| Ask for a permit someone else can spend | `TIP_MALFORMED`: the typed data must be byte for byte what the intent builds, which names you as spender. Permit2 hashes the transaction's sender in as the spender, so a permit for you can only be spent by a transaction you send |
| Sign for another token, other amounts, another order, or an extra entry | `TIP_MALFORMED`, before the signature |
| Sign for another chain, or a verifying contract other than Permit2 | `TIP_MALFORMED`, before the signature |
| Ask for a signature that stays valid for days | `TIP_MALFORMED`: the deadline may be at most 30 minutes away (spDEX asks for 20), by this device's clock. Permit2 measures it against the chain's, so a device clock running fast, or a chain clock running behind (the local fork's is days behind), leaves it valid on chain for longer; only you can spend it either way. It is not also measured against the latest block, which on the fork would refuse every batch |
| Pay a batch to someone else, in another order, or from another owner | `TIP_MALFORMED`, static: the one call is compared byte for byte with a fresh encoding of the intent and the signed permit |
| Aim the standing permission at another spender or token | `TIP_MALFORMED`: exactly `approve(PERMIT2, max)` on the token the tip sends, or `0` to revoke |
| Ask for the permission where no batch will use it | `TIP_MALFORMED`: a grant names its tip, which must pay two or more people |
| Ask for the permission untested | `SIMULATION_UNAVAILABLE`: a grant is never signed on the static checks alone. A revoke, which only takes authority away, follows `requireSimulation` |
| Rest on a contract at Permit2's address that is not Permit2 | `TIP_MALFORMED`: its code must hash to Ethereum's Permit2, for a signature, a permission or a batch |
| Spend a signature twice | Permit2 marks each nonce used; the Guard's simulation of a replay reverts (`SIMULATION_REVERTED`) |
| Grant anything else while paying | `UNEXPECTED_APPROVAL`, simulated, including an allowance inside Permit2. One approval is let through: a token logging Permit2's ERC-20 allowance going down as it is spent (SPX does, on every transfer Permit2 makes), at or below what the Guard reads it was before; a figure above it, or one it can't compare, is a raise |

The signature does not bind who receives: Permit2 lets the spender choose
each amount's recipient when it sends. The spender is you, so the recipients
are fixed by your transaction, which the Guard checks byte for byte and
simulates, and which pays exactly the people in the intent.

Not defended: a page that is not spDEX's, or a tampered spDEX bundle, asking
your wallet for a Permit2 signature. The Guard runs in the page it guards
("Us"), and no page can vet another site's requests. The standing permission
gives such a request its value; revoking it is the remedy.

### A standing order that keeps spending

An auto-buy plan spends the user's money on a schedule, a tip's shape repeated
until it ends, and is defended the same way. This section covers the plan a
tab runs and its owner confirms buy by buy ("Confirm each buy myself"). A
vault plan ("Set and forget") has no scheduler, runner or record in this
browser; its vault enforces it on chain ("An auto-buy vault").

None of these defences lives in the screens (the Recurring tab, the cards
under "Your auto-buys"), which never sign or send anything: each sits in the
scheduler, the host, the Guard or this browser's record.

Nothing untrusted decides how much. The scheduler module is capability-free
and only proposes which plan is due, for which window and how much; the host
refuses a proposal outside the plan before quoting it (`vetScheduleDecision`).
A lying scheduler can make the app skip a buy or buy less, never spend more,
more often or elsewhere. Buying less still costs: the host buys the amount
proposed, so dust makes each buy pay a whole network fee and use up one of
the plan's buys.

The host builds the buy, and `ScheduledBuyGuard` checks it anyway, against the
plan as the config states it and this browser's record of what it has spent,
then sends every leg through the ordinary swap Guard, unchanged, which must
return `verified`. A lying scheduler, a host bug, a second tab, a retry after
a timeout, a corrupted record and a hand-edited or imported config look the
same at signing, and the Guard need not tell them apart.

The record is written first: a buy's window and the most it may spend are
claimed after a signable verdict and before the first signature, so a crash
costs a skipped buy, never a second one in that window. The claim is given
back only when spDEX can tell nothing was bought, from the transaction's hash
or, failing that, a nonce. spDEX records the hash before broadcasting whenever
it posts the signed bytes itself (a private buy); a wallet that broadcasts
reports the hash only after sending, so a claim also records the owner's next
nonce. A buy whose tab was lost before its hash arrived is settled by that
nonce: once the account has used it, the buy counts as made, whatever went
out in its place; it is given back only if the nonce is still unused after the
buy's deadline has passed on chain. The record errs toward counting a buy the
wallet replaced with something else over missing one that was made.

| It tries to | It is stopped by |
|---|---|
| Buy a token other than the plan's, or pay with one | `SCHEDULE_MISMATCH`, before simulation |
| Deliver anywhere but the owner — the owner's own cold wallet included, which a manual swap allows | `SCHEDULE_MISMATCH`, before simulation. A leg whose intent names the owner but whose calls pay someone else is refused in simulation: `RECIPIENT_MISMATCH` if the owner receives nothing, `MIN_OUT_NOT_MET` if less than the price floor arrives |
| Sign from an account other than the one this browser bound to the plan | `SCHEDULE_MISMATCH` |
| Keep spending on another chain after the endpoint changed | `SCHEDULE_MISMATCH` — a plan names its chain |
| Buy at any price at all | `SCHEDULE_MISMATCH` — every leg needs a price floor above zero |
| Run a paused plan, or one with no pause flag | `SCHEDULE_MISMATCH` — anything but an explicit `false` is paused |
| Spend more than one buy by splitting the route | `SCHEDULE_EXCEEDS_BUY` — checked on the sum of the legs, not per leg |
| Approve the whole budget once, so later buys go unchecked | `APPROVAL_EXCEEDS_INTENT`, static — each buy's approval is bounded to at most its own `maxAmountIn` |
| Spend past the budget, or buy after the last buy | `SCHEDULE_EXCEEDS_BUDGET` |
| Restart the budget by swapping or corrupting the record | `SCHEDULE_EXCEEDS_BUDGET` — a record that belongs to another plan or cannot be read counts as spent, never as zero, and a ledger that cannot be read stops every plan |
| Restart the budget by losing the record | Only partly defended. A plan with no record does not buy: it shows as not started here. Starting it again counts from zero, exactly as in a second browser, and only the owner's deliberate act stands between the two |
| Buy twice in one window — two tabs, a retry, a re-render | `SCHEDULE_NOT_DUE`, and the claim is on record before anything is signed. Two tabs are kept apart by Web Locks rather than by the record alone — one tab runs auto-buys, and every write of the record is made under a lock — because localStorage has no transactions across tabs |
| Make up missed windows in a burst | `SCHEDULE_NOT_DUE` — only the window open now; the host refuses the proposal before quoting |
| Buy every few seconds through an edited or imported interval | `SCHEDULE_NOT_DUE` — a five-minute floor, a constant checked by the Guard as well as the schema |
| Get signed unchecked when the endpoint cannot simulate | `SIMULATION_UNAVAILABLE` — refused, whatever `requireSimulation` says |
| Start spending the moment a shared link or a pasted file is applied | Every plan from outside this browser arrives paused |

The budget bounds the rest. Every plan ends, and the most it can spend,
`amountPerBuy × maxBuys`, is known before it starts. The Guard counts
everything *claimed* against it, at each buy's full `maxAmountIn`, so a buy in
flight counts before it settles, and an unreadable record counts as spent,
since one read as zero would hand the plan its whole budget again. The worst
a bug, a lying scheduler or a hostile import can do is spend the agreed
budget, one buy per window.

A person is in every buy: the wallet never opens on a timer, and a due buy
waits for **Confirm buy**, then is quoted and checked at that click. An oracle
warning makes it ask again before the wallet opens. The verdict stays
signable, because the oracle may never refuse (AGENTS.md, rule 2), and "Buy
anyway" goes ahead only if a fresh quote diverges no more than the one the
owner saw.

Not defended:

- **The price of each buy.** It is priced when it runs, by the same endpoint
  and venues as a manual swap. The Guard proves the buy receives at least its
  floor (the quote less your slippage tolerance), not that the quote was good.
  The oracle cross-check warns only for pairs Uniswap v3 has a time-weighted
  price for, through the same endpoint, so an endpoint that lies about prices
  and simulations can make every buy a poor one, up to the budget.
- **Buys while no spDEX tab is open and awake.** There is no server: a
  window that passes unseen is skipped, and the plan ends later.
- **Two browsers.** The same plan started in two has two records, and each
  can spend the whole budget.

### An auto-buy vault

A vault plan buys with no spDEX page open, triggered by whoever sends the
transaction and paid from a contract holding the plan's budget. So the
question is what anyone can make that contract do. The contracts are
`packages/vault/contracts/SpdexDcaVault.sol`, `SpdexVaultFactory.sol`,
`SpdexVaultBatcher.sol` ("The batcher") and `SpxHolderRegistry.sol` ("The
community window and the SPX holder registry"), on mainnet and unchangeable.
Their headers carry the full reasoning; this section summarises it with the
reviews' measured figures. **None of them has been audited.** The earlier
test deployment (release `v1` in `packages/vault/deployments.json`, every
vault of it finished or closed) is still served by the app, the keeper and the
report; its vaults' `execute()` takes no `rewardTo` and pays whoever calls,
with no community window.

The vault trusts nobody who calls it. Its terms (market, amount per buy,
interval, number of buys, start, buy fee, price allowance, community window)
are written into its code at creation, beside its owner, and never change.
Whoever calls `execute(rewardTo)` chooses the moment, inside a due slot (one
`interval` of the plan, at most one buy), and who is paid the buy fee; nothing
about the buy. There is no admin, upgrade, pause switch anyone else holds, or
fee but the buy fee.

On chain, whoever calls:

| It tries to | It is stopped by |
|---|---|
| Buy before the plan starts | `NotStarted` |
| Buy twice in one slot, or twice in a row across a slot's edge | `TooSoon`: one buy per slot, and none sooner than half an interval after the last |
| Make up missed slots in a burst | `TooSoon`: the next buy is counted from the last one made, so a slot nobody triggered is gone |
| Buy after the plan's last buy | `NoBuysLeft` |
| Buy when the vault holds less than one buy and its buy fee | `InsufficientBalance` |
| Buy at a poor price, through a sandwich or a pair pushed off the market | `PriceBelowFloor`: the owner must receive at least `amountPerBuy` at the pool's price (the better of its 10-minute average and its price now) less `maxSlippageBps` |
| Buy while the price reference is cheap to move | `OracleTooThin`: the pool needs at least 10 WETH of harmonic-mean depth over the ten minutes, checked at every buy |
| Send the tokens bought anywhere but the owner | Impossible by construction: the swap pays the owner written into the vault's code. `execute`'s one argument, `rewardTo`, names only who receives the buy fee: for any two `rewardTo` the vault accepts, the buy is the same byte for byte, its amount out, floor, slot and `buyNumber` included (`testFuzz_anyTwoAcceptedRewardTosMakeTheSameBuy`) |
| Deliver less than the pair sent, as a fee-on-transfer or lying token would | `DeliveredShort` |
| Call back into the vault mid-buy, from a token, the pair, an owner contract or a keeper contract | `Reentrancy`: one lock covers every function that changes state |
| Fund, close or rescue someone else's vault | `Unauthorized` |
| Put more into a plan than it can spend | Creation refuses more than the budget (`FundingExceedsNeed`). `fund` keeps only what the remaining buys and their fees need, sends the rest back, and refuses once nothing more is needed (`FullyFunded`) |
| Put more than 0.5 ETH into a plan | `FundingCapExceeded`: the budget, every buy plus its buy fee, may not exceed `MAX_FUNDING` |
| Take the budget out as WETH while the plan runs | `WethLockedUntilClosed`: `close` is the way back |
| Fund a closed vault, or buy from one | `VaultClosed` |
| Use the implementation as if it were a vault | `NotAClone` |
| Name a token, pair or pool the factory did not list | There is no parameter for one. A plan names a market by index, and an index off the list is `UnknownMarket` |
| Create a plan out of bounds: no amount, an interval under five minutes, an allowance over 5%, a buy fee over 10% of a buy, a start more than a year away | `AmountOutOfRange`, `IntervalOutOfRange`, `BuysOutOfRange`, `SlippageOutOfRange`, `RewardTooLarge`, `StartOutOfRange` |
| Raise a vault's buy fee after it was created, or charge one it did not sign | Impossible by construction: the fee is written into the clone's code, and the only payment a buy makes besides the owner's tokens is that fee, to the `rewardTo` its caller names |
| Front-run a new vault's setup | There is no setup to front-run. The creating transaction writes the terms as it deploys the clone, and there is no initializer |
| Run code of the keeper's choosing when the buy fee is paid | The fee is a WETH transfer, never a raw ether call. The vault asks the registry with `STATICCALL`, which can change nothing, before anything moves |
| Be paid inside a buy's community window while being neither the owner nor an eligible SPX holder | `NotEligible(rewardTo, windowEndsAt)`, whoever sends the call (`test_aRealHolderProvenFromItsMainnetProofIsPaidInsideTheWindow`, `test_aHolderBelowTheMinimumCanNeitherProveNorBePaidInsideTheWindow`). A caller that names an eligible address it does not control pays that address, not itself (`test_aCallerNamingAnEligibleAddressItDoesNotControlPaysThatAddress`) |
| Pay the fee to the zero address, or to the vault itself | `BadRewardTo`, inside the community window and after it (`test_rewardToMayNeverBeZeroOrTheVault`) |
| Stall buys by making the registry revert, run out of gas or answer anything but `true` | The registry is asked with a fixed stipend, `ELIGIBILITY_GAS` (100,000), and any answer but exactly `true` counts as "not eligible". The buy waits at most until its community window ends, or for the owner's **Trigger now**, which never asks the registry; a registry that burns its stipend costs a refused call at most that stipend more than a plain "no" (`test_aRegistryThatFailsCountsAsNotEligible`) |
| Open the first buy after a missed slot to anyone at once, when a bot is waiting | The community window starts at `dueSince`, the later of the earliest moment the clock allows the buy and the start of the slot it falls in, so every slot's buy gets a community window of its own (`test_afterAMissedSlotTheWindowStartsAtTheSlotsStart`, `test_afterTheSpacingRuleTheWindowStartsHalfAnIntervalAfterTheLastBuy`) |
| Create a plan whose community window is too short to mean anything, or swallows the rest of its slot | `CommunityWindowOutOfRange(communityWindow, minimum, maximum)`: at least 60 seconds (`MIN_COMMUNITY_WINDOW`), at most a quarter of the interval and never more than an hour (`MAX_COMMUNITY_WINDOW`), checked to the second (`test_theFactoryHoldsTheWindowToItsBoundsToTheSecond`). Since `dueSince` is at most half an interval into its slot, a community window always ends inside the slot it began in (`testFuzz_aWindowAlwaysEndsInsideItsSlot`) |

When the factory is deployed, listing a market:

| It tries to | It is stopped by |
|---|---|
| List an imitation pair | `PairNotFromUniswap`: it must be the pair Uniswap v2's factory lists for WETH and the token |
| List an imitation pool, or a genuine pool under a fee tier it does not have | `PoolNotFromUniswap`: it must be the pool Uniswap v3's factory lists for WETH, the token and the pool's own fee tier |
| List a pool whose history one trade can overwrite | `OracleHistoryTooShort`: it must keep at least 100 observations |
| List a pool that cannot answer a ten-minute average | `OracleUnavailable` |
| List an empty or thin pool, whose average anyone can set | `OracleTooThin`: at least 10 WETH of depth |
| List a pool that is not the same market as the pair | `MarketsDisagree`: its average must be within 2% of the pair's mid price |
| List WETH itself, the zero address, one token twice, or nothing at all, or pass an address with no code as Uniswap's factory or as the registry | `InvalidToken`, `DuplicateMarket`, `NoMarkets`, `NotAUniswapFactory`, `NotARegistry` (`test_aRegistryWithNoCodeIsRefused`) |

The owner's wallet signs four transactions around a vault, create, fund,
close and **Trigger now**, all through `VaultGuard`, for the reason tips go
through `TipGuard`. Vaults are created only on the latest release's factory; the other
three work on a vault of any listed release, each held to its release's
factory and calls. **Trigger now** is `execute(owner)`, which the community
window never refuses, so its fee comes back to the owner.

| It tries to | It is stopped by |
|---|---|
| Create at any address but the factory the app computed from its code and market list, or on an earlier release's factory | `VAULT_MALFORMED`, static |
| Create with terms other than the plan's, on a market the factory does not list, or with terms the factory would refuse | `VAULT_MALFORMED`, static, named before anyone pays gas to hear the factory say it |
| Create with a buy fee above the ceiling — a draft sized under an older rule, terms from a link, a bug | `VAULT_MALFORMED`, static, by name and figure: the fee may be at most 0.69% of the buy, the network cost included (`withinFeeCeiling`). The factory would refuse it too (`MAX_REWARD_BPS`), so no vault it vouches for pays more. Creations only: funding, closing or triggering an existing vault is never refused for its fee, which would trap its owner |
| Send more than the plan's whole budget with a creation | `VAULT_MALFORMED`, static |
| Create a second vault for a plan that already has one, or build any vault transaction for another chain | `VAULT_MALFORMED` and `CHAIN_MISMATCH`, static |
| Pass off a creation that makes some other vault: for someone else, with other terms or on another market, at another address, or announced by a look-alike contract rather than the factory | `VAULT_MALFORMED`, simulated. There must be exactly one `VaultCreated`, emitted by the factory (`vaultsCreatedBy`), not just any log shaped like one |
| Have a creation's ether not arrive in the vault as WETH | `VAULT_NOT_DELIVERED`, simulated |
| Fund, close or trigger a vault that is not its release's factory's vault for this owner on these terms | `VAULT_MALFORMED`, static. The address is recomputed from the release, owner, nonce and terms, so a lie in any of them changes it, and nothing read over the network is believed |
| Have **Trigger now** pay its buy fee to anyone but the vault's owner | `VAULT_MALFORMED`, static: the call must be exactly `execute(owner)`. Simulated, the vault's `Bought` must name the owner as `rewardTo`, and the owner must receive the fee |
| Fund or close someone else's vault | `VAULT_MALFORMED`, static |
| Fund or trigger a vault whose terms differ from the plan | `VAULT_MALFORMED`, static. Closing is allowed anyway, because it only ever returns the owner's money |
| Fund more than the remaining buys need | `VAULT_MALFORMED`, static |
| Attach ether to a close or a trigger | `VAULT_MALFORMED`, static |
| Have a close pay the account less than the vault gave up, or pay anyone else | `VAULT_NOT_DELIVERED`, simulated |
| Have a trigger deliver less than the floor read just before, pay the owner less than the buy fee, credit the fee to someone else, or make no buy or two | `VAULT_NOT_DELIVERED` or `VAULT_MALFORMED`, simulated |
| Move anything else out of the account, or grant an allowance | `UNEXPECTED_ETH_TRANSFER`, `UNEXPECTED_TOKEN_TRANSFER`, `UNEXPECTED_APPROVAL`, simulated |
| Send ether on a check that could not run | `SIMULATION_UNAVAILABLE`. A creation that funds, and a funding, are refused unless simulated, whatever `requireSimulation` says, because ether sent to an address with no code yet is lost. A close or a trigger follows the setting, so an endpoint that cannot simulate never keeps an owner from their own money |

**The floor** is everything a keeper can do to the owner's price. A hostile
keeper chooses the moment inside a due slot and can sandwich the buy: push the
pair's price to just inside the floor, let the buy land, sell back. The floor
is `maxSlippageBps` below the pool's price (the better, for the owner, of its
10-minute average and its price now), with no fee taken off, so the pair's
0.3% fee sits inside the allowance. The owner receives at least the pool's
price less the allowance. Against an honest buy, a sandwich can take the
allowance less what an honest buy pays anyway (the pair's fee, the buy's own
price impact), plus however far the pair was quoting better than the pool:
either the market moving the owner's way before the pool caught up, or
someone moving the pair.

Whether a sandwich pays is another matter: the front-run pays the pair's 0.3%
fee in and out. At the pinned block SPX's pair held about 2,500 WETH, and
sandwiching the largest buy the cap allows (0.45 ETH on a 5% allowance) left
the sandwicher about 0.29 ETH down, buy fee included, while still costing the
owner at least 3% of the buy
(`test_sandwichingTheLargestAllowedSpxBuyLosesMoney`). Break-even is a buy of
about 0.3% of the pair's WETH. So on SPX's pair the fee stops sandwiches run
for profit, not a keeper willing to lose money to cost the owner the
allowance. The app offers 1%, 2% or 3%, not 5%.

The other lever is the price reference. The oracle pool is much thinner: SPX's
0.3% pool held about 30 WETH and 254,000 SPX at the pinned block.

- **The push.** Holding the pool 16,000 ticks away across one block boundary
  (12 seconds) moves its 10-minute average about 3.25%, refusing every buy on
  a 3% allowance for ten minutes
  (`test_oneBlockOnTheOraclePoolRefusesEveryBuyForTenMinutes`). It costs about
  0.17 ETH to a searcher holding both block positions, about 18 ETH if an
  arbitrageur takes the reversal. Pushed the other way it lowers the floor,
  which pays only through a sandwich on the deep pair.
- **The price now, the cheapest lever.** Pushing the pool's price now the
  owner's way (SPX into the pool) raises the floor in the same block, with no
  boundary to hold: anyone who orders transactions around a public `execute`
  can push before it and swap back after. At the pinned block, refusing a buy
  on a 3% allowance takes about 275 ticks and 0.75 WETH through the pool, and
  about 0.0045 ETH for the round trip, the pool's fee both ways
  (`test_pushingThePoolsPriceNowRefusesABuyForItsFeesAlone`). It refuses one
  buy and moves none of the owner's money: the slot buys once the push is
  undone. The keeper simulates first, so the push must land between its
  simulation and its batch, which through a private relay only the block's
  builder can arrange. A refusal the keeper paid for rests that vault ten
  minutes, and after two in one slot it waits for the next, so a slot is lost
  only to someone paying about 0.0045 ETH a push. One push refuses every vault
  on the pool in that batch ("The batcher").

So on SPX the realistic harm from moving the price reference is skipped
slots, not lost funds. These figures are asserted, not only printed
(`Review1.t.sol`), so a change that moved them fails. Depth and history are
what make even that cost anything: a pool with fewer than 100 observations
could have its history overwritten by one trade, and one with no depth moved
for free. The factory refused both at listing, and every buy checks depth
again. `status().due` includes the depth check and every other check
`execute` makes except the price floor, so a thin pool reads "not due", never
as a trigger that can only revert; the floor is left to `quote()`, since it
changes with every trade.

Pool and pair were checked against each other once, at listing, never again:
a vault that refused to buy while they disagreed could be refused by anyone
moving the pair in the same block. While they disagree, the floor shifts by
the gap. If the pool quotes more SPX per WETH, the floor is stricter against
the pair, and a buy waits if the gap exceeds its allowance less the pair's
0.3% fee (the lever above uses this direction). If it quotes fewer, the floor
is looser and buys go ahead
(`test_r5b_buysContinueWhileThePoolAndPairDisagreeBeyondTheListingGap`).

The cap limits deposits, not holdings: anyone can send a vault WETH, and ether
or WETH sent to its address before it exists is there when it appears
(`test_r5b_aPredictedAddressCanBeFundedBeforeItExists`). `close` returns all
of it to the owner, and the Guard never assumes a vault holds 0.5 ETH or less.

**A hostile vault, to a keeper.** The vault is safe for its owner whoever
calls it; the reverse needs care, because a token's code runs inside every
buy, in a transaction the keeper pays for.
`test_aHostileVaultPassesSimulationThenBurnsTheKeepersGas` builds a vault
whose token spends a little gas in a simulation and all of it once mined. A
vault the factory made can't have such a token, since it buys only on a
listed market. So the keeper:

- triggers only vaults a listed factory's own list names, each proven that
  factory's clone before its first batch by recomputing its address from
  owner, terms and nonce: the batcher calls whatever it is given, so the
  keeper never takes an endpoint's word that an address is a vault;
- gives each vault exactly its configured gas (`SPDEX_KEEPER_GAS_PER_VAULT`,
  400,000 by default) through the batcher, whatever it asks for;
- simulates each batch at the fees it will pay, and drops vaults that refuse;
- reads what each vault did once a batch is mined. A buy that used at least
  half its cap and bought nothing traps its vault: left alone for a week of
  chain time, or until a new batcher or cap, on that evidence from chain
  only, never from a simulation. A buy refused early rests ten minutes (at
  most twice a slot), and one another transaction bought first is retried
  when next due.

**The one-time deployments.** Anyone moving the pair in the same block, so
that pool and pair disagree, can spoil the factory's deployment; each attempt
costs them the pair's fee both ways and the deployer one early revert's gas,
and resending succeeds. Where the factory is missing the app can deploy it,
and the registry first if that is missing too (the factory's constructor
refuses a registry with no code). Neither goes through the Guard: neither
moves anyone's money, and anyone may send them with the same result. The
registry has no checks to fail, so that nobody pays for it only to see the
factory refused, the app first test-runs the factory's deployment with a
state override giving the registry's address code
(`factoryRefusalBeforeRegistry`), says why it would be refused, and sends
nothing; on a service without overrides, the factory's own test-run still
precedes its transaction.

Not defended:

- **The code itself.** The contracts, the registry and its vendored proof
  verifier included, are unaudited, and a bug could lose what a vault holds.
  The 0.5 ETH cap makes that a loss a person can decide to accept. It is per
  vault, and nothing stops one account creating several. A vault cannot be
  patched: a fix is a new factory, and existing vaults keep their code until
  their owners close them.
- **Buys nobody triggers.** No keeper is promised; a slot nobody triggers is
  skipped, and the plan ends later. Held at the 0.69% ceiling, a small buy's
  fee may not cover a keeper's gas: below about 0.0027 ETH a buy it is under
  one batched buy's network cost, and below about 0.0015 ETH it doesn't cover
  a batched buy at a cheap block; the form says so (`docs/ARCHITECTURE.md`,
  "The buy fee"). Such buys depend on keepers that batch many vaults at a
  cheap block, or choose to pay the difference, and none is promised to. A
  buy also waits through its community window for an eligible keeper, then
  goes to whoever is fastest.
- **A keeper's timing, and a sandwich within the allowance,** as above, on
  every buy, from a keeper willing to lose money doing it.
- **Skipped slots.** Anyone who moves the pool's average, drains its depth or
  pushes pool and pair apart can make buys wait, and anyone ordering
  transactions around a trigger can refuse that buy for about 0.0045 ETH
  (above). Nothing is lost. A block producer can nudge a timestamp by seconds,
  which moves a buy within its slot and never adds one.
- **An endpoint that lies.** The app reads a vault's figures, and simulates
  the owner's four transactions, through the owner's endpoint, which can lie
  about both, as for a swap. The vault's rules don't depend on it: no endpoint
  can change a vault's terms, redirect a buy or move its funds. But one that
  lies about whether the factory exists could have a creation's ether sent to
  an address with no code, and lost. It can also misreport a card's community
  window or a wallet's eligibility; those are displays, and the vault and the
  registry decide on chain.
- **The token.** The factory checks markets; tokens are vetted by hand, and
  mainnet's list is SPX alone. A malicious token is out of scope ("A
  malicious token contract").

Partly defended: **forgetting the plan.** A vault buys whether or not any
browser remembers it, so one the config lost (a card deleted, settings
replaced or wiped, a new browser) must stay one spDEX can show and close. The
chain remembers it. With a wallet connected where vaults are offered, the app
asks each factory in `deployments.json` how many vaults the account created
there (`nonces(owner)`, one per creation), then reads that factory's
`VaultCreated` logs (first indexed topic: the owner), newest first, until
every one counted is accounted for (`findVaultsByOwner`). Those no plan points
at are listed under "Vaults on chain not in your plans", with **Add back to my
plans** and **Close and withdraw**.

- **Only the factory's own logs.** Any contract can emit an event with
  `VaultCreated`'s signature, and an endpoint can ignore a topic filter, so
  each log's emitter and owner are checked, and each vault found is read with
  the factory's `isVault`, as a plan's vault is.
- **The same Guard.** Closing one sends the close a plan's card sends, held by
  `VaultGuard` to the plan the vault's own terms describe (`planFromVault`):
  the vault proven the factory's and the account's by its address, the call
  byte for byte, the ether back to the account only. Adding one back writes
  that plan (paused, its vault set, its terms fixed) through `addDcaPlan`, and
  sends nothing; it first checks the address is the account's vault on
  exactly those terms (`vaultClaim`), the proof a close or a funding makes.
- **No newer vault stands in for an older one.** The count is read again at
  the block the logs are read to (read later, it would include a vault the
  logs can't show yet; earlier, miss one they do), and a vault the page
  already shows (a plan's, or one carried over from a deleted card) counts
  only once `findVaultNonce` finds the nonce below the count that puts the
  account's vault, with the terms read, at its address. Either slip would let
  the search call itself complete with a vault missing. When the plans cover
  the count, no log is read.
- **Bounded, and says so.** Hosted endpoints cap log ranges, so the search
  narrows its window on a refusal, reads nothing before block 26,000,001 (no
  factory built from this repository can be older: its code was written
  against a fork of the block before), and stops after 40 queries, about an
  hour back on an endpoint answering ten blocks at a time. The count is the
  chain's, so a search cut short says "k of your N vaults aren't shown here",
  and why. A search that failed, or read no log, is retried a few times over
  about fifteen minutes, then says it failed rather than looking like no
  vaults.

Not defended: an endpoint that lies can hide a vault, and the count with it.
It cannot pass another contract off as the owner's vault: `isVault` and the
Guard's proof by address stand between a fabricated log and any transaction.
And the search finds only the connected wallet's vaults, as far back as the
endpoint allows. So replacing the whole config (Reset, an imported file, a
shared link) keeps every vault plan whose vault may still hold money or buy,
and one pointed at another vault or none keeps the vault it has
(`keepVaultPlans`); the prompt names each. Deleting a card is the person's
choice, after a warning that the vault stays on chain and spDEX finds it again
only by searching. The vault's address is in the config (export it), and
closing needs only the owner's wallet calling `close()`, from any tool.

### The batcher

`SpdexVaultBatcher` triggers many due buys in one transaction, each vault
paying `rewardTo` directly (how: `docs/ARCHITECTURE.md`, "The batcher"). It
has no owner, fee, setter or storage but a transient lock, and no rights a
direct caller lacks: every vault still enforces its own terms. The question is
what a caller, or a vault, can make it do. **It is unaudited, like the
vault.** (The
earlier test deployment's batcher, still listed for the keeper, is bound to
its factory, skips any address that factory's `isVault` denies, and forwards
the fees it is paid, and any WETH it holds, to `rewardTo`.) Tests named below
are in `packages/vault/test/forge`.

| It tries to | It is stopped by |
|---|---|
| Re-enter the batcher from inside a vault's buy, to run a nested batch for another `rewardTo` | `Reentrancy`: a transient lock held for the whole call, its reverts included (`test_reenteringTheBatcherIsRefusedAndStealsNothing`) |
| Have it call a vault no factory made | It calls whatever its caller lists (decision 34): an address that isn't a vault runs with the gas the caller gave it and earns the caller nothing it doesn't pay (`test_aVaultNoFactoryVouchesForIsTriggeredLikeAnyOther`). Keeping such an address out of a batch is the caller's: the keeper proves each vault's address from its factory before batching it, and the Guard checks every vault of a batch the app sends |
| Burn the batch's gas through one hostile vault | Each vault gets exactly the gas its caller named, `gasPerVault`, from `MIN_EXECUTE_GAS` (400,000, what the app and the keeper send) to `MAX_EXECUTE_GAS` (`test_theGasPerVaultIsBounded`, `test_eachAttemptGetsExactlyALargerCap`). A vault is attempted only while the cap after the EVM's 1/64 and what finishing the batch costs is left (460,000 at 400,000), even when the last attempt burns its cap and the fees go to a fresh address (`test_theBatchFinishesWhenTheLastAttemptBurnsTheCap`), and when an early attempt burns it with up to 149 vaults left to mark untried (`test_aLongListWhoseFirstAttemptBurnsTheCapStillRevertsWithEveryReason`, `test_aLongListWhoseSecondAttemptBurnsTheCapStillFinishesWithItsBuy`) |
| Return-bomb it with a huge revert | Only 4 bytes of a revert are copied, and of a success 32 bytes (what the owner received); a 256 KB revert costs the batch what a 4-byte one does (`test_aHugeRevertIsNotCopied`) |
| Pass off a success without a buy's answer as a buy | `EmptyReturn`: a success answering less than two words, nothing or a single word, is not counted as bought (`test_aSuccessWithoutReturnDataIsNotBought`). A vault whose `execute` takes no argument (the earlier test deployment's) reverts empty, `EmptyRevert`, and its buy never runs (`test_aV1VaultInABatchRefusesEmpty`) |
| Buy one vault twice by listing it twice | The vault's own `TooSoon` refuses the second |
| Claim fees it never paid, so a batch meets a `minRewards` it shouldn't | `earned` is the rise in `rewardTo`'s WETH during the call, not what any vault answers: a contract that answers like a buy and claims a huge fee adds nothing (`test_earnedIsWhatRewardToReceivedNotWhatTheVaultsClaim`), and WETH `rewardTo` already held is not counted (`test_earnedIgnoresWhatRewardToAlreadyHeld`) |
| Count WETH someone sent the batcher as earned | It counts for nothing and does not move (`test_strayWethIsNeitherEarnedNorPaidOn`) |
| Leave value in the batcher between calls | No fee passes through it at all (`test_buysEveryDueVaultAndEachPaysRewardToDirectly`, `test_holdsNothingAfterABatch`). It has no `receive`, so ether sent to it reverts, and it makes no raw ether call |
| Pay the fees to itself or to nobody | `BadRewardTo` (`test_rewardToMustBeSomeoneElse`) |
| Be named, or have any contract named, as the `rewardTo` of a buy inside its community window | `NotEligible`: only accounts can be eligible, so a contract is never paid inside a community window (`test_aFeeNamedToTheBatcherByADirectCallerStaysThere`) |
| Call more vaults than a transaction can hold | `TooManyVaults` above 150 |
| Report a vault it ran out of gas for as failed | `NotTried`: not attempted, no event, retried by the keeper on its next tick, and `Batch.listed − tried` says how many |

What a public batch invites:

- **A copied batch.** Anyone watching the mempool can copy a batch and take
  its fees; the original then reverts `NothingBought`, or lands smaller.
  Private, revert-protected orderflow prevents it and costs nothing when a
  race is lost; without it the keeper warns at start. A copy must name its own
  `rewardTo` to be paid, so inside a community window only an eligible copier
  gains.
- **A race between community keepers.** Eligible keepers race for the same
  in-window buys. Sent privately, a lost race costs nothing, but competition
  can still become a tip auction that hands the margin to block builders. The
  stock keeper sends with the patient tip and never escalates against another
  holder, except in the window's last 2 minutes (the last quarter of one under
  8 minutes), when its end becomes a deadline after which anyone may take the
  buy (decision 19 of `docs/DESIGN.md`). A keeper that bids higher can still
  win.
- **A partial race.** Another keeper, or an owner's **Trigger now**, takes the
  best vaults first, leaving the batch only the ones that cost more than they
  pay. Sent privately, `minRewards` reverts it (`TooLittle`) and the relay
  drops it; sent publicly a revert costs gas anyway, so the keeper sends
  `minRewards` of 0.
- **An aggregate sandwich.** A public batch's buys on one pair add up, and a
  sandwich's take grows with the total `amountIn`. Try/catch makes it worse: a
  vault with a loose floor buys at the worst price it allows while one with a
  tight floor refuses, where an all-or-nothing batch would revert. The keeper
  caps each pair's total in one public batch at 0.1% of the pair's WETH (about
  2.5 WETH on SPX's pair at the pinned block), and private orderflow keeps the
  batch out of sight.
- **One push refuses a whole batch.** The 0.0045 ETH push on the pool's price
  now ("An auto-buy vault") refuses every vault on that pool in the batch.
  Each is retried ten minutes later, at most twice a slot; nothing moves but
  the pusher's fees.
- **Order inside a batch.** The batch's caller chooses which vault buys
  first, and a later buy pays for an earlier one's price impact. The keeper
  puts the smallest first. The floor holds for every one.

Not defended:

- **The batcher's code.** It is unaudited, but has no rights over any vault
  and holds nothing between calls, so a bug can cost a batch's fees or a
  keeper's gas, not what a vault holds. A faulty batcher is replaced at a new
  address, appended to `deployments.json`'s `batchers`.
- **WETH sent to the batcher** stays there for good, a fee a direct caller of
  a vault names it to receive after a community window included: that
  caller's own fee, lost by its own choice. A batch never pays it, and no
  sweep will be added (`docs/ARCHITECTURE.md`, "The batcher").

### Helping run the network: a batch from your own wallet

Collective DCA can offer a batch of other people's due vault buys, sent in one
transaction from the person's own wallet through the batcher, the buy fees
paid to that wallet. It is a fifth vault transaction the host composes,
checked by `VaultGuard` like the other four (`action: "batch"`); the wallet is
asked only for a batch the Guard verified, checked again when the button is
pressed. The vaults are strangers' and nothing about them is trusted: what the
batch does is what the Guard's test-run of the exact call shows. Only vaults
whose release takes `rewardTo` are offered. A buy inside its community window
is offered only to a wallet the registry finds eligible, and one inside its
turn only to a wallet in that slot's bucket.

The batcher calls whatever it is given, so nothing on chain refuses a contract
posing as a vault, and one could behave one way in a test-run and another in
the block: burn the account's gas, or move a token the account once approved
to it. So the Guard never takes a test-run as proof that an address is a
vault. The host sends a claim for each (release, owner, nonce, terms), and the
Guard recomputes each address from its release's factory, as for every vault
transaction, before anything is test-run: only that factory can have put code
there, and only that vault.

| Something tries to | What stops it |
|---|---|
| Offer a buy still inside its community window to a wallet that can't be paid for it | Offered only to a wallet the registry finds eligible, read through the person's own service at the block the buys were read, with its proof still valid a block later, where the vault asks; a standing that couldn't be read counts as not eligible. The wallet's own vaults are no exception: their cards' **Trigger now** makes those. An ineligible one is told when holders' first claim ends and how much SPX it holds against the 690, and is offered no button for those buys. A read that was wrong, or a proof that lapsed since, costs only that vault's attempt: the vault refuses `NotEligible`, the other vaults in the batch still buy, and the Guard does not refuse the batch for it |
| Have a bot copy the batch and take its fees first | Offered only with private sending, and never falls back to a public send: a batch copied from the public mempool leaves the original to fail and still pay its network fee. With public sending the panel says why it offers nothing |
| Offer a batch that costs more than it pays | Offered only when the test-run's fees reach `minRewards` = the test-run's gas × 1.1 × the gas price that is signed, read once; `minRewards` goes on chain, so a batch that would earn less reverts rather than pays less. The Guard checks it again against its own test-run of the final call: `minRewards` below that run's gas × the signed price is `VAULT_NOT_DELIVERED`, and with a second opinion the gas is the larger of the two services' figures. The gas price itself is the main service's, and nothing bounds it but that check: without a second opinion, a main service that understates the gas and overstates the price together can still make a batch cost more than it earns, as it can fake any test-run |
| List a contract that isn't a vault, a real vault claimed with another owner, nonce or terms, or a vault whose `execute` takes no `rewardTo` (the earlier test deployment's) | Static, before any test-run: one claim per listed address, in order, each address where its release's factory puts that owner's vault at that nonce on those terms, of a listed release whose vaults take `rewardTo` (`VAULT_MALFORMED`) |
| Send it to a look-alike batcher, or pay the fees to someone else | Static checks: exactly one call, to the newest batcher, computed from its source and WETH's address (never read from anywhere), with `value` 0, calldata byte-equal to a fresh encoding of the vault list at the gas per vault the host sends (so any other `executeBatch` shape, or another gas, is refused), `rewardTo` the account and `minRewards` at least 1 (`VAULT_MALFORMED`) |
| Sign at another gas limit or price than the one checked | The call's gas and price must equal the intent's, and the gas limit must lie between what the vaults need and 16,000,000; the wallet signs exactly that limit, with no estimate taken |
| Pass on WETH that isn't the batch's fees | Refused, simulated: the batcher holds and passes on nothing, so WETH or any other token leaving it in the test-run is money spDEX can't account for, and spDEX won't make you its receiver (`VAULT_BATCH_UNACCOUNTED`); anything paid to it is `VAULT_MALFORMED` |
| Take anything from the account, or have it grant a permission | `UNEXPECTED_*`: nothing leaves the account and no allowance is granted; its WETH must rise by at least the `Batch` event's `earned` |
| Misreport what the vaults did | Exactly one `Batch`, from the batcher, naming the account as caller and `rewardTo`, its `earned` (the rise in the account's WETH) equal to the fees its buys paid; every listed vault reports `Triggered` or `NotTriggered`, none `EmptyReturn` (no code where a vault was claimed) or left untried; each `Triggered` follows that vault's own `Bought`, laid out as its claimed release's, with the batcher as its keeper and the account as its `rewardTo`, its floor kept, and the vault losing exactly the buy and its fee |
| Fake the test-run | Never signed unverified: an unavailable test-run refuses it whatever `requireSimulation` says, and so does a second opinion that doesn't answer, or disagrees |

What it costs, said before the button is pressed: the network fee (the most
the wallet can show is gas limit × price, since each vault gets room to run);
the person's address made public as the one who made the buys; and, since
checking which buys are due test-runs a batch from their address on their own
service, the panel asks nothing about their address until they press it. A
wallet that can't sign without broadcasting (`eth_signTransaction`) can't
help, and is told so before anything is sent.

Not defended:

- **Losing the race.** Someone may make the same buys first. The batch then
  buys nothing: a relay that includes failing transactions charges its network
  fee (the panel says which kind it is), one that doesn't charges nothing.
- **The relay.** A private relay sees the batch before it lands, as it sees a
  private swap; spDEX trusts the one the person chose.
- **The vaults' own buys.** Each vault's floor bounds its price, as for any
  keeper ("An auto-buy vault"); the helper chooses only when.

### The community window and the SPX holder registry

A vault gives SPX holders first claim on each buy. For `communityWindow`
seconds after a buy falls due (30 minutes by default, a quarter of the
interval for short plans, never under 60 seconds or over an hour), its fee can
go only to the vault's owner or an address the SPX holder registry finds
eligible; after that, to anyone. Community keepers make other people's buys
and are paid for each one; holding 690 SPX is the entry bar.

The registry (`packages/vault/contracts/SpxHolderRegistry.sol`) answers that
one question. It has no owner, admin, setter, list or deposit, takes no
ether, and stores one timestamp per address that has proven; its code has one
storage write and no call but two read-only ones
(`test_theRegistryCanWriteOnlyValidUntilAndCallOnlyToRead`). It never touches
a vault's money, so every case below ends, at worst, in a fee paid to someone
the window was meant to keep out (as any fee after the window may be), or a
buy that waits out its window. **It is unaudited, like the vault.**

**What it proves.** An address is eligible while:

1. it held at least 690 SPX (`MIN_SPX`) at the end of a block at most 30 days
   old (`PROOF_TTL`), through the 30th day's last second
   (`test_aProofIsValidThroughItsLastSecondAndNotOneMore`), proven once with
   `prove`;
2. it holds at least 690 SPX at the moment of the buy;
3. it is an account, not a contract: no code, or only the 23-byte EIP-7702
   delegation designator, which only the account's own key can put there.
   This is checked at the buy too, since code can arrive after a proof.

`prove(holder, header, accountProof, storageProof)` hashes the header exactly
as given and requires the block's real hash, read from the chain itself, so
once it matches every header byte is the chain's; two Merkle-Patricia proofs
then lead from its state root to the holder's balance (step by step:
`docs/ARCHITECTURE.md`, "The SPX holder registry"). Anyone may send anyone's
proof, since it states a fact: `msg.sender` appears nowhere in `prove`.

| It tries to | It is stopped by |
|---|---|
| Prove an address that never held 690 SPX, or holds none | The verifier returns a value only for a key that is in the trie, and refuses a proof of absence (`test_aHolderWithNoSpxCannotProve`). A true proof of less is `BelowMinimum(balance, minimum)` (`test_aTrueProofBelowTheMinimumIsBelowMinimumWithTheFigures`) |
| Prove with a made-up header, one carrying another block's state root, or one that lies about its number | `WrongBlockHash(given, actual)`: the real hash is read from the chain, never taken from the caller (`test_aTamperedHeaderIsWrongBlockHash`, `test_aHeaderCarryingAnotherStateRootIsWrongBlockHash`, `test_aHeaderThatLiesAboutItsNumberIsWrongBlockHash`) |
| Prove the current block, a future one, or one more than 8,191 back | `UnknownBlock(number)` (`test_theCurrentBlockIsUnknown`, `test_aFutureBlockIsUnknown`, `test_aBlockMoreThan8191BackIsUnknown`) |
| Send a header that is not an RLP list of at least 12 fields, or has a field of the wrong width | `BadHeader` (`test_aHeaderThatIsNotAnRlpListIsBadHeader`, `test_aHeaderWithTooFewFieldsIsBadHeader`, `test_aHeaderFieldOfTheWrongWidthIsBadHeader`) |
| Change any byte of any node of either proof, cut a proof short or extend it, splice in another holder's storage proof, take the account proof from another block, or submit one holder's proof for another | Reverts inside the verifier, with its own messages (`"MerkleTrie: …"`, or an RLP error), since every node is checked against the hash its parent names (`test_aChangedByteInAnyAccountProofNodeReverts`, `test_aChangedByteInAnyStorageProofNodeReverts`, `test_aStorageProofSplicedFromAnotherHolderReverts`, `test_anAccountProofFromAnotherBlockReverts`, `test_aProofOfOneHolderSubmittedForAnotherReverts`), and fuzzed (`testFuzz_aChangedByteInAnyProofNodeNeverProves`, `testFuzz_aTruncatedOrExtendedProofNeverProves`, `testFuzz_aChangedHeaderByteNeverProves`, `testFuzz_randomHeaderBytesNeverProve`) |
| Stretch a proof's life with an older block, or pay gas to change nothing | `NotNewer(validUntil)`: a proof must move `validUntil` later (`test_theSameProofAgainIsNotNewer`, `test_anOlderBlockIsNotNewerAndANewerOneExtends`), so a private relay drops one that wouldn't |
| Stay eligible after selling, or after moving the SPX to another wallet | The balance check at the moment of the buy (`test_aProvenHolderThatMovesItsSpxAwayIsNotPaidUntilItHoldsAgain`), unless the SPX is borrowed for the buy ("Flash borrows", below) |
| Prove one bag of SPX for many addresses, moving it from one to the next | Each address gets a proof, but only the one holding the bag at the moment of a buy passes |
| Name a proven contract (a pool, v4's `PoolManager`, a contract wallet) as `rewardTo`, then take its fee back out of it | Only accounts are eligible ("Why only accounts", below; `test_aProvenContractThatHandsOutWhatItIsPaidIsNeverEligible`, `test_onlyAnAccountWithoutCodeOrWithOnlyADelegationIsEligible`, `test_eligibilityIsJudgedOnTheCodeAtTheMomentOfTheBuy`) |
| Send it ether, or have it hold anything | Nothing in it is payable (`test_theRegistryTakesNoEther`) |

**Why only accounts.** If any proven address were eligible, a bot with no SPX,
proof or loan could take every fee. Uniswap v2's SPX/WETH pair held about 13
million SPX at the pinned block, and a true proof of it is as easy to send as
anyone's; a fee paid to the pair sits above its reserves, and `skim` hands
that surplus to any caller in the same transaction. v4's `PoolManager`
(through `sync` and `settle`), or any contract that pays out what it is sent,
serves as well. A test reproduces this with the pair's real mainnet proof
(`test/fixtures/proofs/holder-52c77b0c-25999900.json`), so `isEligible`
requires an account. Nothing deployable can begin with `0xef` (EIP-3541), so
the designator test lets no other code through. The cost: SPX in a contract
wallet (a Safe, a smart account) can't make that wallet a `rewardTo`; such a
holder names an ordinary account with 690 SPX of its own. An account
delegated through EIP-7702 is still an account, since only its key can
delegate it. Its owner could share its fees with whoever asks, but that takes
690 SPX of their own: the case of a bot that holds SPX ("Not defended",
below).

**Flash borrows at the moment of the buy.** A proof reads a block's final
state, where a flash loan never appears, so to prove, an address must really
have held 690 SPX when a block closed. The balance check at the buy is
different: SPX borrowed within the transaction meets it, one borrow can wrap a
whole batch, and Uniswap v4's `PoolManager` lends within a transaction for no
fee. Measured at the pinned block (`FlashBorrow.t.sol`), the borrow adds
under 10,000 gas a buy (the figures: `docs/UNISWAP-V4.md`, "What the
PoolManager lends").

So an address can buy 690 SPX, hold it past one block's end, prove it, sell
it back for about a round trip's cost (about $2 at 2026-10-02's pools), and
meet the balance check with borrowed SPX for 30 days, paying only gas. The
registry really filters for an account that "held 690 SPX at the end of a
block in the last 30 days", and spDEX says exactly that. The balance check
still stops a holder who sold, or a bag moved from address to address, from
earning, unless the account is delegated to a contract written for it, as the
test's is. Nothing on chain can tell borrowed SPX from held SPX inside a
transaction, and the contracts don't pretend to (why the check stays:
decision 17 of `docs/DESIGN.md`).

**What proving makes public.** A `Proven` event says forever that an address
held at least 690 SPX at a block. Anyone may prove any address, so it says
nothing about running a keeper. A keeper's buys do: each puts its `rewardTo`
in the calldata beside the sending key, and the batcher's `Batch` event
carries both as indexed topics (a direct call's `Bought` does too), linking a
cold wallet's SPX to a keeper's hot key in public. **Community keeping**, in
Help run the network, says so before a wallet's first proof, and
`docs/KEEPER.md` suggests a wallet kept for the SPX, not a main one (decision
24).

**Anyone may name the owner.** The owner's exception is for whoever is paid,
not whoever sends. Inside a community window `rewardTo` may always be the
vault's owner, so that **Trigger now** works there, and so anyone may make an
in-window buy by paying its fee back to the owner
(`test_theOwnerMayBePaidInsideTheWindow`,
`test_aBatchPayingAVaultsOwnerBuysItInsideItsWindow`). The sender gains
nothing and pays the gas; it keeps every caller's lever, choosing the moment
within the slot, without the fee, and can take a buy from the community
keepers at its own cost. A sandwicher doing it gives up the fee too, so loses
more than the 0.29 ETH measured with it
(`test_sandwichingTheLargestAllowedSpxBuyLosesMoney`). Such a buy is not
counted in the vault's `windowBuys`, and Your activity tells it from one the
owner made. Naming an address nobody controls, such as a proven burn address
holding 690 SPX, is the same griefing: the fee is lost, the owner pays what a
keeper would have got, and the caller gains nothing.

**A registry that fails.** The vault asks `isEligible` with a fixed stipend of
100,000 gas (`ELIGIBILITY_GAS`), over eight times an honest answer from cold
(11,191 gas, 11,659 for a delegated account:
`test_isEligibleFitsTheVaultsStipendColdAndWarm`), because no vault can be
given more once it exists, and a fork that repriced cold reads past a tighter
stipend would shut holders out of every window for good (decision 38).
Anything but exactly `true` counts as "not eligible": a revert, a burnt
stipend, no answer, a short one, any other word. So a registry that fails,
from a bug or a hard fork that reprices its reads, delays each in-window buy
only until its window ends or the owner's **Trigger now**, which never asks
it; after the window it isn't asked at all. A refused call that burned the
stipend measured 35,947 gas against 6,607 for a plain "no", and its caller
kept the rest (`test_aRegistryThatFailsCountsAsNotEligible`; decision 14).

The chain can change under it too:

- **EIP-2935 moved or retired.** `BLOCKHASH` still reaches 256 blocks back,
  about 51 minutes. The `finalized` block is inside that, so a proof landing
  within about half an hour of being built still works, and existing proofs
  keep their 30 days.
- **A header that grows.** It is hashed as given, and its fields 3, 8 and 11
  haven't moved since Frontier; the vendored reader takes at most 32 fields
  to a list and today's header has 21, so eleven more fit before proving needs
  a new registry. But the app and the keeper rebuild the header from
  `eth_getBlockByNumber`, and a field they don't know makes it hash wrong. So
  when the known fields don't hash to the block, they append the answer's
  other hex fields (at most four, in each order, as bytes and as a quantity,
  `checkedHeaderOf`), and take a header only if it hashes to the block's hash.
  A fork that adds a field every node names keeps proving working; any other
  header change, or a field nodes don't name, stops it (the app says its
  service answered wrongly or a newer spDEX is needed; the keeper logs
  `prove_skipped header-mismatch`) until the app and the keeper ship an
  update, which the release after such a fork must do (`docs/RELEASE.md`'s
  registry check). Proofs already made keep their 30 days.
- **SPX migrated, or its balances moved slot.** New proofs would fail, and as
  old ones lapsed every community window would become a wait before the buy
  opens to anyone. Slot 1 is checked against SPX's own `balanceOf` for every
  recorded proof (`scripts/record-proofs.mjs`,
  `test_theConstantsAreTheAgreedOnesAndTheSlotIsSpxsBalance`).

**A bug in the registry after it is deployed.** It cannot be patched, and
every vault names it for life in its implementation's code. The worst case is
a verifier bug accepting a false proof: addresses that never held SPX could be
paid inside community windows, as anyone may be after them. No vault's funds
are at risk. The response is decided (decision 31): the app keeps creating
vaults; a build sets the prepared notice (`REGISTRY_ADVISORY` in
`apps/web/src/lib/dca/advisory.ts`, null while there is nothing to warn of,
shipped in the bundle, never fetched), shown on the cards of vaults that name
this registry, above the creation form and in **Community keeping**; and a
fixed registry, vault, factory and batcher ship as a new contract release.
The opposite bug, a registry refusing everyone, is "A registry that fails".

**Where review starts.** Following a Merkle-Patricia proof is the one complex
piece of the contracts, so it is not written fresh. `SecureMerkleTrie`,
`MerkleTrie`, `RLPReader` and `Bytes` are Optimism's (MIT, tag
`op-contracts/v8.0.0`, commit `f45a5ccfebcdf6da3f5b09cbc512667c063730b7`),
vendored in `packages/vault/contracts/vendor/optimism` byte for byte but for
import paths; Optimism's portal proves every withdrawal from its chain with
them. The README there gives each file's hash, a command comparing them with
upstream, and the properties the registry relies on, each pinned against real
mainnet proofs in `test/forge/Registry.t.sol`. One worth knowing: a proof
whose path ends in a node under 32 bytes, which geth leaves out of
`eth_getProof`, is refused ("MerkleTrie: ran out of proof elements"), never
accepted. It can't arise for the registry's two proofs: an account leaf is at
least 70 bytes, and a balance leaf that short would need two hashed keys
sharing their first 26 nibbles, about one chance in 2^104.

**Timing at the edges.**

- **The first buy** falls due at `startAt`, whenever the vault was made: the
  vault can't know when without its address depending on the block. So a plan
  whose first community window ended before its creation was mined gets none
  for that buy, which is open to anyone in the vault's first block
  (`test_aFirstBuyWhoseWindowEndedBeforeTheVaultExistedIsOpenAtOnce`). A
  start far enough ahead gives it one, as the test's second plan shows, and
  the app starts a "first buy now" vault with a short window that far ahead
  (`vaultStartLead`, `docs/ARCHITECTURE.md`, "The community window"): a
  creation landing within two minutes keeps a minute of first claim, and a
  slower one gets less.
- **A buy that becomes possible late.** Each slot has one community window,
  from when its buy fell due, so a buy the vault couldn't make during it
  (short of WETH until a top-up, a floor that refused throughout) is open to
  anyone once possible, in the same block as the owner's top-up if a bot is
  watching (`test_aBuyThatBecomesPossibleOnlyAfterItsWindowIsOpenAtOnce`). The
  owner can make it at once with **Trigger now**.
- **Timestamps.** A block producer can nudge a timestamp by seconds, which can
  move a buy across its window's end and never adds one.

**Proving from the app.** **Prove my SPX**, **Prove another address** and
**Paste a proof**, in **Community keeping**, build a proof in the browser from
the person's own service, or from answers pasted from elsewhere and checked
against it, and send nothing unless the rebuilt header hashes to the block's
real hash; the page never fetches from anywhere else (AGENTS.md, rule 4; how:
`docs/ARCHITECTURE.md`, "Community keeping"). A proof is the sixth
transaction `VaultGuard` checks:

| It tries to | It is stopped by |
|---|---|
| Send the proof anywhere but this release's registry | `VAULT_MALFORMED`, static: exactly one call, to the registry address computed from its creation code (`MAINNET_REGISTRY`), never read from anywhere |
| Attach ether to a proof | `VAULT_MALFORMED`, static; the registry refuses ether anyway |
| Send a proof built against the wrong block, or a header other than that block's | `VAULT_MALFORMED`, static: the header must hash to the block hash the proof names, its number must be that block's, and that hash must be the one the Guard reads for the block itself |
| Carry calldata other than the proof | `VAULT_MALFORMED`, static: the call must be byte for byte `prove` with the proof's own holder, header and nodes |
| Send halves of another block's state under the right header | `VAULT_MALFORMED`, static, before anything is test-run: the account proof's first node must hash to the header's state root, and the storage proof's to the storage root the account proof's leaf states. Such a proof could only revert |
| Record a proof for another holder or block, or move anything | Simulated: exactly one `Proven`, emitted by the registry, for this holder and block; nothing leaves the account and no allowance is granted (`UNEXPECTED_*`) |
| Be signed on one service's word | Allowed: a proof moves no money and a false one only reverts, so it follows `requireSimulation`, and may be signed "Checked on one service" (`unverified`). The paths that are never signed unchecked are unchanged, and a proof is not among them |

A proof that would change nothing reverts `NotNewer` in the test-run, and the
Guard says until when the address is proven. Two things are left to the host
and the test-run, since neither moves money: a block more than 8,191 back,
which the app refuses before building or taking a proof (the registry would
say `UnknownBlock`), and a holder that is a contract, whose proof the registry
would record but never find eligible, which the panel refuses in words before
building one.

Not defended:

- **A bot that holds 690 SPX.** It is a community keeper like any holder and,
  being fastest, may win most in-window races; a larger fee makes that worth
  more. The registry filters for accounts that held SPX recently, not for
  people or long-term holders. `pnpm keeper:report` publishes how
  concentrated community-window buys are: the share won by the top 1 and top
  5 `rewardTo` addresses over a rolling 30 days, the developers' keeper
  counted like anyone. One address above 50% for 30 days reopens the decision
  not to have turns among holders (decision 29).
- **Flash borrows,** as above: measured and published, not prevented.
- **No eligible keeper online.** A buy waits out its community window, then
  goes to whoever is fastest; the owner can always trigger it. The
  developers' keeper proves and runs as a community keeper like any holder
  (decision 28); no keeper is promised.
- **`MIN_SPX` wrong for SPX's price.** Too high shuts ordinary holders out,
  too low lets bots in cheaply. It was about $293 at 2026-10-02's price. It is
  a registry constant, so changing it means a new registry and factory: a new
  contract release.
- **What proving makes public,** as above. The warning comes before the first
  proof; the link is permanent.

### A keeper and its hot key

A keeper is software anyone may run, not part of the app, and nobody promises
to run one. It guards its operator's own: a hot key with ether for gas, and
the fees it earns. spDEX's developers may run one during the beta, as anyone
may. `docs/KEEPER.md` is the operator's guide; this is what the keeper
distrusts, and why.

| Threat | What bounds it |
|---|---|
| The hot key is stolen | It holds only gas money: the operator sets a cold `SPDEX_KEEPER_REWARD_TO`, and every batch pays its fees there in the same transaction. For a community keeper the 690 SPX stays in that cold wallet too; the hot key never holds it. The key file is read once, at start, and a warning names group- or world-readable permissions |
| A cold `rewardTo` leaves the hot key paying gas it never earns back | The keeper logs and reports its runway, the days of sending its balance covers at its recent spend, and warns below `SPDEX_KEEPER_MIN_RUNWAY_DAYS` (7 by default); the operator tops it up by hand (decision 18). Run dry, it stops sending, and its buys fall to other keepers, or to anyone once their community windows close |
| A bug, or a lying endpoint, gets the key to sign something else | `assertKeeperMaySign`, right before every signature, allows only the shapes `docs/KEEPER.md` lists ("Keeping the key and the fees safe"; `AGENTS.md`, rule 2), none carrying ether, and a `prove` only with `SPDEX_KEEPER_PROVE=1`. Anything else throws, and each near-miss has a unit test |
| A lying endpoint says the `rewardTo` is eligible when it isn't, or isn't when it is | The vault decides on chain. A wrong "yes" costs a simulation the vault refuses with `NotEligible`: the keeper rests that vault until its community window ends and reads eligibility again, and a private relay drops what it would have sent. A wrong "no" makes it wait out community windows it could have taken. Neither moves money |
| A lying endpoint feeds it a false proof, or a proof of another block | A false proof only reverts: the registry checks the header against the block's real hash, read on chain. The keeper proves only the `finalized` block, only for its configured `rewardTo`, and only to a listed registry; it checks the header's hash and the proof against its state root before signing. The endpoint also answers everything that says whether a proof is needed and how the last one went (the record, the receipt, the chain's time), so the keeper sends at most one proof a day and none for a day after one reverts (`attention: prove_reverted`), both by its own machine's clock, which no endpoint can move: an endpoint that lies costs at most one proof's worst price a day. A proof in flight that another proof overtakes is withdrawn, never bid up |
| A lying endpoint makes it overpay | A batch's gas limit is the keeper's own figure, never `eth_estimateGas`, and a proof's is never above 750,000; `maxFeePerGas` is capped (3 gwei by default); the worst a lying endpoint can cost is `gasLimit × maxFeePerGas` a transaction, about 0.0054 ETH for a batch of ten vaults at the cap, and 0.00225 ETH for a proof |
| A lying endpoint makes it trigger something hostile | It triggers only vaults a listed factory's own list names, each proven before its first batch: its address recomputed from the factory, its owner, its terms and a nonce, which an endpoint can make fail (the vault is skipped, `unproven`) but cannot forge, since only the factory can have put code at that address. Each attempt is capped at the gas the keeper gives it, 400,000 by default |
| A stale, future or rewound head | A head older than `SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS`, dated that much ahead of the machine's clock, or behind one already seen, sends nothing that tick and says so |
| Two processes signing with one key | A lease file taken for every mode that can sign; a second signer exits naming the holder. Two machines on one key are unsupported: a standby keeper uses its own key |
| A crash between signing and broadcasting | The signed transaction is written to the state file first, so a restart finishes or replaces it at the same nonce |
| A tampered, foreign or newer state file | Refused at start, naming the field (chain, key, releases); `--reset-state` moves it aside, never deletes it |
| Secrets in its logs | Typed fields are validated and never redacted; free text is redacted of the key, in every form, of every configured URL and its long segments, and of anything shaped like a URL or a 64-digit hex string. The endpoint's URL is never printed |
| Griefing its subsidy with dust vaults | No subsidy by default. An operator who offers one pays it only for vaults that pay the fee spDEX proposes for their size, by default only for buys of at least 0.0003 ETH on plans at least an hour apart, oldest vaults first, so a flood of new vaults cannot crowd out older ones. Each vault is booked at most its own shortfall and only within its own caps per buy, per vault and per owner each day, never on another vault's allowance; a breaker stops all subsidy once a day's realised losses reach its cap. A per-owner cap alone would not stop a sybil, and is not relied on |
| A mempool copier, a partial race, a sandwich | "The batcher", above |

Not defended: a keeper's timing. Inside a due slot any keeper chooses the
moment and could sandwich within the allowance ("An auto-buy vault"); inside a
community window that is any eligible keeper, or anyone paying the fee back to
the owner. Nor a keeper's losses from its own model, such as a block dearer
than planned: the breaker bounds them; nothing removes them.

**What the report can and cannot know.** `pnpm keeper:report` is read-only: it
signs nothing and contacts only the endpoint its operator configures. Its
figures are public chain data and the operator's own logs, as honest as that
endpoint and those logs. It reads to `finalized` by default, so a reorganised
block can't add a buy that didn't happen; it checks itself (every vault's
`buyNumber` without gaps, every batch's `earned` against its buys' fees) and
lists what it couldn't read as unknown, never zero. For a buy with a community
window it says who made it, from the caller, `rewardTo` and `dueSince` in the
vault's own `Bought`: this keeper, another community keeper, the owner,
someone paying the fee back to the owner, or anyone after the window. It
publishes community-window concentration ("The community window and the SPX
holder registry") and only what was earned, never a projection. By design it
cannot know anything the app does not put on chain (who uses the app, what
they tried and abandoned, which frontend made a vault): that is recorded
nowhere, which is the point (AGENTS.md, rule 4).

### A lying tracker

A tracker reports what is in a pool. It cannot propose a transaction, is never
consulted when one is built, and nothing it returns reaches the Guard, so a
malicious one costs a **bad decision**, not a bad swap: a real harm and a
smaller one, which is why a tracker may be wrong in ways a venue may not.

The capability model bounds it. The shipped tracker declares three token
contracts and reads `balanceOf` on them, nothing else, and the parity gate
asserts both runtimes refuse an undeclared read identically. Its figures come
from token contracts; a tracker returning something else disagrees with the
chain, not with us.

Not defended: a tracker reporting a pool deeper than it is, to steer you into
it. The router quotes pools directly and never consults it, so the worst case
is a user choosing a pool by hand on bad information. Pool statistics are a
display, and the app treats them as one.

### A wrong price for money

spDEX trusts money rates differently in two places.

- **As a display** (every "≈" figure, a buy fee's worth, a pool's TVL), a
  wrong rate costs a bad decision, like a lying tracker, bounded the same way:
  nothing that decides a route or a signature reads it.
- **As an input aid**, an amount typed in dollars or another currency becomes
  the token amount that is quoted, saved and signed, so what you sign depends
  on your network service's answers. The token amount on screen is the check.

The rates are spDEX's 10-minute average price for dollars (the oracle the
Guard cross-checks swaps against) and Chainlink's dollar price of each other
currency, all read through the person's own network service. What bounds a
wrong one:

- **The token amount is signed, and always shown.** The field shows it under
  the money as it is typed, every confirm line leads with it, and the money is
  named as what was typed, never echoed back through the same rate as if that
  confirmed anything. The quote, the Guard and the wallet see only the token
  amount, and the Guard still holds the swap to it: a wrong rate can make
  someone spend more ETH than they meant, never make a swap deliver less than
  it says.
- **Sized once, from a fresh price, in its own currency.** No background
  refresh re-sizes an amount, nothing is quoted or started from a dollar price
  over 5 minutes old, and an amount in euros is never sized as dollars
  (`docs/ARCHITECTURE.md`, "Money", has each rule).
- **Implausible answers are unknown**: zero, stale, of the wrong decimals or
  outside 0.2× to 5× of the answer at release (the full list:
  `docs/ARCHITECTURE.md`, "Money"). Ether's dollar rate, the 10-minute
  average, is held to the same band around the ETH/USD feed's answer at
  release (`ETH_USD_REFERENCE`) and, when the page's currency read brought an
  ETH/USD answer at most three hours old, to within 10% of it, so a pushed
  average can't size "$20" as any amount of ether. Unknown refuses typing in
  that currency, and a display falls back to dollars with a note, never to
  zero.
- **A plan is its token amount.** A plan typed as $20 saves the ETH that came
  to, and no rate re-sizes it at a later buy.

Not defended:

- **A network service that lies consistently.** It answers both the average
  and the Chainlink reads, so it can make $20 come to more ETH than $20 is
  worth, as it can fake a simulation. A second opinion sizes money only from
  rates both services agree on to within 1% ("A second opinion"); without
  one, or when the second doesn't answer, nothing cross-checks them. The
  token amount on screen is the check.
- **Chainlink itself, within the band.** spDEX trusts the feeds' operators; a
  feed moving inside 0.2× to 5× of its reference isn't caught. The references
  are refreshed at each release, and a currency that legitimately drifts out
  of its band (the peso is likeliest) reads as unavailable until then.
- **USDC off its dollar.** USDC counts as exactly $1, as everywhere in spDEX.
  A note says so when Chainlink's USDC/USD answer is more than 1% away; it
  never refuses anything.

### Sharing what you did: the CSV, the statement and the card

Your activity's CSV and printed statement, and the "I bought" card, are made
in the page and handed over as files; nothing is uploaded. What they reveal is
the person's choice to share, and the app says what that is before saving.

- **An address and its history.** The CSV and the statement list the address
  and every transaction hash; the card prints a hash, which leads to the
  sending address and everything it has done. Both warn before saving. The
  card prints the address only when asked, since the hash finds it anyway.
- **Formulas in a spreadsheet.** Plan names are anyone's text and arrive in
  shared settings links, so any cell a spreadsheet would run as a formula
  (starting with `=`, `+`, `-`, `@`, a tab or a line break) gets a leading
  `'`, and every cell is quoted as RFC 4180 says.
- **Markup in the card.** The caption is JSX, so React escapes it, and the PNG
  is that same mounted SVG drawn on a canvas from a `data:` URL: no markup
  string is built from it, and no remote font or image is loaded.
- **A card is a claim, and its link checks it.** Anyone can edit or invent a
  card, so a `#receipt=` link trusts nothing on it. It reads the transaction
  through the viewer's own service, counts only `Transfer` logs the SPX
  contract emitted, and calls SPX "bought" only as far as a market's swap paid
  it out: from a pool spDEX itself discovers for SPX, net of what went back to
  that pool, capped by the pool's own `Swap` logs, so a dust swap can't vouch
  for a large transfer beside it. A vault any listed factory vouches for is
  named when it made the buy. SPX from anyone else is "received from … (an
  account)", and a pool's payout without a swap is called not a purchase. A
  tip count is checked the same way: the link names the tip transaction, and
  the view counts only SPX the buyer sent to other addresses in it, never a
  pool, mined no earlier than the buy; a count it can't check from one
  transaction never goes on a card. It can't show who made the card, and says
  so. The viewer's service learns which transactions were looked up.
- **Scams that follow a posted buy.** Under its buttons the card says nobody
  from spDEX or SPX6900 will message first, and anyone offering "help" after
  seeing it wants the SPX.
- **A calendar file** carries the pair, the amount and the plan's name, and no
  address, key or hash, since calendars often sync to someone else's servers.
  The name is escaped as RFC 5545 says and stripped of other control
  characters, so a hostile one can't add an event or an attachment.

Not defended: a file after it is saved. A CSV emailed to an accountant, or a
card posted with its hash, links that address to that person for good.

### An account that does not keep what it is paid

EIP-7702 lets an address run somebody else's code whenever it is *called*,
including when paid: legitimate, increasingly common, and how a compromised
key becomes a sweeper, forwarding any ether that arrives in the same
transaction.

The Guard needs no special case: it measures the recipient's balance after
simulation, so a swept payout is `RECIPIENT_MISMATCH`, refused before
signing. The check is on the outcome, not the mechanism. spDEX also warns on
connect, since "the recipient receives nothing" about your own address reads
as an app bug rather than a fact about your wallet.

**Every anvil development account has one of these on real mainnet.** Their
keys are published, bots delegated them to sweepers long ago, and a mainnet
fork inherits that state. See `docs/TRY-IT.md`.

### A malicious token contract

**Out of scope, and the most important thing on this page.**

The Guard derives what moved from ERC-20 `Transfer` events. A token that moves
balances without emitting them produces a delta of zero, which fails
`MIN_OUT_NOT_MET`, so a *quiet* token fails closed. But a token that drains a
balance through a path it does not log, or behaves differently after the
simulation, is beyond any transaction-level check. The token is the thing
being measured; it cannot also be the measuring instrument.

So the token list is a user-controlled module, not a fixed list blessed by
us, and the shipped list has three entries whose decimals were read on chain,
not three hundred nobody checked.

### Us

spDEX has no admin key, protocol fee, governance token or contract anyone
controls, and its swaps go through no contract of its own. The vault, its
factory, the batcher and the SPX holder registry have no owner, upgrade or
pause, so nobody, us included, can change a vault's terms, fee or funds, or
who may be paid in its community window. Nothing to upgrade means nothing to
rug; unaudited code is a different risk ("An auto-buy vault").

The tip list includes our own donation vault, as a builder entry held to the
same rules as anyone's, except that its evidence is this source rather than an
outside post: the app names it from a constant it ships, so no list can make
another address look like ours. It is never chosen for you: tips are off
until you pick a share and who gets it, and no preset names a recipient.

We may run a keeper, during the beta or after, and like any keeper collect
the fees on the buys it makes; the app says so where it states the fee. Like
any keeper, ours could choose a due buy's moment and sandwich it within the
allowance. Ours holds 690 SPX in its `rewardTo`, proves it, and is a
community keeper like any other, with no special treatment: its
community-window wins count in the published concentration figure (decisions
28 and 29). A vault's fee is fixed at creation, and nothing we change, a new
default included, reaches an existing vault.

What we *could* do is ship a malicious bundle. It could ask your wallet to
sign anything, as it always could, including a vault creation on a factory of
its own or with a larger fee. It could not take what an existing vault holds:
only the owner's `close` returns that, and only to the owner. The defences:
the app is a static bundle with a reproducible build (two builds from the
same source give the same IPFS address, which `pnpm verify` checks), and it
is AGPL, so the source of what you run is source you can read. Pin a CID you
have verified and no future release can reach you.

## What is explicitly *not* defended

Each is stated, with its reasoning, in the section named.

- **A compromised browser or wallet.** Game over; nothing in a web page
  changes that. The same goes for anything else that can run script on
  spDEX's page, such as a malicious extension.
- **A malicious token** ("A malicious token contract").
- **A Permit2 signature or approval another site asks for,** on a token
  Permit2 holds the standing permission for. It moves what it allows with no
  further transaction from you; revoking does not erase allowances held
  inside Permit2 ("Batched tips").
- **An endpoint that lies about simulation** ("A malicious RPC endpoint", "A
  second opinion").
- **Price risk.** The Guard proves you receive at least `minAmountOut`, not
  that it was a good trade. The oracle cross-check is a *warning*,
  deliberately unable to refuse: an oracle that can block swaps is an oracle
  worth attacking. A scheduled buy carries this risk every time it runs, and a
  vault's buy can be made as far below the pool's price as its allowance
  lets, by a keeper who sandwiches it ("An auto-buy vault").
- **Buys while spDEX is closed,** for a plan you confirm yourself: a missed
  buy time is skipped, not made up. A vault plan buys with no tab open, but
  only when somebody triggers it, and nobody promises to.
- **Unaudited contracts.** A bug in the vault, its factory, the batcher or the
  SPX holder registry with its vendored verifier could lose what a vault
  holds: at most 0.5 ETH put in per vault, with no limit on how many vaults
  one account creates. A bug in the registry alone cannot reach a vault's
  funds.
- **SPX borrowed for a buy,** for no fee from Uniswap v4: measured and
  published, not prevented ("The community window and the SPX holder
  registry").
- **Lost browser storage.** The plans (the config) and their records live in
  this browser. Clear the site's data, close a private window, or open spDEX
  at a new origin, and they are out of spDEX's reach: the plans are gone
  unless the config was exported, and re-imported they arrive paused and
  count from zero. Your activity's record of one-time swaps and tips goes
  too, and nothing on chain marks them as spDEX's, so it can't be rebuilt;
  download the CSV to keep it. A vault plan loses only the pointer: its money
  and record are on chain, and its vault goes on buying. The app finds it
  again from the factory's `VaultCreated` logs when the owner's wallet
  connects, as far back as the endpoint allows, and from the factory's own
  list of vaults when that search stops short; an exported config gives it
  back regardless.
- **Partial execution of a split route.** A multi-leg route is several
  transactions, since spDEX's swaps go through no contract of its own that
  could batch them atomically. Each leg is checked against its own minimum, so
  none can underpay, but a later leg can revert after earlier ones executed.
  The app says so on any route with more than one leg.
- **Anonymity.** Your endpoint operator sees your address and your queries,
  the built-in service's publisher included; the disclaimer, the first-run
  screen and Settings → Network service say so. Private sending hides you
  from the *mempool*, not from your node. Some reads say less than they might:
  the currency rates are one request whichever currency you chose, and
  Collective DCA's reads never name your address. But opening a `#receipt=`
  link tells your service which transactions you looked up, and finding your
  vaults from the factory's list is no privacy measure: the service sees your
  address in every balance read anyway. Proving SPX held publishes for good
  that an address held 690 SPX, and a community keeper's buys link it to the
  key that sends them.

## Verifying the claims rather than believing them

The defences above are tests, not promises, and they run in the gate:

```bash
pnpm verify --strict
```

- **`redteam`** puts in front of the Guard what deliberately malicious
  modules, schedules, vault transactions (a creation above the fee ceiling, a
  **Trigger now** paying anyone but the owner), batches of other people's
  vault buys (one paying anyone but the connected wallet) and proofs of SPX
  held (sent anywhere but the release's registry, with ether, or built against
  the wrong block) would ask for, each one change away from an honest plan,
  and the Guard must refuse every one. It runs a second opinion against every
  Guard the Engine builds (a disagreement; a main service steering the heads,
  the block or the time; one failing its own reads to dodge the comparison; a
  second service gone quiet), where the verdict must never beat what one
  service alone would give, and fails when the Engine builds a Guard class it
  doesn't know.
- **`integration`** runs the second opinion against the fork through an
  in-test proxy that lies, lags or goes quiet, sends a real batch, and runs
  the keeper; one case, the only one, waits out a 60-second community window
  in real time.
- **`contracts`** runs the forge tests on a mainnet fork at the pinned block:
  every refusal in "An auto-buy vault", "The batcher" and "The community
  window and the SPX holder registry"; the reviews' attacks (the sandwich, the
  one-block push on the oracle pool, the keeper-trap vault, re-entering and
  fee-on-transfer tokens, imitation markets, a re-entering batch, a return
  bomb, a vault that burns its cap, a proven contract that hands out its fee);
  the registry against real proofs recorded from mainnet
  (`test/fixtures/proofs`) and false and fuzzed ones; every edge of the
  community window to the second; the `rewardTo` fuzz invariant; the
  flash-borrowed batch; and the measured gas the fee is priced from. It
  rebuilds the contracts from source and fails if the registry, factory or
  batcher address the app and keeper ship is not what the source builds to,
  or if the earlier test deployment's frozen source
  (`packages/vault/releases/v1`) no longer builds to its deployed factory and
  batcher.
- **`conformance`** runs capability-escape attempts that must fail.
- **`parity`** runs the same fixture modules through both runtimes and
  requires identical bytes, so for them the native fast path is no different
  code path.
- **`unit`** holds the host's own defences: plans arriving paused, and
  autopilot plans arriving as paused wallet plans (`packages/config`); a buy
  never started by the timer, and the claim before signing (the runner and the
  record in `apps/web/src/lib/dca`); the fee (`packages/vault/src/fee.ts`);
  what may turn money into a signed amount, and how typing is read
  (`apps/web/src/lib/money/resolve.test.ts`, `parse.adversarial.test.ts`); and
  the partial check that every request goes to the network service in use
  (the built-in one the disclaimer names, or one the person chose) or the
  relay the person chose (`apps/web/src/no-requests.test.ts`). It holds the
  keeper's too, in `packages/vault/src`: what `assertKeeperMaySign` allows and
  refuses (the `prove` shape and its near misses included), the state written
  before every broadcast, redaction over every record it produces, and the
  keeper and the report never reaching the app (`boundaries.test.ts`). The
  keeper's Docker image is checked by `pnpm keeper:smoke`, not a gate stage.

A green `redteam` is the Guard's half of this document and a green `unit` the
host's; **never ship either red.** A *skip* is not a pass: stages needing
Foundry or a browser skip without them, which is why `--strict` exists and CI
uses it.
