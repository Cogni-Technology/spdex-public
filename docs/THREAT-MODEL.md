# Threat model

What spDEX defends against, what it does not, and how to tell which is which.

This document is the counterpart to the README's claim that handing a
stranger's module to a first-time user is defensible. That claim is bounded,
and the bounds are here.

## The assets

1. **The user's tokens.** Everything else is instrumental.
2. **The user's approvals.** An allowance outlives the session that granted it.
3. **The user's intent.** What they are about to trade, and for how much —
   valuable to a front-runner before the transaction lands, and to anyone
   building a profile afterwards.
4. **The user's configuration.** It names their endpoint and their pools; a
   config an attacker controls is an endpoint an attacker controls.
5. **The user's standing orders.** An auto-buy plan the owner confirms spends
   on a schedule, one click per buy, on terms the plan already fixed. Its terms
   are config; what it has already spent is a record in this browser, and that
   record is what stops it spending twice.
6. **A vault's budget.** A vault plan's money is in neither spDEX nor this
   browser. It sits in a contract on chain: at most 0.5 ETH put in per vault,
   spent only by buys that keep the vault's terms and the buy fee fixed when it
   was created, and returned only to its owner. Its terms and its record of
   what it has bought live on chain too.
7. **The user's records.** This browser's record of their swaps, tips and
   buys, which holds their addresses and transaction hashes. It never leaves
   the browser unless they download a file.
8. **A keeper operator's key and earnings.** Someone who runs a keeper holds
   a hot key with ether for gas, and is paid buy fees at an address of their
   choosing. That is their asset, not a vault owner's, but spDEX ships the
   software that signs with it. A person who helps run the network from the
   app (below) is the same case without a keeper: their own wallet pays the
   network fee and is paid the buy fees.

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

The single line that matters is the one under the host. **A first-party module
is faster, never more trusted.** Both runtimes reach the signer through the same
Guard, which judges the plan and never learns which runtime produced it.

The *your* in the top line is deliberate. spDEX never holds your key. Until
config version 8 an "autopilot" plan bought from a spending wallet, a key this
browser generated; no release ever made one, and since 2026-10-02 the app no
longer reads those wallets.

A vault plan sits lower in the diagram, not higher. Its buys are signed by
nobody spDEX trusts: whoever sends the transaction, a stranger's keeper
included, directly or through the batcher.
So the vault trusts none of them, and enforces its terms on chain itself. What
the owner trusts instead is the vault's code, which is **unaudited**, with at
most 0.5 ETH per vault. That is "An auto-buy vault", below.

## Adversaries, and what stops them

### A malicious module

The main event. A module is arbitrary code from anyone.

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

One kind of effect needs knowing where to look. An allowance can live in a
contract's own books rather than in the token, as Permit2's do, and a contract
that already holds an ERC-20 permission from you can be armed that way by a
call that moves nothing. The Guard reads Permit2's books because spDEX itself
gives Permit2 that permission (see "Batched tips"). It does not recognise
every contract with books of its own; one you gave an unlimited permission to
elsewhere, and that a module declares, is a risk it cannot see, which is one
more reason a module's declared contracts are worth reading.

### A malicious RPC endpoint

It can lie about state, so it can lie about a simulation.

- It **cannot** sign. For a manual swap or an auto-buy you confirm it cannot
  cause a signature either: both wait for you.
- It **can** make a good swap look bad — denial of service, which is loud.
- It **can** make a bad swap look good by faking simulation results. There is no
  defence against this within a single endpoint: if you ask one party for both
  the price and the proof, you are trusting that party. A second opinion
  (Settings → Safety) makes faking a test-run take two services the person
  chose; it is optional, and "A second opinion", below, says what it does and
  does not cover.
- A keeper's endpoint **supplies the nonce, fees and gas** to a key that
  signs with nobody looking; "A keeper and its hot key" says what bounds it.
- It **can** delay or hold auto-buys: report high fees, refuse to simulate, or
  report a price the oracle warns about. Each is loud, and each costs a buy
  time rather than money. It **cannot** redirect one on its own: the owner is
  written into every buy's intent by the host.

- It **supplies the tip** spDEX suggests to the wallet, signs a private
  transaction with, and quotes as the network fee (`readWalletFees`,
  `privateGasPrice`, lib/fees.ts): what its fee history says recent blocks
  took. Said too low, the tip is the floor, 0.05 gwei, and a transaction may
  wait. Said too high, it is the ceiling, 0.5 gwei: the most an endpoint can
  add to a swap of about 160,000 gas is 0.00008 ETH. The wallet shows the
  figure before anything is signed, and its user can change it.
- It **can** make an amount typed in money come to a different token amount,
  since it answers the rates that size it ("A wrong price for money", below).
  The token amount on screen is the check.
- It **can** tell a `#receipt=` view anything about a transaction. The view
  reads only through the viewer's own service, so it is as good as that
  service and no better; a card's claim is never taken on its own word.

This is why the endpoint is a disclosed default rather than a hidden one: the
built-in service is used without asking only where its publisher hosts this
copy (the canonical origins its key is allowlisted to), only after the
disclaimer, which names it and says it sees your IP address, has been
continued past, and it is shown in the status panel and Settings → Network
service, where another is one click away. Everywhere else first-run asks. It is
also why the privacy notice says plainly what the operator sees, why the app
never moves anyone to another operator by itself (a failing built-in service
gets a notice and a button, not a switch), and why the honest answer to "how
do I close this hole" is **run your own node**.

### A second opinion

A second network service, run by someone else, that test-runs every
transaction too (config `guard.secondOpinion.url`, set in Settings → Safety
only after it passes a test). Every Guard that simulates runs through it:
swaps, tips and the Permit2 permission, scheduled buys, the four vault
transactions and a batch of vault buys (`packages/guard/src/second-opinion.ts`;
a red-team test fails when the Engine builds a Guard it doesn't know).

**How the two are made comparable.** Asked about "the latest block", two
services answer about different blocks with headers each fills in itself. So
both are asked for their latest block, then for the header of the lower of
the two, and must agree on its hash, time and gas limit; both then test-run
the identical request on top of that block, named by its hash, with the next
block's whole header pinned (its time taken from the agreed header, never
from the main service alone) and an explicit gas limit per call. Compared:
the outcome, every real log in order, and the ether each account gains or
loses. Not compared: gas used and revert strings, which differ between honest
clients.

**The rule it keeps.** The second opinion is *unavailable* only when the
second service itself fails: an error, a timeout (8 s for a request, 12 s
for all of one check's requests to it, which a slow main service can't use
up), no `eth_simulateV1`, no answer for a block it must have. That is the one
state that can leave something signable on one service's word ("Checked on one service",
`unverified`, with `SECOND_OPINION_UNAVAILABLE`). If anything the main
service said could produce it, a lying main service would turn every
disagreement it expected into something the person could sign.

| A service tries to | What stops it |
|---|---|
| Show a clean test-run where the second shows a theft, an extra outflow, a shortfall or a revert | `SECOND_OPINION_DISAGREES`. A disagreement comes back as a *reverted* test-run, so every path refuses it whatever `requireSimulation` says, even one that forgot the second opinion; the Guard then names it |
| Report its latest block far ahead of or behind the second's, so nothing can be compared | A service up to 3 blocks behind the other, either one, is given a moment to catch up (two re-reads, 500 ms apart). Still more than 1 block apart after that and one 2 s retry is a disagreement (reason `heads`) whichever is behind, never "unavailable": a main service reporting itself behind would be choosing an older block to be checked on |
| Report a different block at the agreed height, or a different time or gas limit for it | A disagreement (reason `block-hash`) after one retry, which absorbs a one-block reorg at the tip |
| Test-run at an early time, where a contract built to behave only before some moment looks honest | The time is the agreed header's plus 12 s, pinned on both |
| Fail its own reads, or say it can't test-run, so no comparison happens | The second service is asked anyway. The main service's unpinned test-run is compared with the second's, and any difference is a disagreement; when the main service gives no test-run at all, the second's is judged in its place. A pass is only ever "Not checked" (`SIMULATION_UNAVAILABLE`), never "Checked on one service", and is refused wherever a path never signs unchecked. The main service's word stands alone only when the second fails as well, and then because of the second's own failure |
| Be the second service and lie | A disagreement: refused, loudly. Denial of service, not theft. The refusal names the setting (Settings → Safety) and says either service could be wrong, the main one included; it never tells the person to drop the second opinion, since that is the advice a lying main service would want given |
| Be the second service and stay silent | "Checked on one service" on a one-time swap or tips; refused where nothing is ever signed unchecked: under "refuse anything unsimulated", a Permit2 permission, a vault transaction that sends ether, a batch of vault buys, and every scheduled buy (skipped, and said so) |
| Be the same service twice, or one operator under two names | The same address (after normalising it) is not a second opinion: it is ignored, and the strip says it doesn't count. The same host, or the same last two labels of it, gets a warning that it is probably one operator; that is a heuristic, not a check |
| Switch the second opinion off from an older tab or copy | A tab running an older spDEX saves a config without it. A newer tab open at the time never adopts that save: it writes its own config back and says so. With no newer tab open, the next newer load finds the older save below the version it last saved itself (kept under a second key, `spdex.config.newest.v1`, that no older spDEX touches) and asks, "Restore my settings" (the ones it saved last) or "Keep these", rather than migrating the older save silently. A config link that removes it says so in its summary. Not defended: on a gateway that serves copies under a path, every other site there shares the browser's storage and can change settings, which an open tab takes up as if the person had; Trust and exits says so on such a copy |

