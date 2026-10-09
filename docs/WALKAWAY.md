# Trust and exits

Nobody vouches for spDEX, and it asks you to trust nobody. This is the app's
"Trust and exits" panel (Settings → Check this build), written down so it
outlives the app: how to check a copy of spDEX, and how to do without it.
Everything here needs only your wallet, a block explorer or a copy of the
source: no server of spDEX's, and nobody's permission.

## Verify this build

A page can't vouch for itself: whatever served it could have changed what it
says, this sentence included. So the panel never says "verified". It says
where the page came from, and gives the commands that check a release without
trusting whoever served it.

- **From an IPFS path or subdomain** (`/ipfs/<CID>/…`, or
  `<CID>.ipfs.<gateway>`): the page was loaded from that CID, but a gateway
  could have sent other files under that address. To be sure, open the CID
  through your own IPFS node, or rebuild it and compare.
- **From a path on a shared gateway,** the panel adds:

  > This copy is served under a path on a shared gateway, so it shares this
  > browser's storage (settings, records, notification permission) with every
  > other site on that gateway. Any of those sites can change your settings,
  > and an open spDEX tab takes them up as if you had. A subdomain gateway
  > (`<CID>.ipfs.<gateway>`) keeps them apart. Releases opened on the same
  > gateway share settings: an older release can't read newer settings and
  > starts from the preset, so don't change settings there.

- **From anywhere else** (a web server, a domain): a web server can change
  what it sends at any time. Open a release's CID through your own IPFS node
  or a gateway you trust, or rebuild it.

Rebuilding a release and printing its CID:

```bash
git clone <where the source is published> spdex && cd spdex
git checkout <release tag>
pnpm install --frozen-lockfile
pnpm build:release    # with the VITE_SPDEX_* values the release published
pnpm ipfs:cid
```

The panel fills in the first line from the build setting
`VITE_SPDEX_SOURCE_URL`, and offers the rebuild only when it is set; without
it, the panel says "This build doesn't say where its source is published."
Build with the `VITE_SPDEX_*` settings the release published: they are part
of what is built, so without them the CID won't match. If the CID printed at
the end matches the release's, that CID holds exactly what this source builds
with those settings. It doesn't make the source safe, and it can't show that a
tab is running those files: only opening the CID yourself does.
`docs/IPFS-RELEASE.md` has the details, including why the build is
reproducible.

## If spDEX disappeared

**The app** is a folder of static files. Save or pin a release, and serve it
from any web server or IPFS gateway.

**A network service.** The built-in one works only where its publisher hosts
it, and only while they keep it running. Elsewhere, use any Ethereum RPC or
your own node (Settings → Network service).

**Private sending** uses other people's relays (Flashbots Protect, MEV
Blocker). Any relay works (Settings → Sending).

**Your vaults are contracts you own.** To stop one and take everything back,
call `close()` from its owner's wallet:

- on a block explorer that shows the vault's contract: Contract → Write (as
  Proxy) → `close`; or
- in any wallet that lets you add data: send 0 ETH to the vault with data
  `0x43d726d6` (that is `close()`).

`close()` sends everything the vault holds to its owner as ETH (as WETH to an
owner that can't take ether), and only the owner can call it. spDEX never asks
you to do this. Do it only for a vault whose `owner()` is your address. The
panel lists the vaults in this browser's settings, each in full, with a link
to it on Etherscan on Ethereum.

The source of the factory, of the vault implementation every vault is a copy
of, of the batcher and of the SPX holder registry is verified on Sourcify and
Etherscan. A vault is an EIP-1167 clone with its terms appended to its code.
An explorer that doesn't recognise it as a proxy of the verified
implementation won't offer Write as Proxy; the raw call always works.

**Making a due buy yourself.** `execute(owner)` makes a due buy and pays its
fee back to the owner. The community window never refuses it, so it works the
moment a buy falls due, whoever sends it. In any wallet that lets you add
data, send 0 ETH to the vault with data `0x4b64e492` (that is
`execute(address)`) followed by the owner's address left-padded with zeros to
32 bytes: 24 zeros, then the address's 40 hex digits without its `0x`.

```
0x4b64e492000000000000000000000000<the owner's address, 40 hex digits, no 0x>
```

It buys only when a buy is due, which the vault's `status()` says (its first
answer, `due`); otherwise it reverts, and costs only the gas of a revert. What
it buys, how much and at what floor are the vault's terms, whoever calls it.

**Finding your vaults without spDEX.** The factory lists every vault it has
made (`vaultCount()`, then `vaultsPage(offset, limit)`, at most 1,000 at a
time), and each vault's `owner()` says whose it is. The factory, on Ethereum
since block 26,134,916:

```
0xBF40f0Fb41E5EE1194173545749D80C4651bAc32
```

The panel prints factory addresses in full, since a shortened address is
useless without spDEX to expand it.

**Find my vaults from the factories' lists**, in the panel, does that search
for the connected wallet: it reads every listed vault's owner and compares
them in the page, at one block, through Multicall3. That is a few requests
plus one for every 200 listed vaults, and fewer once owners are cached, since
an owner never changes. It searches the newest 5,000 vaults at most, and says
how many it searched: the count is the network service's answer, and a wrong
one mustn't set off endless requests. An older vault is found as above, from
any tool that reads the list. The search is for network services that limit
log searches, where the auto-buy panel's own search stops short; that panel
also runs it by itself when that happens. It isn't a privacy measure: your
service still sees your address, as it does for every balance read, and who
owns a vault is public on chain.

**Keeping your vaults buying.** Once a buy's community window has passed,
anyone can make it. Inside the window, an SPX holder's keeper can make it and
be paid, or anyone can by paying the fee back to you. Run a keeper
(`docs/KEEPER.md`) with your own address as its `rewardTo` to keep yours
buying, or send `execute(owner)` yourself (above).

**Your settings and records.** Export your settings (Settings → Settings
file, in the Expert view) and your records (Your SPX → Download CSV). This
browser's storage can be cleared, and your record of one-time swaps and tips
exists nowhere else: nothing on chain marks a swap as spDEX's.
