# RPC runbook

How the built-in network service is set up, why it is set up that way, and
what to do when its key leaks or runs out.

## The premise: the key is public

spDEX is a static bundle. Anything built into it — including an API key — ships
to every visitor and can be read out of the JavaScript in about ten seconds.
There is no build trick that changes this. Obfuscation does not change it. A
proxy would change it, but a proxy is a backend that sees every user's IP and
queries, which is the thing spDEX exists not to have.

So the design does not try to keep the key secret. It assumes the key will be
extracted and limits what an extracted key can cost. The limit that matters
is money: a spend cap on the account. Nothing on Alchemy's side limits a
single visitor, so the cap bounds the bill, not the availability.

## How the app uses it

- **At the release's own address, nobody is asked.** Where a key is built in
  (`VITE_SPDEX_DEFAULT_RPC_URL`) and the page is at one of
  `VITE_SPDEX_CANONICAL_ORIGIN`'s origins, a first visitor reads the
  disclaimer, continues, and is on the page. The built-in service is set only
  then, so nothing is sent to it before. The disclaimer names it and says it
  sees your IP address; Settings → Network service shows it as "built-in", and
  Change service is one click away. (`autoBundledRpc` and
  `builtInServiceToSave` in `apps/web/src/lib/store.ts`; App.tsx.)
- **Everywhere else the app asks.** On an IPFS gateway, a self-hosted copy or
  a fork, the origin is different and the key doesn't work there, so the
  first-run screen offers the public service and "use my own". A build with a
  key and no canonical origin offers the key as a button instead of using it.
- **"Built-in" means this copy's key, never a saved one.** A browser that saved
  an older build's key reads with this build's from its next load, so a
  rotation reaches returning visitors without them doing anything. That swap
  is never saved (`builtInServiceInUse`): an old tab left open beside a new one
  would otherwise save its key over the other's, back and forth, without end.
  An exported settings file or share link leaves the built-in address out;
  whoever opens it keeps the network service they have.
- **It never switches operator by itself.** When the built-in service fails,
  the app says so and offers the public service as a button. The public one is
  another operator, and it usually can't test-run transactions.

## Alchemy setup

Everything below was checked against Alchemy's documentation on 2026-09-28.
Dashboard labels are the ones that documentation uses; the dashboard itself
wasn't opened. Points marked *unverified* weren't confirmed either way.

### 1. A separate account

Create a new Alchemy account used only for the shipped key: its own email, 2FA
on. Don't create the app in the account behind `SPDEX_FORK_RPC_URL`.
Throughput, the monthly cap, alerts and request logs are all per account now,
not per app, so on a shared account a public abuser throttles your fork and
forge runs, and your fork replays eat the public budget and blur its alerts.
(Whether one login can hold two teams is *unverified*; a second email always
works.)

### 2. Create the app