With a second opinion set, typed money is sized only from rates both services
agree on: the 10-minute average and every Chainlink currency answer are read
through both, and a difference of more than 1% in any rate used turns money
input off ("type ETH instead"). If the second service doesn't answer those
reads, money is sized from the main service alone, as a test-run is when it
doesn't answer.

Not defended:

- **Anything but the test-run.** It catches a service lying about what a
  transaction does. It doesn't check anything else your main service tells
  spDEX: prices and the Guard's 10-minute price check (this release does not
  cross-read that average on the second service; the price check stays a
  warning, read from the main service alone), balances, allowances, which
  contract sits at an address (such as Permit2's), vault state, or fees
  (including the gas price a batch of vault buys is signed at). A check can
  run one block behind the main service's newest, the lag two honest services
  commonly have, so a change made in that block isn't seen. And no test-run,
  on one service or two, catches a contract built to behave differently a few
  seconds later.
- **Two services that collude,** or are one operator under names that don't
  look alike. The person chooses both; spDEX can only warn about the obvious
  case.
- **What the second service learns.** It sees every transaction before it is
  signed, as the main service does, and the checks it is asked for name the
  account. Choose it as carefully as the first.
- **A second service that is honest but different.** A client that leaves out
  ether-transfer records, or fills in state overrides differently, would
  disagree about every swap that moves ether. The setting's test catches that
  before it is saved; a service that changes later refuses rather than lets
  anything through.

### A hostile configuration link

A URL fragment carrying a config is the cheapest attack surface in the app: a
config sets the RPC endpoint and the pool policy, so a config an attacker
chooses is a swap an attacker routes.

It is **staged, never applied.** The app shows a diff against the config you are
running now — not against the shipped preset — and applies nothing until you
accept. Above that exact diff, the prompt names in plain words the changes of
these kinds: a different network service (the endpoint); trading limited to
fewer markets; tips; auto-buys added, removed, changed under the same id, or
paused; a wider price tolerance; contracts trusted beyond the modules' own; the
safety test made optional, or its price warning widened; a different way of
sending; and plug-ins from outside spDEX. Anything else — the router's split
settings or the deadline, say — is only in the exact diff below it, which is
why the diff stays open.

Auto-buy plans get one more rule, because they spend on a schedule: any config
from outside this browser arrives with every plan paused. The rule lives in
`importConfig`, the one function a link and a pasted file both go through — a
pasted file is applied without staging, so a rule in the review step would miss
it. A plan in a shared link can therefore sit in the diff; it cannot start.
Starting it is one deliberate act by the person whose money it is.

### A front-runner

Ordinary public broadcast puts the transaction in the mempool, where it can be
seen and traded ahead of. `submitter.mode = "private"` has the wallet sign
without broadcasting (`eth_signTransaction`) and posts the signed transaction
to a relay instead. Before posting, spDEX reads the signed
bytes back (`apps/web/src/lib/signedTx.ts`) and posts nothing unless the
recipient, call data, value, chain and nonce are the ones the Guard checked,
and the gas limit and price too where those were exact: a wallet that fills
in its own fees has signed a different transaction.

The important property is what happens when that **fails**: many wallets refuse
`eth_signTransaction`, and spDEX stops and asks rather than broadcasting
publicly under a label that promised privacy. A protection that silently does
nothing is worse than none, because the user sizes their trade believing they
have it.

Auto-buys keep the property without offering the fallback. A wallet-mode buy
that cannot be sent privately is skipped with that reason, even though somebody
has just clicked **Confirm buy**: the fallback prompt is kept for the swap
button. The runner does not enforce this itself. It depends on the page
building the runner's wallet sender with `onPublicFallback: () => false`, as
the runner's interface documents.

### A tip split that pays the wrong person

Tipping is a standing instruction to send a share of every swap to somebody
else, which is the shape of every attack on this page. It is defended as one.

No module composes a tip. A registry module answers "which address does this
name point at" — untrusted, exactly like a token list, and for the same reason —
but the user resolves that to an address *once*, when they pick someone (or
saves one of their own), and the **address** is what is written to their
config. A registry that changes its
mind later, or is swapped for a hostile one, cannot redirect a tip already
agreed to. The full address is shown next to the name at the moment of choosing,
because that is the moment it can still be checked.

The transfers themselves are built by the host and then checked by the Guard
anyway. "We wrote it" has never been grounds for skipping the check, and the
realistic threat here is not a malicious module but a bug in the host, a
corrupted config, or a hostile shared config link — which at the point of
signing are indistinguishable from malice, and the Guard does not need to tell
them apart.

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
| Pay a listed token, the vault factory or a venue's contract | `TIP_MALFORMED`, static, `known-contract` (the host's `refuseRecipients`) |

The ceiling is the part worth understanding. It is not configurable, so the
worst case from a bug or a hostile import is an annoyance rather than a loss —
5% of one swap, disclosed on screen before signing, with every recipient named.

Not defended: a recipient you chose is a recipient you chose. spDEX will not
stop you tipping someone who turns out not to deserve it, and the registry is
not a reputation system.

#### Who can be picked: the shipped list, "My tip list", and a settings link

Three things name an address, and the host decides from the address alone.
The tag a recipient carries (LISTED, MINE, UNLISTED, RETIRED) comes from
matching it against the list spDEX ships and this browser's own list, never
from what a config says about itself. One function, `tippableRecipients`,
decides who a swap pays; the transfers, the counts and the Tip row all take
its answer. What it skips is not sent, and its share is not handed to anyone
else.

