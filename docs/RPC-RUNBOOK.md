# RPC runbook

How the built-in network service is set up, and what to do when its key leaks
or runs out.

## The premise: the key is public

A key built into a static bundle ships to every visitor and can be read out of
the JavaScript in seconds; obfuscation doesn't change that. A proxy would, but
a proxy is a backend that sees every user's IP and queries (`AGENTS.md`, rule
5). So the design assumes the key will be extracted and caps what it can
cost. The settings below can bound the bill, keep other websites from using
the key in their visitors' browsers, and keep it off other chains and costly
services. They can't stop a script that sends its own `Origin`, limit any one
visitor (everyone, abuser included, shares one account's throughput and
month), or keep the site working once someone has drained the month.

## How the app uses it

- **Every visitor chooses.** After the disclaimer, the first-run screen
  recommends a free key of the visitor's own (Alchemy's sign-up walked
  through), then a free public service, and last, as a quiet link, the
  built-in service: only where a key is built in
  (`VITE_SPDEX_DEFAULT_RPC_URL`) and the page is at one of
  `VITE_SPDEX_CANONICAL_ORIGIN`'s origins, or anywhere if the build names none
  (`bundledRpcAvailable`, `apps/web/src/lib/store.ts`). On an IPFS gateway, a
  self-hosted copy or a fork the key wouldn't work, so it isn't offered.
  Nothing is sent to it until it is picked.
- **What is chosen stays chosen.** Settings' Change service shows the same
  screen, keeps the current service until another is chosen, and never brings
  the built-in one back on its own.
- **"Built-in" means this copy's key, never a saved one.** A browser that saved
  an older build's key uses this build's from its next load, so a rotation
  reaches returning visitors by itself. The swap is never saved
  (`builtInServiceInUse`): two tabs of different builds would otherwise
  overwrite each other's key without end. Exported settings and share links
  leave the built-in address out.
- **It never switches operator by itself.** When the built-in service fails,
  the app says so and offers the public service as a button. That is another
  operator, and it usually can't test-run (`eth_simulateV1`): without that the
  Guard falls back to static checks and shows **UNVERIFIED** in bold.
  Test-running every swap is what the built-in service buys.
- **The operator sees you.** The disclaimer, the first-run screen, Settings →
  Network service and the glossary all say that the service in use sees the
  person's IP address and queries.

## Alchemy setup

Checked against Alchemy's documentation on 2026-09-28; dashboard labels are
the documentation's (the dashboard itself wasn't opened). Points marked
*unverified* weren't confirmed either way.

### 1. A separate account

An Alchemy account used only for the shipped key: its own email, 2FA on.
Throughput, the monthly cap, alerts and request logs are per account, so
sharing one with `SPDEX_FORK_RPC_URL` (the archive endpoint that seeds the
local fork and the forge tests, kept in `.env.local`, never shipped) would let
a public abuser throttle the tests and put fork replays on the public budget.
(Whether one login can hold two teams is *unverified*; a second email always
works.)

### 2. Create the app