1. [dashboard.alchemy.com](https://dashboard.alchemy.com/) → team menu →
   **Team Overview** → **Apps** tab → **Create new app**.
2. **Name**: `spdex-release-<YYYY-MM>`. **Description**: "Shipped in the public
   bundle; public by construction; see docs/RPC-RUNBOOK.md".
3. **Chains**: **Ethereum Mainnet** only.
4. **Services**: **Node API** only. Leave everything else off: NFT, Token,
   Transfers, Prices, Portfolio, Webhooks, Smart WebSockets, Wallet, Bundler,
   Gas Manager and Transaction Simulation. `alchemy_simulateAssetChanges` costs
   2,500 compute units a call; spDEX never sends it, and an abuser shouldn't be
   able to. The app's own test-run is `eth_simulateV1`, a 40-CU Node API method
   (step 5 checks that it answers).
5. **Create App**. The API key is at the top right of the app's page; the
   HTTPS URL, `https://eth-mainnet.g.alchemy.com/v2/<key>`, is on its
   **Endpoints** tab.

Where the chain and service toggles live after creation, if you need to
change them, is *unverified*. The same app can be made by script with the
Admin API (see Rotation), which sets both exactly.

### 3. Security tab

Apps → the app → **Security**. Changes "may take a few minutes to propagate".

**Allowlist Domains: the canonical origins' hosts, exactly.**

- One entry per origin in `VITE_SPDEX_CANONICAL_ORIGIN`, e.g. `spdex.example`,
  plus `spdex.eth.limo` if the release is also served under its ENS name and
  that origin is in the list too. The two lists must match: an origin the app
  treats as canonical but Alchemy doesn't list gets refused, and one Alchemy
  lists but the app doesn't is never used.
- Matching is exact: `spdex.example` does not cover `www.spdex.example`, and
  `*.spdex.example` covers every subdomain but not `spdex.example` itself.
  Serve one host and redirect the other to it rather than listing both. A
  Cloudflare IPFS gateway can only be a subdomain, so there it is `www`,
  with the bare domain redirecting.
- A request with no `Origin` header is refused once the list has any entry.
  Browsers always send one on these requests (checked in Chromium).
- Never list `ipfs.io`, `dweb.link`, `*.ipfs.dweb.link`, `*.eth.limo`,
  `localhost` or a staging host. Gateway origins are shared by everything the
  gateway serves; a wildcard there lends the key to every site on it. Give
  staging its own app.
- Whether an entry's scheme or port is enforced is *unverified*.

This is abuse mitigation, not access control. `Origin` is a request header: a
browser sets it honestly, and `curl` sets it to anything with one flag. It
stops other web pages from using the key from their visitors' browsers, and
nothing more.

**Allowlist Addresses: leave it empty.** It was listed here once as "the real
control". It isn't:

- It covers four methods only: `eth_call`, `eth_getCode`, `eth_getLogs`,
  `eth_getStorageAt`. Not `eth_simulateV1`, which runs any call against any
  contract and returns its result, and not `eth_estimateGas`,
  `eth_getBalance` or `eth_sendRawTransaction`.
- Multicall3 has to be on it, and Multicall3 calls any contract for anyone.
- It breaks things the app does: the 24-hour volume (logs of three SPX pools),
  tip names (the ENS registry and whatever resolver a name uses), the check
  on a new tip address (the donation address included), the warning when your
  wallet forwards what it receives (a code read of your own address), a
  vault's history, the check that a vault creation went through (a code read
  of the new vault, which no list can name), and Help run the network, which
  hides itself when the batcher's code can't be read. Whether the list
  touches `eth_getProof`, which proving SPX held needs ("Proving SPX held",
  below), is *unverified*.

If you add it anyway, list all of these, and accept that the features above
degrade:

```
0xca11bde05977b3631167028862be2a173976ca11  Multicall3
0x000000000022d473030f116ddee9f6b43ac78ba3  Permit2
0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c  SPX6900
0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2  WETH
0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48  USDC
0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45  SwapRouter02
0x7a250d5630b4cf539739df2c5dacb4c659f2488d  Uniswap v2 Router02
0xe4a1410a9ee0833d41e7514306e65ad729b7199e  SpdexVaultFactory (v1)
0xc5ce65451dd5fc99d08eb18440b06f2bcca3c5a0  SpdexVaultBatcher (v1)
0x164080e374f3a924245c3a99fbadbd2c98ed48eb  SpdexVaultFactory (v2, once deployed)
0x5dff93903e3d2de06b8d729413500a938444bf1d  SpdexVaultBatcher (v2, once deployed)
0x2c7f732a453fe0a4a65f36ac564ff16007b5610d  SpxHolderRegistry (v2, once deployed)
0x52c77b0cb827afbad022e6d6caf2c44452edbc39  SPX pool (volume)
0x7c706586679af2ba6d1a9fc2da9c6af59883fdd3  SPX pool (volume)
0x00ed26e794b949e18b142f9108429b74ce08ac99  SPX pool (volume)
0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e  ENS registry
0x201a4f5c79f5796df045e82b1057d074e8b85ec1  donation address (its code check)
```