- **Address poisoning.** An attacker sends dust from an address that starts
  and ends like one you use, hoping you copy theirs from your history. Every
  address is shown in full, checksummed, in groups of four, wherever it is
  chosen or confirmed. A new address that shares its first or last four hex
  digits with a listed, saved or chosen one is warned about before it is
  saved; both ends matching is a danger banner ("Looks like Maria's address but
  isn't"), and an imported file can't bring one in at all. A mixed-case paste
  must be its EIP-55 checksum. Names are cleaned of invisible and
  right-to-left characters, may not look like an address (full-width,
  Cyrillic and spaced-out disguises included), and are compared with
  lookalike letters folded, so "Example Artist" spelled with Cyrillic letters
  reads as the listed name it imitates: when typed, when a settings link
  gives it, and when a file brings it (an imported entry with a listed or
  saved name at another address is left out). The first tip to any address
  the shipped list doesn't vouch for waits on the Tip row until the person
  checks it, and that check shows the lookalike and name results again.
  Until the shipped list has been read, the page says it hasn't compared
  with it, rather than reporting no lookalike. An imported file's ENS names
  are dropped: nothing checked them against the addresses beside them.
- **ENS.** A name is read through the person's own network service only: the
  registry's resolver for that exact name, then its `addr`. CCIP-Read
  (`OffchainLookup`) would send the name, and the fact that this browser
  wants it, to a URL the resolver picks; wildcard resolution would let a
  parent's resolver answer for any subname. spDEX follows neither and asks
  for the address instead. The resolved address is shown in full before it
  is saved, and it is the address that is kept: the name is never looked up
  again, so a name that changes hands later cannot redirect a tip. The
  endpoint could lie about the answer, as it could about anything, and the
  Guard's test-run can't catch that lie: a transfer to the wrong address runs
  like one to the right address. With a second opinion set, the name and the
  code at the address are read through both services, and a name they point
  at different addresses is refused. Otherwise the full address, the
  lookalike check and the first-tip confirmation are what a person checks it
  against.
- **A malicious default in an app update.** An update is how a bad entry
  would arrive: a maintainer tricked, or the repository compromised. The
  list's tests hold every entry to a checksum, a unique id, ends unlike every
  other entry's, no public test account, and an https link to the person's own
  post of the address; a signed claim is checked offline against the address
  it names. None of that proves the person is who the list says. What limits
  the damage is that an update never changes a chosen recipient silently: an
  entry is retired and replaced, not edited, and a retired entry is skipped
  until the person chooses again after seeing why, with both addresses
  shown. A confirmation from before the retirement (the address saved in "My
  tip list" earlier, or stamped by the first load's migration) doesn't count.
  An entry edited in place to a new address would be a new address, and the
  Tip row would show it as such to anyone who picked it: the config holds the
  address that was picked, not the entry's name. The list's tests also hold
  every id to the address it first shipped with (`shipped-ids.json`,
  append-only), and refuse a token contract, Permit2, a router or another
  known contract as an entry. Whether to trust a new
  release at all is the question "Us" below answers.
- **"My tip list" is local only.** It lives in this browser's storage, not in
  the config, so settings files and share links carry the addresses you chose
  (labelled "My tip list") and never your names for them. Anything else that
  can read this site's storage can read it; so can anyone with the device.
  Clearing site data loses it; export is the backup, and the only way it
  leaves. A settings link that brings tip addresses lists each one with its
  full address and lookalike result before "Apply these settings", and those
  addresses still wait for the first-tip confirmation.

#### Batched tips: a signature, and a standing permission

Two or more recipients are paid in one transaction through Uniswap's Permit2:
you sign a `PermitBatchTransferFrom` (these amounts of this token, this nonce,
this deadline, you as spender), then send `permitTransferFrom` yourself. That
brings two things a plain transfer did not, and both are stated here rather
than implied away.

**The standing permission.** Permit2 can only move a token you have approved
it for, so the first batched tip asks for `approve(PERMIT2, max)` on that
token. It is unlimited, which is Permit2's convention, and it stays until you
revoke it (Settings → Tips → **Revoke**, which also stops any other app that uses
Permit2 with that token). It is asked for only in the course of a tip to two
or more people, and never on the static checks alone: without a simulation
the grant is refused and the tips go as separate transfers, whatever
`requireSimulation` says. It is asked for after the signature, not before:
the signature costs nothing and does not depend on the permission, and asking
for it first shows whether the wallet can sign typed data at all, so a wallet
that can't is never left holding a permission nothing will use. The Guard's
check of the permission still comes before the signature, so a grant it would
refuse costs no signature either.

**A signature left unused.** The order has a cost of its own, stated rather
than hidden: decline the permission and the signature you just gave is never
used. That is all it is. It moves nothing by itself, it names you as the only
spender, so only a transaction you send could spend it, and it expires within
20 minutes. The status says so. A permission can still be left unused too,
but only after a signature: when the batch then reverts for your account, the
Guard refuses it, or you decline it; the status says that, with where to
revoke it.

What stands behind it is not "a fresh signature for each spend". Permit2
moves the token for either of two things you give it. One is a signature (a
permit). The other is an allowance inside Permit2 itself, which a transaction
of yours can set with no signature (`Permit2.approve`), or one signed
`PermitSingle` can, and which then lets its spender pull again and again until
it expires. spDEX's own requests are only permits whose spender is you. Its
Guard refuses any plan that would set an allowance inside Permit2 (see "A
malicious module", above). It cannot see what other sites ask for.

**Which makes a signature worth as much as a transaction.** While the
permission stands, a valid Permit2 signature for that token is all anyone
needs to take the amounts it names: a permit whose spender is someone else lets
them move those amounts wherever they like, with no transaction from you, and
a signed allowance lets them keep doing it. This is the signature-phishing
risk every Permit2 user carries, and spDEX cannot remove it. It can see and
check only the requests it makes itself. A site that asks you for a Permit2
signature is asking to move your money, and a wallet that shows the spender,
the token and the amounts is showing you the whole of the promise.

**What Revoke does and does not do.** `approve(PERMIT2, 0)` stops Permit2
moving the token at all, for every app. It does not erase allowances held
inside Permit2, which other sites may have set up: they are useless while the
permission is gone, and work again, if they have not expired, the next time
it is given, which the next batched tip does. spDEX does not list them.

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

What the signature does not bind is who receives: Permit2 lets the spender
choose each amount's recipient when it sends the transaction. The spender is
you, so the recipients are fixed by the transaction you send, which the Guard
checks byte for byte and simulates, and which pays exactly the people in the
intent.

Not defended: a page that is not spDEX's, or a spDEX bundle that has been
tampered with, asking your wallet for a Permit2 signature. The Guard runs in
the page it guards (see "Us"), and nothing in a page can vet another site's
requests. The standing permission is what gives such a request its value, and
revoking it is the remedy.

### A standing order that keeps spending

An auto-buy plan is an instruction to spend the user's money on a schedule. A
tip has that shape once per swap; a plan repeats it until it ends. It is
defended the same way.

This section covers the plan a tab runs, which its owner confirms buy by buy
("Confirm each buy myself"). A vault plan ("Set and forget") has no
scheduler, no runner and no record in this browser: its vault enforces the
plan on chain. It has a section of its own, "An auto-buy vault", below.

A plan is set up in the Recurring tab and runs from its card under "Your
auto-buys". None of the defences below lives in those screens: each sits in
the scheduler, the host, the Guard or this browser's record. The screens call
into those and never sign or send anything themselves.

Nothing untrusted decides how much. The scheduler module is capability-free and
only proposes — which plan is due, for which window, for how much — and the host
refuses any proposal outside the plan before quoting it (`vetScheduleDecision`).
A scheduler that lies can make the app skip a buy or buy less. It cannot make it
spend more, more often, or anywhere else. Buying less is not free, though: the
host buys the amount proposed as it stands, so a scheduler proposing dust makes
each buy pay a whole network fee and use up one of the plan's buys.

The buy itself is then built by the host and checked by the Guard anyway,
through `ScheduledBuyGuard`: against the plan as the config states it and this
browser's record of what the plan has spent, and then every leg through the
ordinary swap Guard, unchanged, which must return `verified`. The realistic
threats are not only a lying scheduler but a bug in the host, a second tab, a
retry after a timeout, a corrupted record, and a config edited by hand or
imported with a plan in it — which at the point of signing are
indistinguishable, and the Guard does not need to tell them apart. The record
is written first: a buy's window and the most it may spend are claimed after a
signable verdict and before the first signature, so a crash costs a skipped
buy, never a second one in that window. The claim is given back only when spDEX
can tell nothing was bought, which takes the transaction's hash or, failing
that, a nonce. spDEX records the hash before broadcasting whenever it posts the
signed bytes itself, as it does for a buy sent privately. A wallet that
broadcasts a buy itself reports the hash only after sending it, so a claim also
records the owner's next nonce. A buy whose tab was lost before its hash
arrived is settled by that nonce: once the owner's account has used it, the buy
counts as made, whatever went out in its place, and it is given back only if
the nonce is still unused after the buy's deadline has passed on chain. The
record errs toward counting a buy the owner's wallet replaced with something
else, rather than missing one that was made.

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

The budget is the part worth understanding. Every plan ends, and the most it can
spend, `amountPerBuy × maxBuys`, is known before it starts. The Guard counts
against it everything *claimed*, at each buy's full `maxAmountIn`, rather than
what was measured afterwards, so a buy still in flight counts before it settles;
and a record it cannot read counts as spent, because a corrupted record that
read as zero would hand the plan its whole budget again. A record that is lost
outright is the weaker case. The plan stops, since there is nothing to check a
buy against, but starting it again writes a fresh record from zero — in this
browser as in a second one — and all that stands between the two is the
owner's deliberate act. The worst a bug, a lying scheduler or a hostile import
can do is spend the budget the user agreed to, one buy per window — and an
imported plan does not even start until its owner resumes it.

The plan keeps a person in every buy: the wallet never opens on a timer, and a
due buy waits for **Confirm buy**, then is quoted and checked at that click.
An oracle warning makes it ask again before it opens the wallet; the verdict
stays signable, because the oracle may never refuse (AGENTS.md, rule 2), and
"Buy anyway" goes ahead only if a fresh quote diverges no more than the one
the owner saw.

Not defended: the price of each buy. A scheduled buy is priced when it runs, by
the same endpoint and venues as a manual swap. The Guard proves the buy
receives at least its floor — the quote less your slippage tolerance — not that
the quote was a good price. The oracle cross-check warns only for pairs Uniswap
v3 has a time-weighted price for, and it reads through the same endpoint, so an
endpoint that lies about prices and simulations can make every buy a poor one,
up to the plan's budget. Nor are buys made while no spDEX tab is open: there is
no server, a window that passes unseen is skipped, and the plan ends later. And
the record lives in one browser: the same plan started in two browsers has two
records, and each can spend the whole budget.

### An auto-buy vault

A vault plan buys with no spDEX page open. Each buy is triggered by whoever
sends the transaction and paid for out of a contract that holds the plan's
budget. So the question is no longer what spDEX will sign, but what anyone can
make that contract do. The contracts are
`packages/vault/contracts/SpdexDcaVault.sol` and `SpdexVaultFactory.sol`, and
the batcher that keepers call them through, `SpdexVaultBatcher.sol` (its own
section follows this one). Their headers carry the full reasoning; this
section summarises it, with the figures the reviews measured. **None of them
has been audited.**

The vault trusts nobody who calls it. Its terms (the market, the amount per
buy, the interval, the number of buys, the start, the buy fee paid to whoever
triggers a buy, and the price allowance) are written into its code when it is
created, beside its owner, and can never change. Whoever calls `execute`
chooses only the moment, inside a window that is due. The amount, the token,
the recipient and the floor are the vault's. There is no admin, no upgrade, no
pause switch anyone else holds, and no fee but the buy fee to each buy's
caller.

On chain, whoever calls:

| It tries to | It is stopped by |
|---|---|
| Buy before the plan starts | `NotStarted` |
| Buy twice in one window, or twice in a row across a window's edge | `TooSoon`: one buy per window, and none sooner than half an interval after the last |
| Make up missed windows in a burst | `TooSoon`: the next buy is counted from the last one made, so a window nobody triggered is gone |
| Buy after the plan's last buy | `NoBuysLeft` |
| Buy when the vault holds less than one buy and its buy fee | `InsufficientBalance` |
| Buy at a poor price, through a sandwich or a pair pushed off the market | `PriceBelowFloor`: the owner must receive at least `amountPerBuy` at the pool's price (the better of its 10-minute average and its price now) less `maxSlippageBps` |
| Buy while the price reference is cheap to move | `OracleTooThin`: the pool needs at least 10 WETH of harmonic-mean depth over the ten minutes, checked at every buy |
| Send the tokens bought anywhere but the owner | Impossible by construction: the swap pays the owner written into the vault's code, and `execute` takes no arguments |
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
| Raise a vault's buy fee after it was created, or charge one it did not sign | Impossible by construction: the fee is written into the clone's code, and the only payment a buy makes besides the owner's tokens is that fee to its caller |
| Front-run a new vault's setup | There is no setup to front-run. The creating transaction writes the terms as it deploys the clone, and there is no initializer |
| Run code of the keeper's choosing when the buy fee is paid | The fee is a WETH transfer, never a raw ether call |

When the factory is deployed, listing a market:

| It tries to | It is stopped by |
|---|---|
| List an imitation pair | `PairNotFromUniswap`: it must be the pair Uniswap v2's factory lists for WETH and the token |
| List an imitation pool, or a genuine pool under a fee tier it does not have | `PoolNotFromUniswap`: it must be the pool Uniswap v3's factory lists for WETH, the token and the pool's own fee tier |
| List a pool whose history one trade can overwrite | `OracleHistoryTooShort`: it must keep at least 100 observations |
| List a pool that cannot answer a ten-minute average | `OracleUnavailable` |
| List an empty or thin pool, whose average anyone can set | `OracleTooThin`: at least 10 WETH of depth |
| List a pool that is not the same market as the pair | `MarketsDisagree`: its average must be within 2% of the pair's mid price |
| List WETH itself, the zero address, one token twice, or nothing at all, or pass an address with no code as Uniswap's factory | `InvalidToken`, `DuplicateMarket`, `NoMarkets`, `NotAUniswapFactory` |

The owner's wallet signs four transactions around a vault: create, fund,
close and **Trigger now**. All four go through `VaultGuard`, for the same
reason tips do:

| It tries to | It is stopped by |
|---|---|
| Create at any address but the factory the app computed from its code and market list | `VAULT_MALFORMED`, static |
| Create with terms other than the plan's, on a market the factory does not list, or with terms the factory would refuse | `VAULT_MALFORMED`, static, named before anyone pays gas to hear the factory say it |
| Create with a buy fee above the ceiling — a draft sized under an older rule, terms from a link, a bug | `VAULT_MALFORMED`, static, by name and figure: the fee may be at most 0.69% of the buy, the network cost included (`withinFeeCeiling`). The factory would refuse it too (`MAX_REWARD_BPS`), so no vault it vouches for pays more. Creations only: funding, closing or triggering an existing vault is never refused for its fee, which would trap its owner |
| Send more than the plan's whole budget with a creation | `VAULT_MALFORMED`, static |
| Create a second vault for a plan that already has one, or build any vault transaction for another chain | `VAULT_MALFORMED` and `CHAIN_MISMATCH`, static |
| Pass off a creation that makes some other vault: for someone else, with other terms or on another market, at another address, or announced by a look-alike contract rather than the factory | `VAULT_MALFORMED`, simulated. There must be exactly one `VaultCreated`, emitted by the factory (`vaultsCreatedBy`), not just any log shaped like one |
| Have a creation's ether not arrive in the vault as WETH | `VAULT_NOT_DELIVERED`, simulated |
| Fund, close or trigger a vault that is not the factory's vault for this owner on these terms | `VAULT_MALFORMED`, static. The address is recomputed from owner, nonce and terms, so a lie in any of them changes it, and nothing read over the network is believed |
| Fund or close someone else's vault | `VAULT_MALFORMED`, static |
| Fund or trigger a vault whose terms differ from the plan | `VAULT_MALFORMED`, static. Closing is allowed anyway, because it only ever returns the owner's money |
| Fund more than the remaining buys need | `VAULT_MALFORMED`, static |
| Attach ether to a close or a trigger | `VAULT_MALFORMED`, static |
| Have a close pay the account less than the vault gave up, or pay anyone else | `VAULT_NOT_DELIVERED`, simulated |
| Have a trigger deliver less than the floor read just before, pay the caller less than the buy fee, credit the fee to someone else, or make no buy or two | `VAULT_NOT_DELIVERED` or `VAULT_MALFORMED`, simulated |
| Move anything else out of the account, or grant an allowance | `UNEXPECTED_ETH_TRANSFER`, `UNEXPECTED_TOKEN_TRANSFER`, `UNEXPECTED_APPROVAL`, simulated |
| Send ether on a check that could not run | `SIMULATION_UNAVAILABLE`. A creation that funds, and a funding, are refused unless simulated, whatever `requireSimulation` says, because ether sent to an address with no code yet is lost. A close or a trigger follows the setting, so an endpoint that cannot simulate never keeps an owner from their own money |

**The floor is the part worth understanding.** It is everything a keeper can
do to the owner's price, so it is worth being exact about.

A hostile keeper chooses the moment inside a due window, and can sandwich the
buy: push the pair's price up to just inside the floor, let the buy land, then
sell back. The floor is `maxSlippageBps` below the pool's price, meaning the
better, for the owner, of its 10-minute average and its price now. No fee is
taken off that price, so the pair's 0.3% fee sits inside the allowance rather
than on top of it. The owner can therefore receive as little as the pool's
price less the allowance, and never less.

Measured against what an honest buy would have received, a sandwich can take
the allowance less what an honest buy pays anyway (the pair's fee and the buy's
own price impact). It can also take however far the pair was quoting better
than the pool. That gap is either the real market moving in the owner's favour
before the pool caught up, or someone moving the pair.

Whether a sandwich pays the keeper is another matter. The front-run pays the
pair's 0.3% fee going in and again coming out. At the pinned block SPX's pair
held about 2,500 WETH. Sandwiching the largest buy the cap allows (0.45 ETH on
a 5% allowance) left the sandwicher about 0.29 ETH down, buy fee included,
while still costing the owner at least 3% of that buy
(`test_sandwichingTheLargestAllowedSpxBuyLosesMoney`). The break-even is a buy
of about 0.3% of the pair's WETH. So on SPX's pair the fee protects the owner
from sandwiches run for profit, but not from a keeper willing to lose money to
cost the owner the allowance. The app offers 1%, 2% or 3%, not 5%.

The other lever is the price reference itself, and the oracle pool is much
thinner than the pair: SPX's 0.3% pool held about 30 WETH and 254,000 SPX at
the pinned block.

- **The push.** Holding the pool 16,000 ticks away across one block boundary
  (12 seconds) moves its 10-minute average by about 3.25%. That is enough to
  refuse every buy on a 3% allowance for ten minutes
  (`test_oneBlockOnTheOraclePoolRefusesEveryBuyForTenMinutes`).
- **Its cost.** About 0.17 ETH for a searcher who holds both block positions,
  and about 18 ETH if an arbitrageur takes the reversal.
- **The other direction.** The same push the other way lowers the floor, which
  pays only through a sandwich on the deep pair, above.
- **The cheapest lever: the price now.** The floor takes the better, for the
  owner, of the average and the pool's price now. So pushing the price now the
  owner's way (SPX into the pool) raises the floor inside the same block, with
  no boundary to hold. Anyone who orders transactions around a public
  `execute` can push before it and swap back after. At the pinned block,
  refusing a buy on a 3% allowance takes about 275 ticks and 0.75 WETH through
  the pool, and costs about 0.0045 ETH for the round trip, the pool's fee both
  ways (`test_pushingThePoolsPriceNowRefusesABuyForItsFeesAlone`). It refuses
  one buy, not ten minutes of them, and moves none of the owner's money: the
  same window buys once the push is undone. The keeper simulates first, so a
  push has to land between its simulation and its batch, which through a
  private relay only the block's builder can arrange. A refusal the keeper
  paid for rests that vault ten minutes, and after two in one window it waits
  for the next, so a window is lost only to someone who pays for the push each
  time, about 0.0045 ETH a push. One push refuses every vault on the pool in
  that batch at once ("The batcher", below).

So on SPX the realistic harm from moving the price reference is skipped
windows, not lost funds. The header's figures are asserted, not only printed
(`Review1.t.sol`), so a change that moved them fails. Depth and history are what make even that cost anything. A pool
keeping fewer than 100 observations could have its history overwritten by one
trade, and a pool with no depth could be moved for free. The factory refused
both when it listed the pool, and every buy checks depth again. A vault's
`status().due` includes that depth check, along with every other check
`execute` makes except the price floor. So a thin pool reads as "not due",
never as a trigger that can only revert. The floor is left to `quote()`,
because it changes with every trade.

The pool and pair were checked against each other once, when the list was
fixed, and never again: a vault that refused to buy while they disagreed could
be refused by anyone willing to move the pair in the same block. While they
disagree, the floor shifts by the gap:

- **The pool quotes more SPX per WETH.** The floor is stricter against the
  pair, and a buy waits if the gap is larger than its allowance less the
  pair's 0.3% fee (the lever above pins this direction).
- **The pool quotes fewer.** The floor is looser, and buys go ahead
  (`test_r5b_buysContinueWhileThePoolAndPairDisagreeBeyondTheListingGap`).

The cap limits deposits, not holdings. Anyone can send a vault WETH, and ether
or WETH sent to its address before it exists is there when it appears
(`test_r5b_aPredictedAddressCanBeFundedBeforeItExists`). `close` returns all of
it to the owner, and the Guard never assumes a vault holds 0.5 ETH or less.

**A hostile vault, to a keeper.** The vault is safe for its owner whoever calls
it. The reverse needs care, because a token's code runs inside every buy, in a
transaction the keeper pays for. The phase-5a review built a vault whose token
spends a little gas in a simulation and all of it in a mined transaction
(`test_aHostileVaultPassesSimulationThenBurnsTheKeepersGas`). A vault the
factory made cannot be given such a token, because it can only buy on a listed
market. So the keeper:

- triggers only vaults a listed factory vouches for, found in the factory's
  own list, and the batcher asks `isVault` again on chain before each call;
- gives each vault exactly 400,000 gas, through the batcher, whatever it asks
  for;
- simulates each batch at the fees it will pay, and drops the vaults that
  refuse;
- after a batch is mined, reads what each vault did. A vault whose buy used at
  least half its cap and bought nothing is trapped: left alone for a week of
  chain time, or until a new batcher or cap, and only on that evidence from
  chain, never from a simulation. A buy refused early rests ten minutes (at
  most twice a window), and one that another transaction bought first is
  tried again when it is next due.

The factory's one-time deployment can be spoiled by anyone who moves the pair
in the same block, so that pool and pair disagree. Each spoiled attempt costs
them the pair's fee both ways and costs the deployer one early revert's gas,
and sending it again succeeds.

Not defended: **the code itself.** The contracts are unaudited, and a bug in
them could lose what a vault holds. The 0.5 ETH cap is what makes that a loss
a person can decide to accept. It is per vault, and nothing stops one account
from creating several. A vault cannot be patched. A fix is a new factory, and
existing vaults keep their code until their owners close them.

Not defended: **buys nobody triggers.** No keeper is promised. A window nobody
triggers is skipped, and the plan ends later. The buy fee is one batched buy's
network cost and a tenth more, never above 0.69% of the buy, so every buy
depends on keepers that batch many vaults into one transaction at a cheap
block, or that choose to pay the difference, and none is promised to. Below
about 0.00292 ETH a buy the fee is less still, and below about 0.00147 ETH it
does not cover even a batched buy at a cheap block. The form says both.

Not defended: **a keeper's timing, and a sandwich within the allowance,** as
above. That can happen on every buy, from a keeper willing to lose money doing
it.

Not defended: **skipped windows.** Anyone who moves the pool's average, drains
its depth, or pushes pool and pair apart can make buys wait, and anyone who
orders transactions around a trigger can refuse that one buy for about 0.0045
ETH by pushing the pool's price now (above). Nothing is lost.
A block producer can also nudge a block's timestamp by seconds, which moves a
buy within its window and never adds one.

Not defended: **an endpoint that lies.** The app reads a vault's figures, and
simulates the owner's four transactions, through the owner's own endpoint,
which can lie about both, as it can for a swap. The vault's own rules do not
depend on it: no endpoint can change a vault's terms, redirect a buy or move
its funds. An endpoint that lies about whether the factory exists could,
though, have a creation's ether sent to an address with no code, where it
would be lost.

Not defended: **the token.** Markets are checked by the factory, but tokens
are vetted by hand, and mainnet's list is SPX alone. A malicious token is out
of scope here, as it is everywhere (below).

Partly defended: **forgetting the plan.** A vault goes on buying whether or
not any browser remembers it, so a vault the config lost (a card deleted,
settings replaced or wiped, a new browser) must not be a vault spDEX can no
longer show or close. The chain remembers it. With a wallet
connected where vaults are offered, the app asks the factory how many vaults
the account has created (`nonces(owner)`, one per creation), then reads the
factory's `VaultCreated` logs, whose first indexed topic is the owner, newest
first, until every one it counted is accounted for (`findVaultsByOwner`). It
lists those no plan points at under "Vaults on chain not in your plans", each
with **Add back to my plans** and **Close and withdraw**.

- **Only the factory's own logs.** Each log is checked for its emitter and its
  owner rather than trusted for matching the query, because any contract can
  emit an event with `VaultCreated`'s signature, and an endpoint can ignore a
  topic filter. Each vault found is then read with the factory's `isVault`, as
  a plan's vault is.
- **The same Guard.** Closing one sends the close a plan's card sends, held by
  `VaultGuard` to the plan the vault's own terms describe (`planFromVault`):
  the vault proved the factory's and the account's by its address, the call
  byte for byte, the ether back to the account only. Adding one back writes
  that plan (paused, its vault set, its terms fixed) through `addDcaPlan`, and
  sends nothing.
- **Counted and searched at one block.** The count is read again at the
  block the logs are read to. Read at a later block than the logs, it would
  include a vault the logs can't show yet; read at an earlier one, it would
  miss one they do show. Either way a newer vault would stand in for an older
  one the search never reached, and the search would call itself complete
  with a vault missing.
- **What the page already shows counts, if its address proves it.** A plan's
  vault, or one carried over from a deleted card, counts toward the count
  once `findVaultNonce` finds the nonce below the count that puts the
  account's vault, with the terms read, at its address. A vault made after
  the count was read is the account's too, but has a nonce at or above it,
  so it can't stand in for an older one. When the plans already cover the
  count, the search reads no log at all.
- **Bounded, and says so.** Hosted endpoints cap log ranges, so the search
  narrows its window on a refusal, reads nothing before block 26,000,001 (no
  factory built from this repository can be older: its code was written
  against a fork of the block before), and stops after 40 queries. On an
  endpoint that answers ten blocks at a time that reaches back about an hour.
  The factory's count is the chain's, so a search cut short knows how many
  the page doesn't show, and says "k of your N vaults aren't shown here", and
  why, rather than showing fewer as all of them. A search that failed, or
  read no log at all, is tried again a few times over about fifteen minutes;
  one that still fails then says so rather than looking like no vaults.
- **Adding one back proves it first.** The plan written is the vault's own
  terms, and before writing it the app checks that its address is the
  account's vault on exactly those terms (`vaultClaim`), the proof a close
  or a funding makes before anything is sent.

Not defended: an endpoint that lies can hide a vault from the search, and the
count with it. It cannot make another contract pass for one of the owner's
vaults: `isVault` and the Guard's proof by address stand between a fabricated
log and any transaction. And the search finds only the connected wallet's
vaults, as far back as the endpoint lets it. So a replacement of the whole
config (Reset, an imported file, a shared link) still keeps every vault plan
whose vault may still hold money or buy, and one pointed at another vault or
at none keeps the vault it has (`keepVaultPlans`); the prompt names each.
Deleting one card is the person's own choice, after a warning that says the
vault stays on chain and that spDEX finds it again only by searching. The
vault's address is also in the config (export it), and closing it needs only
the owner's wallet calling `close()`, from any tool.

### The batcher

`SpdexVaultBatcher` lets a keeper trigger many due buys in one transaction:
`executeBatch(vaults, rewardTo, minRewards)` calls `execute` on each vault its
factory vouches for and passes every buy fee on to `rewardTo`. It has no owner,
fee, setter or storage but a transient lock, and it is one more caller of each
vault, with no rights a direct caller lacks: every vault still enforces its
own terms. So the question is what a caller, or a vault, can make the batcher
do. **It is unaudited, like the vault.**

| It tries to | It is stopped by |
|---|---|
| Re-enter the batcher from inside a vault's buy and sweep the fees collected so far to another `rewardTo` | `Reentrancy`: a transient lock held for the whole call, its reverts included (`test_reenteringTheBatcherIsRefusedAndStealsNothing`) |
| Have it call a vault the factory did not make | Skipped with no call made: `NotTriggered(vault, NotFromFactory, 0)`, from the factory's own `isVault`, read on chain |
| Burn the batch's gas through one hostile vault | Each vault gets exactly `EXECUTE_GAS_CAP` (400,000) and no more. A vault is attempted only while `MIN_GAS_PER_ATTEMPT` (460,000) is left, enough for the whole cap after the EVM's 1/64 and to finish the batch, even when the last attempt burns its cap and the fees go to a fresh address (`test_theBatchFinishesWhenTheLastAttemptBurnsTheCap`) |
| Return-bomb it with a huge revert | Only 4 bytes of a revert and 32 of a success are copied; a 256 KB revert costs the batch what a 4-byte one does (`test_aHugeRevertIsNotCopied`) |
| Pass off a success with no return value as a buy | `EmptyReturn`: not counted as bought |
| Buy one vault twice by listing it twice | The vault's own `TooSoon` refuses the second |
| Count WETH someone sent the batcher as earned | Reported apart, as `swept`, and passed on with the fees; only `earned`, what arrived during the call, counts toward `minRewards` or as revenue in the report |
| Leave value in the batcher between calls | Every wei of WETH it holds at the end goes to `rewardTo`; it has no `receive`, so ether sent to it reverts, and it never makes a raw ether call |
| Pay the fees to itself or to nobody | `BadRewardTo` |
| Call more vaults than a transaction can hold | `TooManyVaults` above 150 |
| Report a vault it ran out of gas for as failed | `NotTried`: not attempted, no event, retried by the keeper on its next tick, and `Batch.listed − tried` says how many |

What a public batch invites, and what bounds it:

- **A copied batch.** Anyone watching the public mempool can copy a batch and
  take its fees; the original then reverts `NothingBought`, or lands smaller.
  Private, revert-protected orderflow prevents it, and costs nothing when a
  race is lost. Without it the keeper warns at start.
- **A partial race.** Another keeper, or an owner's Trigger now, takes the
  best vaults first, and the batch lands carrying only the ones that cost more
  than they pay. On a private send `minRewards` reverts it instead (`TooLittle`),
  and the relay drops it. On a public send a revert costs the gas anyway, so
  the keeper sends `minRewards` of 0.
- **An aggregate sandwich.** A public batch's buys on one pair add up, and
  what a sandwich can make grows with the total `amountIn`, not each buy's.
  Try/catch makes it worse: a vault with a loose floor buys at the worst price
  its floor allows while one with a tight floor refuses, where before the
  whole transaction would have reverted. The keeper caps each pair's total in
  one public batch at 0.1% of the pair's WETH (about 2.5 WETH on SPX's pair at
  the pinned block), and private orderflow keeps the batch out of sight.
- **One push refuses a whole batch.** The push on the pool's price now that
  refuses one buy for about 0.0045 ETH ("An auto-buy vault", above) refuses
  every vault on that pool in the batch at once. Each is retried ten minutes
  later, at most twice a window; nothing moves but the pusher's fees.
- **Order inside a batch.** Which vault buys first is sub-block timing the
  batch's caller chooses, and a later buy pays for an earlier one's price
  impact. The keeper puts the smallest buys first. The floor still holds for
  every one of them.

Not defended: the batcher's code. It is unaudited. It never holds anything
between calls and has no rights over any vault, so a bug in it can cost a
batch's fees or a keeper's gas, not what a vault holds; a batcher with a bug is
replaced by a new one at a new address, beside the old in `deployments.json`.

### Helping run the network: a batch from your own wallet

Collective DCA can offer a batch of other people's due vault buys, made in one
transaction from the person's own wallet through the batcher, with the buy
fees paid to that wallet. It is a fifth vault transaction the host composes,
checked by `VaultGuard` like the other four (`action: "batch"`), and the
wallet is asked only for a batch the Guard verified, checked again when the
button is pressed. The vaults are strangers', and nothing about them is
trusted: what the batch does is what the Guard's test-run of the exact call
shows.

| Something tries to | What stops it |
|---|---|
| Have a bot copy the batch and take its fees first | Offered only with private sending, and never falls back to a public send: a batch copied from the public mempool leaves the original to fail and still pay its network fee. With public sending the panel says why it offers nothing |
| Offer a batch that costs more than it pays | Offered only when the test-run's fees reach `minRewards` = the test-run's gas × 1.1 × the gas price that is signed, read once; `minRewards` goes on chain, so a batch that would earn less reverts rather than pays less. The Guard checks it again against its own test-run of the final call: `minRewards` below that run's gas × the signed price is `VAULT_NOT_DELIVERED`, and with a second opinion the gas is the larger of the two services' figures. The gas price itself is the main service's, and nothing bounds it but that check: without a second opinion, a main service that understates the gas and overstates the price together can still make a batch cost more than it earns, as it can fake any test-run |
| Send it to a look-alike batcher, or pay the fees to someone else | Static checks: exactly one call, to the batcher computed from the factory's address (never read from anywhere), with `value` 0, calldata byte-equal to a fresh encoding of the vault list, `rewardTo` the account and `minRewards` at least 1 (`VAULT_MALFORMED`) |
| Sign at another gas limit or price than the one checked | The call's gas and price must equal the intent's, and the gas limit must lie between what the vaults need and 16,000,000; the wallet signs exactly that limit, with no estimate taken |
| Pass on WETH someone sent the batcher | `VAULT_BATCH_UNACCOUNTED`: spDEX won't make you the receiver of money it can't account for |
| Take anything from the account, or have it grant a permission | `UNEXPECTED_*`: nothing leaves the account and no allowance is granted; its WETH must rise by at least the `Batch` event's `earned` |
| Misreport what the vaults did | Exactly one `Batch`, from the batcher, naming the account as caller; every listed vault reports `Triggered` or `NotTriggered`, none `NotFromFactory` or left untried; each `Triggered` follows that vault's own `Bought` with the batcher as its keeper, its floor kept, and the vault losing exactly the buy and its fee |
| Fake the test-run | Never signed unverified: an unavailable test-run refuses it whatever `requireSimulation` says, and so does a second opinion that doesn't answer, or disagrees |

What it costs the person, said before they press the button: the network fee
(the most their wallet can show is the gas limit × the price, since each vault
is given room to run); their address becomes public as the one who made the
buys; checking which buys are due test-runs a batch from their address on
their own service, so this panel asks nothing about their address until they
press it. A wallet that can't sign without broadcasting (`eth_signTransaction`)
can't help, and is told so before anything is sent.

Not defended:

- **Losing the race.** Someone may make the same buys first. The batch then
  buys nothing; a relay that includes failing transactions charges its network
  fee (the panel says which kind of relay it is), one that doesn't charges
  nothing.
- **The relay.** A private relay sees the batch before it lands, as it sees
  any private swap; spDEX trusts the one the person chose, as it does for
  swaps.
- **The vaults' own buys.** Each vault's floor bounds its price, as for any
  keeper ("An auto-buy vault", above); the helper chooses only when.

### A keeper and its hot key

A keeper is software anyone runs, not part of the app, and nobody promises to
run one. What it guards is its operator's own: a hot key with ether for gas,
and the buy fees it earns. spDEX's developers may run one during the beta, as
anyone may. `docs/KEEPER.md` is the operator's guide; this is what the keeper
distrusts, and why.

| Threat | What bounds it |
|---|---|
| The hot key is stolen | It holds only gas money: the operator sets a cold `SPDEX_KEEPER_REWARD_TO`, and every batch pays its fees there in the same transaction. The key file is read once, at start, and a warning names group- or world-readable permissions |
| A bug, or a lying endpoint, gets the key to sign something else | `assertKeeperMaySign`, right before every signature: only `executeBatch` to a listed batcher paying the configured `rewardTo`, a listed batcher's deployment, a 0-value empty cancel to itself, and a WETH unwrap when it is its own `rewardTo`, none carrying ether. Anything else throws, and each near-miss has a unit test |
| A lying endpoint makes it overpay | The gas limit is the keeper's own figure, never `eth_estimateGas`; `maxFeePerGas` is capped (3 gwei by default); the worst a lying endpoint can cost is `gasLimit × maxFeePerGas` a batch, about 0.0054 ETH for ten vaults at the cap |
| A lying endpoint makes it trigger something hostile | It triggers only vaults a listed factory's own list names, the batcher checks `isVault` on chain, and each attempt is capped at 400,000 gas |
| A stale or rewound head | A head older than `SPDEX_KEEPER_MAX_HEAD_LAG_SECONDS`, or behind one already seen, sends nothing that tick and says so |
| Two processes signing with one key | A lease file taken for every mode that can sign; a second signer exits naming the holder. Two machines on one key are unsupported: a standby keeper uses its own key |
| A crash between signing and broadcasting | The signed transaction is written to the state file first, so a restart finishes or replaces it at the same nonce |
| A tampered, foreign or newer state file | Refused at start, naming the field (chain, key, releases); `--reset-state` moves it aside, never deletes it |
| Secrets in its logs | Typed fields are validated and never redacted; free text is redacted of the key, in every form, of every configured URL and its long segments, and of anything shaped like a URL or a 64-digit hex string. The endpoint's URL is never printed |
| Griefing its subsidy with dust vaults | No subsidy by default. An operator who offers one pays it only for vaults that pay the fee spDEX proposes for their size, by default only for buys of at least 0.0003 ETH on plans at least an hour apart, oldest vaults first, so a flood of new vaults cannot crowd out older ones. Each vault is booked at most its own shortfall and only within its own caps per buy, per vault and per owner each day, never on another vault's allowance; a breaker stops all subsidy once a day's realised losses reach its cap. A per-owner cap alone would not stop a sybil, and is not relied on |
| A mempool copier, a partial race, a sandwich | "The batcher", above |

Not defended: a keeper's timing. Inside a due window the keeper, any keeper,
chooses the moment, and could sandwich within the allowance ("An auto-buy
vault", above). Not defended either: a keeper's losses from its own model — a
block dearer than planned. The breaker bounds them; nothing removes them.

**What the report can and cannot know.** `pnpm keeper:report` is read-only: it
signs nothing and contacts only the endpoint its operator configures. Its
figures are public chain data and the operator's own logs, so they are as
honest as that endpoint and those logs. It reads to `finalized` by default, so
a reorganised block cannot put a buy in it that did not happen; it checks
itself — every vault's `buyNumber` without gaps, every batch's `earned`
against the fees of its buys — and lists what it could not read as unknown,
never as zero. It cannot know anything the app does not put on chain, by
design: who uses the app, what they tried and abandoned, which frontend made
a vault. Those are not recorded anywhere, which is the point (AGENTS.md,
rule 4).

### A lying tracker

A tracker reports what is in a pool. It cannot propose a transaction, is never
consulted when one is built, and nothing it returns reaches the Guard — so a
malicious one costs the user a **bad decision**, not a bad swap. That is a real
harm and a smaller one, and the design leans on the difference: a tracker is
allowed to be wrong in ways a venue is not.

What bounds it is the same capability model as everything else. The shipped
tracker declares three token contracts and reads `balanceOf` on them; it cannot
reach anything else, and the parity gate asserts both runtimes refuse an
undeclared read identically. What it cannot do is inflate a figure it was not
given — the numbers come from token contracts, and a tracker that returned
something else would be disagreeing with the chain rather than with us.

Not defended: a tracker that reports a pool as deeper than it is, to steer you
into it. The mitigation is that routing does not consult it — the router quotes
pools directly — so the worst case is a user choosing a pool by hand on bad
information. Pool statistics are a display, and the app treats them as one.

### A wrong price for money

spDEX shows money in two places, and trusts rates differently in each.

- **As a display:** every "≈" figure, a buy fee's worth, a pool's TVL. A wrong
  rate here costs a bad decision, like a lying tracker, and is bounded the same
  way: nothing that decides a route or a signature reads it.
- **As an input aid:** an amount typed in dollars or another currency becomes
  the token amount that is quoted, saved and signed. Typing an amount in a currency makes the amount you sign depend on your network service's answers (the 10-minute average; Chainlink for currencies other than USD). The token amount on screen is the check.

The rates are spDEX's 10-minute average price for dollars, the same oracle the
Guard cross-checks swaps against, and Chainlink's dollar price of each other
currency, all read through the person's own network service. What bounds a
wrong one:

- **The token amount is what is signed, and it is always shown.** The field
  says the token amount under the money as it is typed, every confirm line
  leads with it, and the money is named as what was typed, never echoed back
  through the same rate as if that confirmed anything. The quote, the Guard
  and the wallet see only the token amount, and the Guard still holds the
  swap to it: a wrong rate can make someone spend more ETH than they meant,
  and never makes a swap deliver less than it says.
- **Sized once, from a fresh price, in its own currency.** A money amount is
  sized against one read and kept with it; a background refresh never sizes it
  again, and a newer price is offered, not applied. Nothing is quoted or
  started from a dollar price more than 5 minutes old by the tab's own clock,
  or read before the tab was last hidden. An amount in euros needs a valid
  euro answer from that same read, and is refused without one, never sized as
  dollars.
- **Implausible answers are unknown.** A currency answer counts as unknown
  when it is zero or less, never updated, more than five days old by chain
  time, of decimals other than the feed's (read in the same call, so a
  repointed proxy can't scale an amount by 10¹⁰), or outside 0.2× to 5× of its
  answer at release. Ether's own dollar rate, spDEX's 10-minute average, is
  held to the same band around the ETH/USD feed's answer at release
  (`ETH_USD_REFERENCE`), and, when the page's currency read brought an ETH/USD
  answer at most three hours old, to within 10% of it, so a pushed average
  can't size "$20" as any amount of ether. Unknown refuses typing in that
  currency, and a display falls back to dollars with a note, never to zero.
- **A plan is its token amount.** A plan typed as $20 saves the ETH that came
  to, and no rate re-sizes it at a later buy.

Not defended:

- **A network service that lies consistently.** It answers both the average
  and the Chainlink reads, so it can make $20 come to more ETH than $20 is
  worth, as it can fake a simulation. With a second opinion set, money is
  sized only from rates both services agree on to within 1% ("A second
  opinion", above); without one, or when the second doesn't answer, nothing
  cross-checks these answers. The token amount on screen is the check.
- **Chainlink itself, within the band.** spDEX trusts the feeds' operators for
  currency rates; a feed that moves inside 0.2× to 5× of its reference isn't
  caught. The references are refreshed at each release, and a currency that
  drifts out of its band legitimately (the peso is the likeliest) reads as
  unavailable until then.
- **USDC off its dollar.** USDC is counted as exactly $1, as everywhere in
  spDEX. A note says so when Chainlink's USDC/USD answer is more than 1% away;
  it never refuses anything.

### Sharing what you did: the CSV, the statement and the card

Your activity's CSV and printed statement, and the "I bought" card, are made
in the page and handed to the person as files. Nothing is uploaded. What they
reveal is the person's choice to share, and the app says what that is before
the file is saved.

- **An address and its history.** The CSV and the statement list the address
  and every transaction hash, and the card prints a hash, which leads to the
  address that sent it and everything else that address has done. Both warn
  before saving. The card prints the address only when asked, since the hash
  finds it anyway.
- **Formulas in a spreadsheet.** Plan names are anyone's text and arrive in
  shared settings links, so any cell a spreadsheet would run as a formula (one
  starting with `=`, `+`, `-`, `@`, a tab or a line break) is written with a
  leading `'`, and every cell is quoted as RFC 4180 says.
- **Markup in the card.** The caption is JSX, so React escapes it, and the
  PNG is that same mounted SVG drawn onto a canvas from a `data:` URL: no
  string of markup is ever built from it, and no remote font or image is
  loaded.
- **A card is a claim, and its link checks it.** A card can be edited or
  made up by anyone, so a `#receipt=` link trusts nothing on it. It reads the
  transaction through the viewer's own network service, counts only `Transfer`
  logs the SPX contract emitted, and calls SPX "bought" only as far as a
  market's swap paid it out: from a pool spDEX itself discovers for SPX, net
  of what went back to that pool, and capped by the pool's own `Swap` logs, so
  a dust swap can't vouch for a large transfer beside it. A vault the factory
  vouches for is named when it made the buy. SPX from anyone else is
  "received from … (an account)", and a pool's payout without a swap is said
  to be not a purchase. It can't show who made the card, and says so. The viewer's service learns which
  transaction was looked up.
- **Scams that follow a posted buy.** The card says under its buttons that
  nobody from spDEX or SPX6900 will message first, and that anyone offering
  "help" after seeing it wants the SPX.
- **A calendar file** carries the pair, the amount and the plan's name, and no
  address, key or hash, since calendars are often synced to someone else's
  servers. The name is escaped as RFC 5545 says and stripped of other control
  characters, so a hostile one can't add an event or an attachment.

Not defended: what happens to a file after it is saved. A CSV emailed to an
accountant, or a card posted with its hash, links that address to that
person for good.

### An account that does not keep what it is paid

EIP-7702 lets an address run somebody else's code whenever it is *called*,
which includes being paid. Legitimate and increasingly common — and also how a
compromised key becomes a sweeper, forwarding any ether that arrives in the
same transaction.

The Guard needs no special case for this, because it never asks what *should*
happen. It measures the recipient's balance after simulation, so a swept payout
produces `RECIPIENT_MISMATCH` and is refused before signing. That is the
general property paying off: the check is on the outcome, not on the mechanism.

spDEX additionally warns on connect, because "the recipient receives nothing"
about your own address reads as a bug in the app rather than a fact about your
wallet.

Worth knowing concretely: **every anvil development account has one of these on
real mainnet.** Their keys are published, so bots delegated them to a sweeper
long ago, and a mainnet fork inherits that state. See `docs/TRY-IT.md`.

### A malicious token contract

**Out of scope, and the most important thing on this page.**

The Guard derives what moved from ERC-20 `Transfer` events. A token that moves
balances without emitting them produces a delta of zero, which fails
`MIN_OUT_NOT_MET` — so a *quiet* token fails closed. But a token contract that
drains a balance through a path it does not log, or that behaves differently
after the simulation, is not something a transaction-level check can catch. The
token is the thing being measured; it cannot also be the measuring instrument.

This is why the token list is a user-controlled module rather than a fixed list
blessed by us, and why the shipped list has three entries whose decimals were
read on-chain rather than three hundred nobody checked.

### Us

spDEX has no admin key, no protocol fee, no governance token, and no contract
anyone controls. Its swaps go through no contract of its own. The auto-buy
vault, its factory and the batcher have no owner, no upgrade and no pause, so
nobody, us included, can change a vault's terms, its buy fee, or its funds.
There is nothing to rug because there is nothing to upgrade. There is still
unaudited code to trust, which is a different risk (see "An auto-buy vault").

The tip list includes our own donation vault, as a builder entry held to the
same rules as anyone's, except that its evidence is this source rather than
an outside post: the app names it from a constant it ships, so no list can
make another address look like ours. It is never chosen for you: tips are off
until you pick a share and who gets it, and no preset names a recipient.

We may run a keeper, during the beta or after it, and like any keeper collect
the buy fees on the buys it triggers; the app says so where it states the fee.
Like any keeper, ours could choose the moment of a due buy and sandwich it
within the allowance. Fees are fixed per vault when it is created, and nothing
we change, a new release's default included, reaches an existing vault.

What we *could* do is ship a malicious bundle. It could ask your wallet to sign
anything, as it always could, including a vault creation on a factory of its
own or with a larger fee. It could not take what an existing vault holds. Only the owner's own `close` returns that, and it pays only the
owner. The defences are that the app is a static bundle with a reproducible
build — two builds from the same source produce the same IPFS address, which
`pnpm verify` checks — and that it is AGPL, so the source of whatever you are
running is the source you can read. Pin a CID you have verified and no future
release can reach you.

## What is explicitly *not* defended

- **A compromised browser or wallet.** Game over, and nothing in a web page
  changes that. The same goes for anything else that can run script on
  spDEX's page — a malicious extension, for one.
- **A malicious token, per above.**
- **A Permit2 signature or approval asked for by another site,** for a token
  you have given Permit2 the standing permission on. Given, it can move what
  it allows with no further transaction from you, and an allowance can do so
  again and again. spDEX sees only its own requests; the permission is
  revocable in Settings → Tips, which does not erase allowances held inside
  Permit2 (they work again if the permission is given again).
- **An endpoint that lies about simulation,** per above.
- **Price risk.** The Guard proves you receive at least `minAmountOut`. It does
  not promise that was a good trade. The oracle cross-check is a sanity check
  against a time-weighted market price, and it is a *warning* — deliberately
  unable to refuse a transaction, because an oracle that can block swaps is an
  oracle worth attacking. A scheduled buy carries the same risk every time it
  runs. A vault's buy can be made as far below the pool's price as its
  allowance lets, by a keeper who sandwiches it.
- **Buys while spDEX is closed,** for a plan you confirm yourself. There is no
  server. Such a plan buys only while a spDEX tab is open and awake; a buy time
  that passes otherwise is skipped, not made up, and the plan ends later. A
  vault plan buys with no tab open, but only when somebody triggers it, and
  nobody promises to.
- **Unaudited contracts.** The auto-buy vault, its factory and the batcher have
  had no independent review. A bug in them could lose what a vault holds: at
  most 0.5 ETH put in per vault, with no limit on how many vaults one account
  creates.
- **Lost browser storage.** The plans themselves (the config) and their
  records live in this browser. Clear the site's data, close a private
  window, or open spDEX at a new origin, and they are gone from spDEX's reach.
  The plans are gone unless the config was exported; re-imported, they arrive
  paused and count from zero. Your activity's record of one-time swaps and
  tips goes too, and nothing on chain marks them as spDEX's, so it can't be
  rebuilt; download the CSV to keep it. A vault plan
  loses less: its money and its record are on chain, and its vault goes on
  buying. What is lost is the pointer to it. The app finds it again from the
  factory's `VaultCreated` logs when the owner's wallet connects, as far back
  as the endpoint lets it search, and from the factory's own list of vaults
  when that search stops short; an exported config gives it back regardless.
- **Partial execution of a split route.** A multi-leg route is several
  transactions, because spDEX's swaps go through no contract of its own, so
  there is nowhere to batch them atomically. Each leg is checked against its own minimum, so no leg can
  underpay — but a later leg can revert while earlier ones have executed. The
  app says so on any route with more than one leg.
- **Anonymity.** Your endpoint operator sees your address and your queries,
  the built-in service's publisher included. The disclaimer, the first-run
  screen and Settings → Network service say this. Private sending hides you
  from the *mempool*, not from your node. Some reads say less than they might: the currency rates
  are one request, the same whichever currency you chose, and Collective DCA's
  reads never name your address. But opening a `#receipt=` link tells your
  service which transaction you looked up, and finding your vaults from the
  factory's list is not a privacy measure: the service sees your address in
  every balance read anyway.

## Verifying the claims rather than believing them

The defences above are tests, not promises, and they run in the gate:

```bash
pnpm verify --strict
```

`redteam` runs what deliberately malicious modules, schedules, vault
transactions (a creation above the fee ceiling among them) and batches of
other people's vault buys would put in front of the Guard — each case one
change away from an honest plan — and the Guard must
refuse every one. It also runs a second opinion against every Guard the
Engine builds: a disagreement, a main service steering the heads, the block
or the time, a main service failing its own reads to dodge the comparison,
and a second service that goes quiet, where the verdict must
never be better than one service alone would give; and it fails when the
Engine builds a Guard class it doesn't know. `integration` runs the second
opinion against the fork through an in-test proxy that lies, lags or goes
quiet, and sends a real batch. `contracts` runs the forge
tests on a fork of mainnet at the pinned block: every refusal in "An auto-buy
vault" and "The batcher", the reviews' attacks (the sandwich, the one-block
push on the oracle pool, the keeper-trap vault, re-entering and fee-on-transfer
tokens, imitation markets, a re-entering batch, a return bomb, a vault that
burns its cap), and the measured gas the buy fee is priced from. It also
rebuilds the contracts from source and fails if the factory or batcher address
the app and keeper ship is not the one the source builds to. `conformance` runs
capability-escape attempts that must fail. `parity` runs the same fixture
modules through both runtimes and requires identical bytes, so for them the
native fast path is not a different code path.

The host's own defences are in `unit`, not `redteam`: plans arriving paused,
and autopilot plans arriving as paused wallet plans (`packages/config`); a buy
never started by the timer, and the claim before signing (the runner and the
record in `apps/web/src/lib/dca`); the fee itself
(`packages/vault/src/fee.ts`); what may turn money into a signed amount, and
how typing is read (`apps/web/src/lib/money/resolve.test.ts`,
`parse.adversarial.test.ts`); and
the partial check that every request goes to the network service in use
(the built-in one the disclaimer names, or one the person chose) or the relay
the person chose (`apps/web/src/no-requests.test.ts`).
So are the keeper's: what `assertKeeperMaySign` allows and refuses, the state
written before every broadcast, redaction over every record it produces, and
the keeper and the report never reaching the app (`boundaries.test.ts`), in
`packages/vault/src`. The keeper is also run against the fork in
`integration`, and its Docker image by `pnpm keeper:smoke`, which is not a
gate stage. A green `redteam` is the Guard's half of this document and a green
`unit` the host's; **never ship either red.**

Note that a *skip* is not a pass — stages needing Foundry or a browser skip
when those are missing, which is why `--strict` exists and why CI uses it.