1. [dashboard.alchemy.com](https://dashboard.alchemy.com/) → team menu →
   **Team Overview** → **Apps** tab → **Create new app**.
2. **Name**: `spdex-release-<YYYY-MM>`. **Description**: "Shipped in the public
   bundle; public by construction; see docs/RPC-RUNBOOK.md".
3. **Chains**: **Ethereum Mainnet** only.
4. **Services**: **Node API** only. Leave NFT, Token, Transfers, Prices,
   Portfolio, Webhooks, Smart WebSockets, Wallet, Bundler, Gas Manager and
   Transaction Simulation off. `alchemy_simulateAssetChanges` costs 2,500
   compute units (CU) a call; spDEX never sends it, and an abuser shouldn't be
   able to. The app's test-run is `eth_simulateV1`, a 40-CU Node API method
   (step 5 checks that it answers).
5. **Create App**. The API key is at the top right of the app's page; the
   HTTPS URL, `https://eth-mainnet.g.alchemy.com/v2/<key>`, is on its
   **Endpoints** tab.

Where the chain and service toggles live after creation is *unverified*. The
Admin API (see Rotation) sets both exactly.

### 3. Security tab

Apps → the app → **Security**. Changes "may take a few minutes to propagate".

**Allowlist Domains: the canonical origins' hosts, exactly.**

- One entry per origin in `VITE_SPDEX_CANONICAL_ORIGIN` (e.g. `spdex.example`,
  and `spdex.eth.limo` if that origin is listed too). The two lists must
  match: an origin only the app lists is refused, and one only Alchemy lists
  is never used.
- Matching is exact: `spdex.example` does not cover `www.spdex.example`, and
  `*.spdex.example` covers every subdomain but not `spdex.example`. Serve one
  host and redirect the other. A Cloudflare IPFS gateway can only be a
  subdomain, so there it is `www`, with the bare domain redirecting.
- Once the list has an entry, a request with no `Origin` is refused. Browsers
  always send one on these requests (checked in Chromium).
- Never list `ipfs.io`, `dweb.link`, `*.ipfs.dweb.link`, `*.eth.limo`,
  `localhost` or a staging host: a gateway's origin lends the key to every
  site the gateway serves. Give staging its own app.
- Whether an entry's scheme or port is enforced is *unverified*.

This is abuse mitigation, not access control: a browser sets `Origin`
honestly, `curl` sets it to anything.

**Allowlist Addresses: leave it empty.** It is not a real control:

- It covers four methods only: `eth_call`, `eth_getCode`, `eth_getLogs`,
  `eth_getStorageAt`. Not `eth_simulateV1`, which runs any call against any
  contract, and not `eth_estimateGas`, `eth_getBalance` or
  `eth_sendRawTransaction`.
- Multicall3 has to be on it, and Multicall3 calls any contract for anyone.
- It breaks things the app reads directly: 24-hour volume (three SPX pools'
  logs), tip names (the ENS registry and any resolver), the check on a new tip
  address, the warning when your wallet forwards what it receives (a code read
  of your own address), a vault's history and the check that a creation went
  through (the new vault, which no list can name), and Help run the network,
  which hides itself when the batcher's code can't be read. Whether it touches
  `eth_getProof` is *unverified*.

If you add it anyway, list all of these and accept that those features
degrade:

```
0xca11bde05977b3631167028862be2a173976ca11  Multicall3
0x000000000022d473030f116ddee9f6b43ac78ba3  Permit2
0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c  SPX6900
0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2  WETH
0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48  USDC
0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45  SwapRouter02
0x7a250d5630b4cf539739df2c5dacb4c659f2488d  Uniswap v2 Router02
0xbf40f0fb41e5ee1194173545749d80c4651bac32  SpdexVaultFactory
0xd1f8327aa8398997bd88165f420412c703ebfed0  SpdexVaultBatcher
0x2c7f732a453fe0a4a65f36ac564ff16007b5610d  SpxHolderRegistry
0xe4a1410a9ee0833d41e7514306e65ad729b7199e  SpdexVaultFactory, earlier test deployment
0x52c77b0cb827afbad022e6d6caf2c44452edbc39  SPX pool (volume)
0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3  SPX pool (volume)
0x00ed26e794b949e18b142f9108429b74ce08ac99  SPX pool (volume)
0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e  ENS registry
0x201a4f5c79f5796df045e82b1057d074e8b85ec1  donation address (its code check)
```

The earlier test deployment's factory is listed because the app still searches
it for a person's vaults (`eth_getCode`, `eth_getLogs`). Anything read through
Multicall3 needs no entry (Chainlink's feeds, QuoterV2, the Uniswap v2 and v3
factories, Collective DCA). Whether the list judges only the top-level `to`,
and how it treats an address array in `eth_getLogs` or a call with no `to`, is
*unverified*: test with step 5 before relying on it. A new venue module's
contracts go here too.

**Allowlist IPs: leave it empty.** Visitors come from everywhere; any entry
refuses all of them.

**JWT: don't set it up.** A JWT has to be signed, short-lived, by a server
holding the private key, and spDEX has no server. A long-lived JWT baked into
the bundle is the key again, with an expiry.

### 4. Plan, cap and alerts

The monthly limit and the throughput are the account's, shared by every
visitor and anyone who extracts the key. No plan limits a visitor, and none
below Enterprise limits an app.

**While it's a community prototype: Free.**

- A hard stop at 30M CU a month, and a $0 bill whatever happens.
- 300 CU/s for everyone together, over a 10-second window: about four or five
  fresh page loads every ten seconds before Alchemy answers "busy" (it may
  allow more when it has capacity).
- `eth_getLogs` ranges of 10 blocks on Ethereum: 24-hour volume and vault
  history read a shorter window, and say so.
- No alerts, and an hour of request logs.

**For a public launch: Pay As You Go, with a Usage Limit.** (Alchemy's older
pages on "auto-scale" and prepaid limits describe a retired model.)

1. Upgrade the account: $0.525 per million CU, 10,000 CU/s.
2. **Billing Settings** (dashboard.alchemy.com/settings/billing) → **Usage
   Limit**, in dollars or CU. Start around $25–50 a month (about 48–95M CU).
   Usage stops at the limit. Raise it deliberately, never ahead of need.
3. dashboard.alchemy.com/settings/alerts → **Create new alert**, three times:
   - a **Usage Alert** at 50% of the Usage Limit;
   - a **Usage Alert** at 80%;
   - an **Error Rate** alert at about 5% over 10 minutes. Refused origins and
     "busy" answers count as errors ("success" is a 2xx with no error field),
     so this is the alert that says the key is used elsewhere, or that
     visitors are being turned away.
4. Weekly, while traffic is new: **Request Logs** (7 days on Pay As You Go),
   filtered by 4xx and by method. A jump in `eth_getLogs` or `eth_simulateV1`,
   or many requests refused for their origin, means the key is in use
   somewhere else.

### 5. Check it

A few minutes after saving. Load the URL without printing it:

```bash
read -rs U        # paste the endpoint URL, then Enter
O=https://spdex.example
body='{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
post() { curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$U" -H 'content-type: application/json' "$@"; }

post -H "Origin: $O" --data "$body"                          # expect 200
post --data "$body"                                           # expect 403 (Unspecified origin not on whitelist)
post -H 'Origin: https://evil.example' --data "$body"         # expect 403 (Origin not on whitelist.)

# The Guard's test-run, as the app sends it: expect a result array, not an error.
curl -sS -X POST "$U" -H 'content-type: application/json' -H "Origin: $O" --data '{"jsonrpc":"2.0","id":1,"method":"eth_simulateV1","params":[{"blockStateCalls":[{"stateOverrides":{"0x5d0e000000000000000000000000000000005d0e":{"balance":"0xde0b6b3a7640000"}},"calls":[{"from":"0x5d0e000000000000000000000000000000005d0e","to":"0x5d0e00000000000000000000000000000000beef","value":"0x1"}]}],"validation":false,"traceTransfers":true},"latest"]}'

# The browser's preflight: expect access-control-allow-origin: $O
curl -sS -i -X OPTIONS "$U" -H "Origin: $O" -H 'Access-Control-Request-Method: POST' | grep -i '^access-control'

# Prove my SPX's read: expect a "result" holding "accountProof", not an "error".
curl -sS -X POST "$U" -H 'content-type: application/json' -H "Origin: $O" --data '{"jsonrpc":"2.0","id":1,"method":"eth_getProof","params":["0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C",["0x2cd15052f745ae9a174ed167090c02aab286845a4a6c734be356630a513bcdd9"],"finalized"]}' | head -c 200; echo
```

If `eth_simulateV1` is refused, switch on Transaction Simulation and try
again (which service gates it is *unverified*; it is priced as a Node API
method). The same key against `https://base-mainnet.g.alchemy.com/v2/…` should
be refused by the chain setting; that a switched-off service refuses its
methods is *unverified*. The last check reads one holder's SPX balance slot
(the Uniswap v2 SPX/WETH pair's, only because its address is public); "Proving
SPX held: `eth_getProof`", below, says what a refusal means.

Alchemy documents these refusals as HTTP 403 with JSON-RPC code -32600.
Whether a 403 carries CORS headers is *unverified*; without them a browser
sees only "Failed to fetch".

## What a visit costs

Measured on the local fork at Alchemy's published prices, counting only the
app's own requests:

| | Requests | Compute units |
|---|---|---|
| First load, no wallet | 21 | about 626 |
| A minute idle, no price on screen | 0 | 0 (nothing polls) |
| One price (0.05 WETH → SPX) | 8 | about 202 |
| A price left on screen, estimated from the line above | up to 80: 10 refreshes over 5 minutes, only while the tab is visible | about 2,000 |
| A swap, estimated from the code | | about 130–200, plus 650–750 while Sent → Included → Final is watched (about 15 minutes) |

So a visit that looks and gets a price is about 830 CU, and one that swaps
about 1,700. On Free that is roughly 36,000 look-and-price visits or 17,000
swapping visits a month. A visit that leaves its price on screen for the whole
five minutes is about 2,800 CU, roughly 10,600 a month on Free. On Pay As You
Go, about $0.44 per 1,000 of the first and $0.90 per 1,000 of the second.

Abuse: a script at Free's 300 CU/s empties the month in about 28 hours; at Pay
As You Go's 10,000 CU/s it spends about $18.90 an hour, so a $50 Usage Limit
lasts about two and a half hours. Then the key is capped for everyone until
the month turns or the limit is raised.

## When the key is busy or capped

What people see (`apps/web/src/lib/errors.ts`, `packages/chain/src/reader.ts`):

- **Busy for a moment** (over the account's CU/s): where the browser can read
  the 429, the request is retried once after 1.2 seconds. Then the page says
  "The network service is busy" (the built-in service "is shared by everyone
  using this copy … Try again in a minute"), or, where the browser couldn't
  read the answer at all, "spDEX's built-in network service didn't answer. It
  may be busy …", and only then offers another service. Nothing sticks: the
  Markets tile says "unknown" (never "no markets found") and asks again a
  minute later, and the next price or swap asks afresh. The status panel says
  BUSY or OFFLINE only when its own read (on load, or ↻ Read now) meets the
  limit; it doesn't poll, so it can say ONLINE beside the message.
- **Capped for the month**: Alchemy answers HTTP 429 "Monthly capacity limit
  exceeded" (its documentation says 403) *without* CORS headers, so the browser
  sees "Failed to fetch" and the page shows the "didn't answer" message on
  every request. Raise the limit or rotate to a fresh app; a visitor can only
  choose another service.
- **Refused** where the page can read it (401, 403, a key not allowlisted for
  the origin, deleted, or out of its month): a notice, "The built-in network
  service isn't working here", with its answer, and two buttons: **Use a free
  public service** (which usually can't test-run) and **Choose a service**.

## Build-time wiring

```bash
VITE_SPDEX_DEFAULT_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/KEY
VITE_SPDEX_CANONICAL_ORIGIN=https://spdex.example            # or: https://spdex.example,https://spdex.eth.limo
VITE_SPDEX_PUBLIC_FALLBACK_RPC_URL=https://ethereum-rpc.publicnode.com
```

Write each canonical origin as the browser does (scheme, host and port, no
path, no trailing slash); commas or spaces separate several. A bare host
(`spdex.example`, as the Domains list writes it) is not an origin: `vite
build` refuses it, and the dev server warns that the built-in service is
offered nowhere. The values are read in one place (`RPC_BUILD`,
`apps/web/src/lib/store.ts`); `apps/web/vite.config.ts` layers the committed
`.env.defaults` under the environment and `.env.local`, which is how the
public fallback reaches every build.

**Never commit a key.** `.env.local` is gitignored; `.env.defaults` leaves it
empty on purpose. The key is part of the build, so it is part of the CID and
published with the release's other settings (`docs/IPFS-RELEASE.md`): every
rotation is a new CID.

## Rotation

On any suspicion, and at least yearly.

**The graceful way** (planned, or a suspected leak):

1. Create a new app with the same settings **before** using it: Ethereum
   Mainnet only, Node API only, the same Domains. A new key with default
   settings is an unrestricted key.
2. Update `VITE_SPDEX_DEFAULT_RPC_URL` and rebuild.
3. Publish the new build and update the DNSLink record
   (`docs/IPFS-RELEASE.md`). Returning visitors pick up the new key on their
   next load.
4. Leave the old app live for an hour or so (open tabs and cached copies still
   use it), then delete it.

The Admin API makes the app the same way every time. Create an access key at
dashboard.alchemy.com/settings/security with only App Management (read and
write), and keep it in a password manager, never in the repo. Each allowlist
`PUT` replaces the whole list. (Endpoints as Alchemy documents them; not run
from here.)

```bash
curl -X POST https://admin-api.alchemy.com/v1/apps \
  -H "Authorization: Bearer $ALCHEMY_ACCESS_KEY" -H 'content-type: application/json' \
  -d '{"name":"spdex-release-2026-10","description":"Public by construction","networkAllowlist":["ETH_MAINNET"],"products":["node-api"]}'
curl -X PUT https://admin-api.alchemy.com/v1/apps/$APP_ID/origin-allowlist \
  -H "Authorization: Bearer $ALCHEMY_ACCESS_KEY" -H 'content-type: application/json' \
  -d '{"originAllowlist":[{"name":"canonical","value":"spdex.example"}]}'
```

**The emergency way** (the key is being drained now): the app → **App
Settings** tab → **Rotate API key**, then confirm; it needs a team admin. The
settings and allowlists are kept, and the old key stops working within 2
minutes, which breaks every open tab and every older build at once: rebuild
and publish straight away. If the section is missing, rotation isn't enabled
for the team: use the graceful way and delete the old app.

## A second opinion is someone else's endpoint

Settings → Safety lets a person add a second network service, run by someone
else, that test-runs every transaction too; the Guard refuses what the two
disagree about. spDEX suggests no second service, this key included (naming
the main service again is refused). When this key is the main service, each
check costs it one more `eth_blockNumber` and `eth_getBlockByNumber`; the
second service gets those and one `eth_simulateV1`. Whenever money figures are
read (any ≈ figure, or an amount typed in money), the second service is asked
for the same rates, to compare.

## Proving SPX held: `eth_getProof`

**Why the app needs it.** A community keeper makes other people's vault buys
and is paid for each one; holding 690 SPX is the entry bar. Every 30 days the
address it is paid at proves, from Ethereum's own state, that it held 690 SPX
at the end of a recent block (`docs/THREAT-MODEL.md`, "The community window
and the SPX holder registry"). **Prove my SPX** and **Prove another address**
(Community keeping, at the foot of Help run the network) build the proof in
the browser from two reads through the person's own network service:

- `eth_getBlockByNumber("finalized", false)`: the block proven, about 13
  minutes old; the app rebuilds its header and refuses it unless it hashes to
  the block's hash;
- `eth_getProof(SPX, [key], <that block>)`, where `key` is
  `keccak256(abi.encode(holder, 1))`, the holder's slot in SPX's balances
  (`cast index address <holder> 1` prints it): a proof from the block's state
  root to SPX's account, and from there to the holder's balance.

Nothing else in the app uses `eth_getProof`, so a service that refuses it
breaks proving and nothing more. The wallet pays the proof's transaction
(about 0.00007 ETH at 0.1 gwei: `docs/ARCHITECTURE.md`, "The SPX holder
registry"). What the two reads cost in CU is *unverified*.

**Which services answer it**, asked for the `finalized` block (about 64
blocks behind the head) on 2026-10-03 with the commands below:

| Service | `eth_getProof` at `finalized` |
|---|---|
| Alchemy's Node API, the test account's archive key (`SPDEX_FORK_RPC_URL`) | Answers: an account proof of 9 nodes (3,759 bytes) and the storage proof |
| The public fallback, `ethereum-rpc.publicnode.com` | Refuses: "distance to target block exceeds maximum proof window". It answered for the head block alone |
| The built-in key | *unverified*: the same Node API as the test account's. Step 5's last check asks it |
| Your own node | An archive node answers for any block. A full node answers only for blocks whose state it still holds: geth keeps the last 128 (*unverified*), which covers `finalized`; reth answers only as far back as its `--rpc.eth-proof-window` allows, the head alone by default (*unverified*) |

So proving should work on the built-in service as it is, and on the public
fallback it doesn't: someone using the fallback needs another service for the
proof, or Paste a proof (below).

**Check one.** With Foundry, expect JSON with `accountProof` and
`storageProof`:

```bash
read -rs U        # paste the endpoint URL, then Enter
cast proof --rpc-url "$U" -B finalized 0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C \
  0x2cd15052f745ae9a174ed167090c02aab286845a4a6c734be356630a513bcdd9   # the SPX/WETH pair's balance slot; any holder's will do
```

With `curl` alone, use step 5's last check. A service with no Domains list
needs no `Origin`; the built-in key refuses every request without one (add
`--rpc-headers "Origin: $O"` to `cast`).

**When the person's service refuses it: Paste a proof.** The panel says so,
points here, and offers **Paste a proof**: the two requests above, written out
in full for one block (the `finalized` block as the person's own service
reports it), to run against any service with any tool, and a box for the
answers. The page never sends them itself (`AGENTS.md`, rule 4). Before
anything is sent it checks the pasted header's hash against the one the
person's own service reports for that block, and the proof against that
header's state root; it refuses answers that don't match, a block more than
8,191 back, and a holder that is a contract or holds under 690 SPX now. The proof then goes through the
Guard, and the registry checks it against the chain again. Run the requests
soon: a full node soon drops that block's state, and the registry accepts a
block only while it is among the last 8,191 (about 27 hours).
