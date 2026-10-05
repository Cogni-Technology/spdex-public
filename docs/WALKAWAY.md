# Trust and exits

Nobody vouches for spDEX, and it asks you to trust nobody: here is how to
check it, and how to do without it.

This is the app's "Trust and exits" panel, written down so it outlives the
app. Everything here works with only your wallet, a block explorer or a copy
of the source. None of it needs spDEX, a server of spDEX's, or anyone's
permission.

## Verify this build

A page can't vouch for itself. Whatever served it could have changed what it
says, this sentence included, so the panel never says "verified". It says
where the page came from, and gives the commands that let you check a release
without trusting whoever served it.

- **From an IPFS path or subdomain** (`/ipfs/<CID>/…`, or `<CID>.ipfs.<gateway>`):
  the page was loaded from that CID, but a gateway could have sent other files
  under that address. To be sure, open the CID through your own IPFS node, or
  rebuild it and compare (the rebuild is offered only when the build says
  where its source is published).
- **From a path on a shared gateway,** also:

  > This copy is served under a path on a shared gateway, so it shares this
  > browser's storage (settings, records, notification permission) with every
  > other site on that gateway. Any of those sites can change your settings,
  > and an open spDEX tab takes them up as if you had. A subdomain gateway
  > (`<CID>.ipfs.<gateway>`) keeps them apart. Releases opened on the same gateway share settings: an
  > older release can't read newer settings and starts from the preset, so
  > don't change settings there.

- **From anywhere else** (a web server, a domain): a web server can change
  what it sends at any time. Open a release's CID through your own IPFS node
  or a gateway you trust, or rebuild it, when the build says where its source
  is.

Rebuilding a release and printing its CID:

```bash
git clone <where the source is published> spdex && cd spdex
git checkout <release tag>
pnpm install --frozen-lockfile
pnpm build:release            # with the release's published VITE_SPDEX_* values
pnpm ipfs:cid
```

The panel fills in the first line from the build setting
`VITE_SPDEX_SOURCE_URL`. A build without one says "This build doesn't say
where its source is published." rather than showing an address it wasn't
given. If the CID printed at the end matches the release's, that CID holds
exactly what this source builds. It doesn't make the source safe, and it
can't show that a tab is running those files: only opening the CID yourself
does. `docs/IPFS-RELEASE.md` has the details, including why the build is
reproducible.

## If spDEX disappeared

**The app.** It is a folder of static files. Save or pin a release; it runs
from any web server or IPFS gateway.

**A network service.** The built-in one works only at the web address a
release was published for, and only while its publisher keeps it running.
Anywhere else, use your own node or any Ethereum RPC provider (Settings →
Network service).

**Private sending** uses other people's relays (Flashbots Protect, MEV
Blocker). You can type any relay (Settings → Sending).

**Your vaults are contracts you own.** To stop one and take everything back,
call `close()` on it from the owner's wallet:

- on a block explorer that shows the vault's contract: Contract → Write (as
  Proxy) → `close`; or
- in any wallet that lets you add data: send 0 ETH to the vault with data
  `0x43d726d6` (that is `close()`).

The call is the same for a vault of either release, v1 or v2. spDEX never asks
you to do this. Do it only for a vault whose `owner()` is your address.

**Making a due buy yourself.** A v2 vault has one more call worth knowing:
`execute(owner)`, which makes a due buy and pays its fee back to the owner.
Its community window never refuses it, so it works the moment a buy falls
due, inside the community window or after it, whoever sends it. In any wallet
that lets you add data, send 0 ETH to the vault with data `0x4b64e492` (that
is `execute(address)`) followed by the owner's address left-padded with zeros
to 32 bytes: 24 zeros, then the address's 40 hex digits without its `0x`.

```
0x4b64e492000000000000000000000000<the owner's address, 40 hex digits, no 0x>
```

It buys only when a buy is due, which the vault's `status()` says (its first
answer, `due`); otherwise it reverts, and costs only the gas of a revert. What
it buys, how much and at what floor are the vault's terms, as for anyone's
call. A v1 vault's buy is still `execute()`, data `0x61461954`, and its fee
goes to whoever sends it.

The explorer route may not exist. v1's factory, the vault implementation every
v1 vault is a copy of, and v1's batcher have their source verified on Sourcify
and Etherscan, and v2's contracts are verified the same way when they are
deployed (`docs/RELEASE.md`). But a vault is an EIP-1167 clone with its terms
appended to its code, and whether an explorer recognises one as a copy of the
verified implementation, and offers Write as Proxy, hasn't been seen yet: when
v1's were verified, no vault existed to look at. The raw call always works:
`close()` sends everything the vault holds to its owner as ETH (as WETH to an
owner that can't take ether), and only the owner can call it. The panel lists
the vaults in this browser's settings, each in full, with a link to it on
Etherscan on Ethereum.

**Finding your vaults without spDEX.** Each factory lists every vault it has
made (`vaultCount()`, then `vaultsPage(offset, limit)`, at most 1,000 at a
time), and each vault's `owner()` says whose it is. There is one factory per
release, from `packages/vault/deployments.json`. v1's, on mainnet since block
26,100,366:

```
0xe4a1410a9Ee0833D41e7514306E65Ad729B7199E
```

v2's, the address this build deploys it to; it makes vaults once it is
deployed and `deployments.json` records its block:

```
0x164080E374F3A924245c3a99fBaDbd2C98ed48eB
```

The panel prints each in full, since a shortened address is useless without
spDEX to expand it.

In the app, **Find my vaults from the factories' lists** does exactly that
search for the connected wallet, on each listed factory: it reads every listed
vault's owner and compares them in the page, at one block, through
Multicall3. That is 2 + ⌈N/1000⌉ + ⌈N/200⌉ requests for a factory with N
listed vaults, and fewer once owners are cached, since an owner never
changes. It searches the newest 5,000 vaults at
most, and says how many it searched: the count is the network service's
answer, and a wrong one mustn't set off endless requests. An older vault
past that is found the way above, from any tool that reads the list. It is for network services that limit
log searches, where the auto-buy panel's own search stops short; the auto-buy
panel also runs it by itself when that happens. It isn't a privacy measure:
your service still sees your address, as it does for every balance read, and
who owns a vault is public on chain.

**Keeping your vaults buying.** Anyone can make a v1 vault's due buy. A v2
vault's buy is open to anyone once its community window has passed; inside
the window, an SPX holder's keeper can make it and be paid, or anyone can by
paying the fee back to you. Run a keeper (`docs/KEEPER.md`) with your own
address as its `rewardTo` to keep yours buying, or send `execute(owner)`
yourself (above).

**Your settings and records.** Export your settings (Settings → Settings file)
and your records (Your activity → Download CSV). This browser's storage can be
cleared, and your record of one-time swaps and tips exists nowhere else:
nothing on chain marks a swap as spDEX's.