Everything read through Multicall3 needs no entry of its own (Chainlink's
feeds, QuoterV2, the v2 and v3 factories, Collective DCA's reads). Whether the
list judges only the top-level `to`, and how it treats an address array in
`eth_getLogs` or a call with no `to`, is *unverified*: test with the curl
checks below before relying on it. Adding a venue module means adding its
contracts here too.

**Allowlist IPs: leave it empty.** Visitors come from everywhere; any entry
refuses all of them.

**JWT: don't set it up.** A JWT has to be signed, short-lived, by a server
holding the private key, and spDEX has no server (AGENTS.md rule 5). A
long-lived JWT baked into the bundle is the key again, with an expiry.

### 4. Plan, cap and alerts

The monthly limit and the throughput are the account's, shared by every
visitor and by anyone who extracts the key. There is no per-visitor rate limit
on any plan, and no per-app limit below Enterprise (the old "rate limit" row
here described a setting that doesn't exist).

**While it's a community prototype: Free.**

- A hard stop at 30M compute units a month, and a $0 bill whatever happens.
- 300 CU/s for everyone together, measured over a 10-second window: about four
  or five fresh page loads every ten seconds before Alchemy answers "busy"
  (it may allow more when it has capacity).
- `eth_getLogs` ranges of 10 blocks on Ethereum: 24-hour volume and vault
  history read a shorter window, and say so.
- No alerts, and an hour of request logs.

**For a public launch: Pay As You Go, with a Usage Limit.**

1. Upgrade the account. $0.525 per million CU, 10,000 CU/s.
2. **Billing Settings** (dashboard.alchemy.com/settings/billing) → **Usage
   Limit**: set it in dollars or CU. Start around $25–50 a month (about 48–95M
   CU). Usage stops at the limit. Raise it deliberately, never ahead of need.
3. dashboard.alchemy.com/settings/alerts → **Create new alert**, three times:
   - a **Usage Alert** at 50% of the Usage Limit;
   - a **Usage Alert** at 80%;
   - an **Error Rate** alert at about 5% over 10 minutes. Refused origins and
     "busy" answers count as errors ("success" is a 2xx with no error field), so
     this is the one that tells you the key is being used elsewhere, or that
     visitors are being turned away.
4. Weekly, while traffic is new: **Request Logs** (7 days on PAYG), filtered by
   4xx and by method. A jump in `eth_getLogs` or `eth_simulateV1`, or many
   requests refused for their origin, means the key is in use somewhere else.

The older page on "auto-scale" and prepaid limits describes a retired model;
the Usage Limit above is the current one.

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

If `eth_simulateV1` is refused, switch on the Transaction Simulation service
and try again: which service gates it is *unverified* (it is priced as a
standard Node API method). The same key against
`https://base-mainnet.g.alchemy.com/v2/…` should be refused by the chain
setting; that a switched-off service refuses its methods is *unverified*.

The last check asks for SPX's balance slot of one holder (the Uniswap v2
SPX/WETH pair, chosen only because its address is public) at the `finalized`
block. "Proving SPX held: `eth_getProof`", below, says what a refusal means.

Alchemy's documentation lists these refusals as HTTP 403 with JSON-RPC code
-32600. Whether a 403 carries CORS headers is *unverified*: if it doesn't, a
browser sees only "Failed to fetch".

## What a visit costs

Measured on the local fork at Alchemy's published prices, counting only the
app's own requests:

| | Requests | Compute units |
|---|---|---|
| First load, no wallet | 21 | about 626 |
| A minute idle | 0 | 0 (nothing polls) |
| One price (0.05 WETH → SPX) | 8 | about 202 |
| A swap, estimated from the code | | about 130–200, plus 650–750 while Sent → Included → Final is watched (about 15 minutes) |

So a visit that looks and gets a price is about 830 CU, and one that swaps
about 1,700. On Free that is roughly 36,000 look-and-price visits or 17,000
swapping visits a month. On Pay As You Go, about $0.44 per 1,000 of the first
and $0.90 per 1,000 of the second.

And abuse: a script at Free's 300 CU/s empties the month in about 28 hours; at
Pay As You Go's 10,000 CU/s it spends about $18.90 an hour, so a $50 Usage
Limit lasts about two and a half hours of it. Then the key is capped for
everyone until the month turns or the limit is raised.

## What the settings can and can't do

They can:

- bound the bill (Free's cap, Pay As You Go's Usage Limit);
- stop other websites using the key from their visitors' browsers (Domains);
- stop its use on other chains (the app's chain setting), and on the costly
  data and simulation services (its services: *unverified* that a switched-off
  service refuses its methods);
- tell you when usage moves (alerts, Pay As You Go only).

They can't:

- stop anyone who reads the key out of the bundle and sends their own
  `Origin` from a script;
- limit any one visitor: everyone, abuser included, shares one account's
  throughput and one month's budget;
- keep the site working once someone has drained the month.

## When the key is busy or capped

What people see (`apps/web/src/lib/errors.ts`, `packages/chain/src/reader.ts`):

- **Busy for a moment** (over the account's CU/s): the request is sent once
  more after 1.2 seconds, where the browser can read the 429. If that fails
  too, the page says "The network service is busy: spDEX's built-in network
  service is shared by everyone using this copy, and it's turning requests
  away for now. Try again in a minute …". Where the browser couldn't read the
  answer at all, it says "spDEX's built-in network service didn't answer. It
  may be busy …: try again in a minute", and only after that offers choosing
  another service. The status panel says BUSY or OFFLINE only when its own
  read (on load, or ↻ Read now) meets the limit; it doesn't poll, so a limit
  that starts after the page loaded can leave it saying ONLINE beside the
  message. Nothing sticks: the Markets tile says "unknown" (never "no markets
  found") and asks again a minute later, the next price asks the markets
  again, and the next swap asks again whether the service can test-run.
- **Capped for the month**: Alchemy answers HTTP 429 "Monthly capacity limit
  exceeded" (its documentation says 403) *without* CORS headers, so a browser
  sees only "Failed to fetch": the same "didn't answer, may be busy" message,
  on every request, until the month turns or the limit is raised. Raise the
  limit or rotate to a fresh app; there is nothing a visitor can do but choose
  another service.
- **Refused** where the page can read the refusal (401, 403, a key not
  allowlisted for the origin, deleted, or out of its month): a notice, "The
  built-in network service isn't working here", with its answer, and two
  buttons: **Use a free public service** (the public fallback, which usually
  can't safety-check) and **Choose a service**. It never switches by itself.

## Build-time wiring

```bash
VITE_SPDEX_DEFAULT_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/KEY
VITE_SPDEX_CANONICAL_ORIGIN=https://spdex.example            # or: https://spdex.example,https://spdex.eth.limo
VITE_SPDEX_PUBLIC_FALLBACK_RPC_URL=https://ethereum-rpc.publicnode.com
```

Each canonical origin is compared as the browser writes an origin (scheme,
host and port, no path, no trailing slash); commas or spaces separate several.
Write the scheme: a bare host (`spdex.example`, as the Domains list writes it)
is not an origin, and the app then uses and offers the built-in service
nowhere. `vite build` refuses such a value, and the dev server warns.
The values are read in one place (`RPC_BUILD` in
`apps/web/src/lib/store.ts`). `apps/web/vite.config.ts` puts the committed
`.env.defaults` values under the environment and `.env.local`, which is how the
public fallback reaches every build.

**Never commit a key.** `.env.local` is gitignored; `.env.defaults` ships with
the value empty on purpose. The key is part of the build, so it is part of the
CID and is published with the release's other settings
(`docs/IPFS-RELEASE.md`): every rotation is a new CID.

## Rotation

Do this on any suspicion, and at least yearly regardless.

**The graceful way** (planned, or a suspected leak):

1. Create a new app with the same settings **before** using it: Ethereum
   Mainnet only, Node API only, the same Domains. A new key with default
   settings is an unrestricted key.
2. Update `VITE_SPDEX_DEFAULT_RPC_URL` and rebuild.
3. Publish the new build and update the DNSLink record (see
   `docs/IPFS-RELEASE.md`). Returning visitors pick up the new key on their
   next load: the app reads a saved built-in key as its own.
4. Leave the old app live for an hour or so — open tabs and cached copies keep
   using it — then delete it.

The app can be made the same way every time with the Admin API. Create an
access key at dashboard.alchemy.com/settings/security with only App
Management (read and write), and keep it in a password manager, never in the
repo or the vault. Each allowlist `PUT` replaces the whole list. (Endpoints as
Alchemy documents them; not run from here.)

```bash
curl -X POST https://admin-api.alchemy.com/v1/apps \
  -H "Authorization: Bearer $ALCHEMY_ACCESS_KEY" -H 'content-type: application/json' \
  -d '{"name":"spdex-release-2026-10","description":"Public by construction","networkAllowlist":["ETH_MAINNET"],"products":["node-api"]}'
curl -X PUT https://admin-api.alchemy.com/v1/apps/$APP_ID/origin-allowlist \
  -H "Authorization: Bearer $ALCHEMY_ACCESS_KEY" -H 'content-type: application/json' \
  -d '{"originAllowlist":[{"name":"canonical","value":"spdex.example"}]}'
```

**The emergency way** (the key is being drained now): the app → **App
Settings** tab → **Rotate API key**, then confirm. It needs a team admin. The
app's settings and allowlists are kept, and the old key stops working within
2 minutes, which breaks every open tab and every older build at once, so
rebuild and publish straight away. (If the section is missing, rotation isn't
enabled for the team yet: use the graceful way and delete the old app.)

## Where the app still asks

On an IPFS gateway, a self-hosted copy or a fork, first-run asks, and offers
the public service. That is the honest version of the sovereignty claim:
self-hosting means self-sourcing, and a key that failed with a confusing error
on every copy but one would be worse for everyone. The same screen comes back
from Settings' Change service, with the service in use kept until another is
chosen and a button that goes back to it. What is chosen there stays chosen:
the built-in service doesn't return on its own once someone has changed it.

Whichever service is in use, the app says plainly that its operator sees the
person's IP address and their queries: the disclaimer, the first-run screen,
Settings → Network service and the word's own definition all say it.

## A second opinion is someone else's endpoint

Settings → Safety lets a person add a second network service, run by someone
else, that test-runs every transaction too; the Guard compares the two and
refuses what they disagree about. spDEX suggests no second service, this key
included (at the release's address it is the main service, and the same
service twice is ignored), and nothing about this key changes when someone
sets one. Each check then costs this key one more `eth_blockNumber` and one
`eth_getBlockByNumber`, both of which it answers already; the second
service gets those and one `eth_simulateV1`. Whenever money figures are
read (any ≈ figure on screen, or an amount typed in money), the second
service is asked for the same rates as this key, dollars and currencies both,
to compare them.

## Simulation is what the built-in service buys

The Guard's strongest check needs `eth_simulateV1`. Many free public endpoints
do not implement it, and when it is unavailable the Guard degrades to static
checks and the UI shows **UNVERIFIED** in bold.

That is the concrete user-visible benefit of the built-in service: at the
release's own address, swaps are test-run and checked before signing; on the
public fallback, they may not be. Alchemy documents it on the Ethereum
endpoint on every plan (*unverified* against a live key: step 5's curl checks
it).

## Proving SPX held: `eth_getProof`

**Why the app needs it.** A community keeper makes other people's v2 vault
buys and is paid for each one; holding 690 SPX is the entry bar. Once every 30
days the address it is paid at proves, from Ethereum's own state, that it held
690 SPX at the end of a recent block (`docs/THREAT-MODEL.md`, "The community
window and the SPX holder registry"). **Prove my SPX** and **Prove another
address**, in **Community keeping** at the foot of Help run the network,
build that proof in the browser from two reads through the person's own
network service:

- `eth_getBlockByNumber("finalized", false)`: the block proven, about 13
  minutes old, whose header the app rebuilds and refuses to use unless it
  hashes to the block's hash;
- `eth_getProof(SPX, [key], <that block>)`, where `key` is
  `keccak256(abi.encode(holder, 1))`, the holder's slot in SPX's balances
  (`cast index address <holder> 1` prints it): a proof from the block's state
  root to SPX's account, and from there to the holder's balance.

Nothing else in the app uses `eth_getProof`, so a service that refuses it
breaks proving and nothing more. The proof's transaction is a separate cost,
paid by the wallet: about 655,000 to 685,000 gas (`test/forge/Registry.t.sol`
measures the call; the rest is its 8 KB of calldata and the 21,000 every
transaction pays), about 0.00007 ETH at 0.1 gwei. What the two requests cost
in compute units is *unverified*.

**Which services answer it.** Asked for the `finalized` block, about 64
blocks behind the head, on 2026-10-03 with the commands below:

| Service | `eth_getProof` at `finalized` |
|---|---|
| Alchemy's Node API, the test account's archive key (`SPDEX_FORK_RPC_URL`) | Answers: an account proof of 9 nodes (3,759 bytes) and the storage proof |
| The public fallback, `ethereum-rpc.publicnode.com` | Refuses: "distance to target block exceeds maximum proof window". It answered for the head block alone |
| The built-in key | *unverified*: the same Node API as the test account's. Step 5's last check asks it |
| Your own node | An archive node answers for any block. A full node answers only for blocks whose state it still holds: geth keeps the last 128 (*unverified*), which covers `finalized`; reth answers only as far back as its `--rpc.eth-proof-window` allows, the head alone by default (*unverified*) |

So at the release's own address proving should work as it is, and on the
public fallback it doesn't: someone using the fallback needs another service
for the proof, or the paste-a-proof path below.

**Check one.** Either command; `U` is the endpoint, read without printing it:

```bash
read -rs U        # paste the endpoint URL, then Enter
SPX=0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C
KEY=0x2cd15052f745ae9a174ed167090c02aab286845a4a6c734be356630a513bcdd9   # the SPX/WETH pair's balance slot; any address's will do

# With Foundry: expect JSON with "accountProof" and "storageProof".
cast proof --rpc-url "$U" -B finalized $SPX $KEY

# With curl alone: expect a "result", not an "error".
curl -sS -X POST "$U" -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getProof\",\"params\":[\"$SPX\",[\"$KEY\"],\"finalized\"]}" | head -c 200; echo
```

For the built-in key, send the origin its Domains list expects, as step 5
does: `-H "Origin: $O"` on the curl, `--rpc-headers "Origin: $O"` on the
`cast`. Without one the key refuses the request, whatever the method.

**When the person's service refuses it: Paste a proof.** The panel says the
service doesn't answer `eth_getProof`, points here, and offers **Paste a
proof**. It shows the two requests above, written out in full for one block
it names (the `finalized` block as the person's own service reports it), to
run against any service that answers them, with `curl`, `cast` or any other
tool, and a box for the answers. Before anything is sent, the app rebuilds the
header from the pasted block, hashes it, and compares that hash with the one
the person's own service reports for that block number, and checks the
proof against that header's state root; answers that don't match are
refused, and so is a holder that is a contract or holds under 690 SPX now,
whom no proof could make a community keeper. The page never fetches from the other service itself (rule
4 in `AGENTS.md`): the person runs the requests, wherever they choose. The
proof then goes through the Guard like any proof, and the registry checks it
against the chain once more. Run the requests soon after the panel shows them:
a full node soon stops holding that block's state, and the registry accepts a
block only while it is among the last 8,191, about 27 hours.

## The test key is a different account

`SPDEX_FORK_RPC_URL` seeds the local fork and must be an **archive** endpoint.
It never ships, has nothing to do with the production key, and belongs in
`.env.local`. It must live in a different Alchemy *account* from the shipped
key, not just a different app: throughput, the monthly cap and alerts are the
account's, so sharing one would put fork-replay traffic on the public budget
and let public abuse throttle the tests.
